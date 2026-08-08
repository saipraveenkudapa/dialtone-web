-- Row Level Security.
--
-- Two principals reach this database:
--
--   authenticated  — a signed-in owner or manager. Sees only rows for
--                    organizations they are a member of. Nothing else,
--                    ever.
--   agent_service  — the Python voice agent. Reads the menu, hours and
--                    location config it needs to answer a call, and
--                    writes calls, orders and bookings. It cannot read a
--                    transcript back, cannot touch billing, and cannot
--                    edit a menu. It is NOT the service_role key: that
--                    key bypasses RLS entirely and must stay in the web
--                    app's server-side code.

-- ── helpers ──────────────────────────────────────────────────────────

-- SECURITY DEFINER so the membership lookup itself is not subject to the
-- policies below — otherwise every policy would recurse.
create or replace function app.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from memberships m
    where m.org_id = org and m.user_id = auth.uid()
  );
$$;

create or replace function app.is_org_owner(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from memberships m
    where m.org_id = org and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

create or replace function app.can_access_location(loc uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1 from locations l
    where l.id = loc and app.is_org_member(l.org_id)
  );
$$;

revoke all on function app.is_org_member(uuid) from public;
revoke all on function app.is_org_owner(uuid) from public;
revoke all on function app.can_access_location(uuid) from public;
grant execute on function app.is_org_member(uuid) to authenticated;
grant execute on function app.is_org_owner(uuid) to authenticated;
grant execute on function app.can_access_location(uuid) to authenticated;

-- ── the agent's database role ────────────────────────────────────────

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'agent_service') then
    create role agent_service nologin noinherit;
  end if;
end;
$$;

-- PostgREST switches into this role when a JWT carries "role":
-- "agent_service". Mint that token for the Python service; never hand it
-- the service_role key.
grant agent_service to authenticator;
grant usage on schema public to agent_service;

-- The agent is one shared process serving every restaurant, so the role
-- alone is not a tenant boundary. Each call gets its own short-lived
-- token carrying the location it is answering for, and every agent policy
-- below is scoped to that claim. A token minted for one restaurant can
-- neither read another's menu nor write a call against it.
--
-- Flow: inbound webhook reads the dialled number -> looks the location up
-- (the one unscoped read, config only, no customer data) -> mints a token
-- with {"role":"agent_service","location_id":"<uuid>"} for the rest of
-- the call.
create or replace function app.agent_location()
returns uuid
language sql
stable
as $$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'location_id',
    ''
  )::uuid;
$$;

grant execute on function app.agent_location() to agent_service;

-- ── enable RLS everywhere ────────────────────────────────────────────

alter table organizations       enable row level security;
alter table memberships         enable row level security;
alter table locations           enable row level security;
alter table hours               enable row level security;
alter table holiday_hours       enable row level security;
alter table menu_categories     enable row level security;
alter table menu_items          enable row level security;
alter table menu_modifier_groups enable row level security;
alter table menu_modifiers      enable row level security;
alter table menu_imports        enable row level security;
alter table calls               enable row level security;
alter table call_events         enable row level security;
alter table call_turn_metrics   enable row level security;
alter table orders              enable row level security;
alter table order_items         enable row level security;
alter table order_status_events enable row level security;
alter table bookings            enable row level security;

-- No table is readable without a policy, so the default is deny.

-- ── organizations and membership ─────────────────────────────────────

create policy org_read on organizations
  for select to authenticated
  using (app.is_org_member(id));

-- Billing and plan changes are the owner's, not a floor manager's.
create policy org_write on organizations
  for update to authenticated
  using (app.is_org_owner(id))
  with check (app.is_org_owner(id));

create policy membership_read_own on memberships
  for select to authenticated
  using (user_id = auth.uid() or app.is_org_member(org_id));

create policy membership_manage on memberships
  for all to authenticated
  using (app.is_org_owner(org_id))
  with check (app.is_org_owner(org_id));

-- ── locations ────────────────────────────────────────────────────────

create policy location_read on locations
  for select to authenticated
  using (app.is_org_member(org_id));

create policy location_write on locations
  for all to authenticated
  using (app.is_org_member(org_id))
  with check (app.is_org_member(org_id));

-- The agent looks a location up by the number that was dialled, then
-- reads its greeting, timezone, kill switch and fallback number.
-- The only unscoped agent read: matching the dialled number to a
-- location before the per-call token exists. Config rows only.
create policy location_read_agent on locations
  for select to agent_service
  using (true);

grant select on locations to agent_service;

-- ── hours ────────────────────────────────────────────────────────────

create policy hours_rw on hours
  for all to authenticated
  using (app.can_access_location(location_id))
  with check (app.can_access_location(location_id));

create policy hours_read_agent on hours
  for select to agent_service
  using (location_id = app.agent_location());

create policy holiday_hours_rw on holiday_hours
  for all to authenticated
  using (app.can_access_location(location_id))
  with check (app.can_access_location(location_id));

create policy holiday_hours_read_agent on holiday_hours
  for select to agent_service
  using (location_id = app.agent_location());

grant select on hours, holiday_hours to agent_service;

-- ── menu ─────────────────────────────────────────────────────────────

create policy menu_categories_rw on menu_categories
  for all to authenticated
  using (app.can_access_location(location_id))
  with check (app.can_access_location(location_id));

create policy menu_items_rw on menu_items
  for all to authenticated
  using (app.can_access_location(location_id))
  with check (app.can_access_location(location_id));

create policy modifier_groups_rw on menu_modifier_groups
  for all to authenticated
  using (exists (
    select 1 from menu_items i
    where i.id = item_id and app.can_access_location(i.location_id)
  ))
  with check (exists (
    select 1 from menu_items i
    where i.id = item_id and app.can_access_location(i.location_id)
  ));

create policy modifiers_rw on menu_modifiers
  for all to authenticated
  using (exists (
    select 1 from menu_modifier_groups g
    join menu_items i on i.id = g.item_id
    where g.id = group_id and app.can_access_location(i.location_id)
  ))
  with check (exists (
    select 1 from menu_modifier_groups g
    join menu_items i on i.id = g.item_id
    where g.id = group_id and app.can_access_location(i.location_id)
  ));

-- The agent reads the menu fresh on every call and may only quote what
-- comes back. It has SELECT and nothing more: a bot must never be able to
-- edit the menu it is reading from.
create policy menu_categories_read_agent on menu_categories
  for select to agent_service
  using (location_id = app.agent_location());

create policy menu_items_read_agent on menu_items
  for select to agent_service
  using (location_id = app.agent_location());

create policy modifier_groups_read_agent on menu_modifier_groups
  for select to agent_service
  using (exists (
    select 1 from menu_items i
    where i.id = item_id and i.location_id = app.agent_location()
  ));

create policy modifiers_read_agent on menu_modifiers
  for select to agent_service
  using (exists (
    select 1 from menu_modifier_groups g
    join menu_items i on i.id = g.item_id
    where g.id = group_id and i.location_id = app.agent_location()
  ));

grant select on menu_categories, menu_items, menu_modifier_groups, menu_modifiers
  to agent_service;

-- Imports stay staff-only. The agent has no business reading a menu that
-- nobody has confirmed yet.
create policy menu_imports_rw on menu_imports
  for all to authenticated
  using (app.can_access_location(location_id))
  with check (app.can_access_location(location_id));

-- ── calls ────────────────────────────────────────────────────────────

create policy calls_read on calls
  for select to authenticated
  using (app.can_access_location(location_id));

-- Staff annotate and tag; they do not fabricate call records.
create policy calls_update on calls
  for update to authenticated
  using (app.can_access_location(location_id))
  with check (app.can_access_location(location_id));

-- The agent writes the call row and keeps it current as Twilio's webhooks
-- arrive. No SELECT: it never needs to read a transcript back, so a
-- compromised agent token cannot exfiltrate call history.
create policy calls_insert_agent on calls
  for insert to agent_service
  with check (location_id = app.agent_location());

create policy calls_update_agent on calls
  for update to agent_service
  using (location_id = app.agent_location())
  with check (location_id = app.agent_location());

grant insert, update on calls to agent_service;

create policy call_events_read on call_events
  for select to authenticated
  using (exists (
    select 1 from calls c
    where c.id = call_id and app.can_access_location(c.location_id)
  ));

create policy call_events_insert_agent on call_events
  for insert to agent_service
  with check (exists (
    select 1 from calls c
    where c.id = call_id and c.location_id = app.agent_location()
  ));

create policy turn_metrics_read on call_turn_metrics
  for select to authenticated
  using (exists (
    select 1 from calls c
    where c.id = call_id and app.can_access_location(c.location_id)
  ));

create policy turn_metrics_insert_agent on call_turn_metrics
  for insert to agent_service
  with check (exists (
    select 1 from calls c
    where c.id = call_id and c.location_id = app.agent_location()
  ));

grant insert on call_events, call_turn_metrics to agent_service;

-- ── orders and bookings ──────────────────────────────────────────────

create policy orders_rw on orders
  for all to authenticated
  using (app.can_access_location(location_id))
  with check (app.can_access_location(location_id));

create policy orders_insert_agent on orders
  for insert to agent_service
  with check (location_id = app.agent_location());

create policy order_items_rw on order_items
  for all to authenticated
  using (exists (
    select 1 from orders o
    where o.id = order_id and app.can_access_location(o.location_id)
  ))
  with check (exists (
    select 1 from orders o
    where o.id = order_id and app.can_access_location(o.location_id)
  ));

create policy order_items_insert_agent on order_items
  for insert to agent_service
  with check (exists (
    select 1 from orders o
    where o.id = order_id and o.location_id = app.agent_location()
  ));

create policy order_status_events_read on order_status_events
  for select to authenticated
  using (exists (
    select 1 from orders o
    where o.id = order_id and app.can_access_location(o.location_id)
  ));

create policy bookings_rw on bookings
  for all to authenticated
  using (app.can_access_location(location_id))
  with check (app.can_access_location(location_id));

create policy bookings_insert_agent on bookings
  for insert to agent_service
  with check (location_id = app.agent_location());

grant insert on orders, order_items, bookings to agent_service;
-- The status trigger writes here on the agent's behalf.
grant insert on order_status_events to agent_service;
grant usage, select on all sequences in schema public to agent_service;

-- Supabase's bootstrap already grants these to anon/authenticated for new
-- tables; stated explicitly so a plain Postgres restore of these
-- migrations behaves the same. RLS, not grants, is what isolates tenants.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
