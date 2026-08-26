-- Three dishes a restaurant stands behind, and the agent may say so.
--
-- The cap is here and not only in the form because a limit that exists
-- only in a form is not a limit. It is also the whole feature: an owner
-- who marks all 46 items gets an agent that compliments everything,
-- which is the grating version this exists to avoid.
alter table menu_items
  add column is_staff_pick boolean not null default false;

create or replace function app.enforce_staff_pick_cap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  picks integer;
begin
  -- Only a row that IS a pick can push a location over the line.
  if new.is_staff_pick is not true then
    return new;
  end if;

  -- Already counted: an edit to a row that was a pick before, and has
  -- not moved to another restaurant, changes no total.
  if tg_op = 'UPDATE'
     and old.is_staff_pick is true
     and old.location_id = new.location_id then
    return new;
  end if;

  select count(*) into picks
    from menu_items
   where location_id = new.location_id
     and is_staff_pick
     and id <> new.id;

  if picks >= 3 then
    raise exception
      'A restaurant can mark at most three staff picks.'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- Revoked from the tenant roles by name and granted to nobody: this runs
-- as a trigger, never as a call, and the house posture is that a
-- SECURITY DEFINER function is not also an API.
revoke all on function app.enforce_staff_pick_cap() from anon, authenticated;

create trigger menu_items_staff_pick_cap
  before insert or update on menu_items
  for each row execute function app.enforce_staff_pick_cap();

comment on column menu_items.is_staff_pick is
  'The restaurant nominated this dish. get_menu carries it to the agent, '
  'which may say once that it is the one people come back for. Capped at '
  'three per location by menu_items_staff_pick_cap. Suppressed in the '
  'agent payload while the item is sold out -- see lib/agent/menu.ts.';
