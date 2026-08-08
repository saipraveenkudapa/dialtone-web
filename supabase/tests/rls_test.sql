-- RLS policy tests.
--
-- These are the tests that matter most in this product: a restaurant must
-- never see another restaurant's calls, and the voice agent must never be
-- able to read or write outside the one location it was minted for.
--
-- Deliberately not pgTAP. pgTAP lives in the `extensions` schema, which
-- `authenticated` has no USAGE on — and granting it just to run a test
-- would widen the surface the test exists to protect. Plain SQL asserts
-- into a temp table instead, and the final SELECT is the report.
--
-- Run with:  psql "$DATABASE_URL" -f supabase/tests/rls_test.sql
-- Every row of the output must read PASS. The whole thing rolls back.

begin;

create temp table results (name text, got text, want text);
grant all on results to public;

-- ── fixtures: two unrelated restaurants ──────────────────────────────

insert into auth.users (id, email, instance_id, aud, role)
values
  ('11111111-1111-1111-1111-111111111111', 'owner-a@example.com', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'owner-b@example.com', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

insert into organizations (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Rosa Group'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Rival Group');

insert into memberships (user_id, org_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000002', 'owner');

insert into locations (id, org_id, name, twilio_number) values
  ('a10c0000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'Nonna Rosa', '+15105550142'),
  ('b10c0000-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000002', 'Rival Pizza', '+15105550199');

insert into menu_categories (id, location_id, name) values
  ('ca100000-0000-0000-0000-0000000000ca', 'a10c0000-0000-0000-0000-00000000000a', 'Pasta'),
  ('cb100000-0000-0000-0000-0000000000cb', 'b10c0000-0000-0000-0000-00000000000b', 'Pizza');

-- Cacio e Pepe deliberately claims the RIVAL location: the trigger must
-- overwrite it from the category, or a caller could smuggle an item into
-- another tenant's menu.
insert into menu_items (category_id, name, price_cents, location_id) values
  ('ca100000-0000-0000-0000-0000000000ca', 'Cacio e Pepe', 2200, 'b10c0000-0000-0000-0000-00000000000b'),
  ('cb100000-0000-0000-0000-0000000000cb', 'Margherita', 1800, 'b10c0000-0000-0000-0000-00000000000b');

insert into calls (id, location_id, twilio_call_sid) values
  ('cc100000-0000-0000-0000-0000000000cc', 'a10c0000-0000-0000-0000-00000000000a', 'CA_test_a');

insert into results
select 'trigger forces menu item to its category location',
       (select location_id::text from menu_items where name = 'Cacio e Pepe'),
       'a10c0000-0000-0000-0000-00000000000a';

-- ── owner A ──────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into results values ('owner A: own locations visible', (select count(*)::text from public.locations), '1');
insert into results values ('owner A: own menu items visible', (select count(*)::text from public.menu_items), '1');
insert into results values ('owner A: own calls visible', (select count(*)::text from public.calls), '1');
insert into results values ('owner A: own org visible', (select count(*)::text from public.organizations), '1');
insert into results values ('owner A: rival item hidden', (select count(*)::text from public.menu_items where name = 'Margherita'), '0');

do $$
begin
  insert into public.menu_items (category_id, name, price_cents, location_id)
  values ('cb100000-0000-0000-0000-0000000000cb', 'Sneaky Item', 100, 'b10c0000-0000-0000-0000-00000000000b');
  insert into results values ('owner A: insert into rival menu', 'allowed', 'denied');
exception when insufficient_privilege then
  insert into results values ('owner A: insert into rival menu', 'denied', 'denied');
end $$;

do $$
begin
  update public.menu_items set sold_out_until = 'close' where name = 'Cacio e Pepe';
  insert into results values ('owner A: flag own item sold out', 'allowed', 'allowed');
exception when insufficient_privilege then
  insert into results values ('owner A: flag own item sold out', 'denied', 'allowed');
end $$;

-- ── owner B ──────────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

insert into results values ('owner B: A calls hidden', (select count(*)::text from public.calls), '0');
insert into results values ('owner B: own location visible', (select count(*)::text from public.locations), '1');
insert into results values ('owner B: A menu hidden', (select count(*)::text from public.menu_items where name = 'Cacio e Pepe'), '0');

-- ── anonymous ────────────────────────────────────────────────────────

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

insert into results values ('anon: locations', (select count(*)::text from public.locations), '0');
insert into results values ('anon: menu', (select count(*)::text from public.menu_items), '0');
insert into results values ('anon: calls', (select count(*)::text from public.calls), '0');

-- ── the voice agent, minted for location A ───────────────────────────

set local role agent_service;
set local request.jwt.claims = '{"role":"agent_service","location_id":"a10c0000-0000-0000-0000-00000000000a"}';

insert into results values ('agent: sees only its own location menu', (select count(*)::text from public.menu_items), '1');

do $$
begin
  insert into public.calls (location_id, twilio_call_sid)
  values ('a10c0000-0000-0000-0000-00000000000a', 'CA_agent_ok');
  insert into results values ('agent: log call for own location', 'allowed', 'allowed');
exception when insufficient_privilege then
  insert into results values ('agent: log call for own location', 'denied', 'allowed');
end $$;

do $$
begin
  insert into public.calls (location_id, twilio_call_sid)
  values ('b10c0000-0000-0000-0000-00000000000b', 'CA_agent_bad');
  insert into results values ('agent: log call for another location', 'allowed', 'denied');
exception when insufficient_privilege then
  insert into results values ('agent: log call for another location', 'denied', 'denied');
end $$;

-- A leaked agent token must not be able to pull call history back out.
do $$
declare n int;
begin
  select count(*) into n from public.calls;
  insert into results values ('agent: read calls back', 'allowed', 'denied');
exception when insufficient_privilege then
  insert into results values ('agent: read calls back', 'denied', 'denied');
end $$;

do $$
begin
  update public.menu_items set sold_out_until = null where name = 'Cacio e Pepe';
  insert into results values ('agent: edit the menu', 'allowed', 'denied');
exception when insufficient_privilege then
  insert into results values ('agent: edit the menu', 'denied', 'denied');
end $$;

do $$
declare n int;
begin
  select count(*) into n from public.menu_imports;
  insert into results values ('agent: read menu imports', 'allowed', 'denied');
exception when insufficient_privilege then
  insert into results values ('agent: read menu imports', 'denied', 'denied');
end $$;

reset role;

select case when got is not distinct from want then 'PASS' else 'FAIL' end as status,
       name, got, want
from results
order by (got is not distinct from want), name;

rollback;
