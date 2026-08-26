-- Fix: menu_items_staff_pick_cap trusted new.location_id, which a caller
-- supplies directly on INSERT (and which a plain UPDATE leaves untouched
-- unless it edits category_id). Postgres fires same-event BEFORE ROW
-- triggers in alphabetical order by trigger name, and
-- menu_items_staff_pick_cap sorts before menu_items_sync_location -- so
-- the cap was counted against whatever location_id the caller supplied,
-- before sync_location ever derived the true location from category_id.
--
-- Confirmed live: with Nonna Rosa already holding three picks, an INSERT
-- carrying Nonna Rosa's category_id but a spoofed location_id pointing at
-- a different, uncapped restaurant passed the cap check here, and
-- sync_location then silently corrected the row back to Nonna Rosa --
-- leaving it with four. (That row was rolled back; see the task-2 report
-- for the reproduction and the restored zero count.)
--
-- Fixed by deriving the row's true location the same way
-- app.sync_menu_item_location does -- straight from category_id -- rather
-- than reading new.location_id. That holds regardless of which trigger
-- happens to fire first, instead of resting on trigger-name alphabetical
-- order as an invisible load-bearing contract.
create or replace function app.enforce_staff_pick_cap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  picks integer;
  effective_location uuid;
begin
  -- Only a row that IS a pick can push a location over the line.
  if new.is_staff_pick is not true then
    return new;
  end if;

  -- The row's true location, derived from category_id exactly as
  -- app.sync_menu_item_location derives it -- not new.location_id, which
  -- may still hold whatever the caller supplied if this trigger fires
  -- before the sync trigger does.
  select c.location_id into effective_location
  from menu_categories c
  where c.id = new.category_id;

  if effective_location is null then
    -- No such category: menu_items_sync_location raises its own
    -- foreign_key_violation for this row. Nothing to enforce here.
    return new;
  end if;

  -- Already counted: an edit to a row that was a pick before, and whose
  -- true location has not changed, changes no total. Compared against
  -- the derived location rather than new.location_id, so a category
  -- change that moves the row to a different restaurant is still
  -- recounted even on an UPDATE that never touches location_id itself.
  if tg_op = 'UPDATE'
     and old.is_staff_pick is true
     and old.location_id = effective_location then
    return new;
  end if;

  select count(*) into picks
    from menu_items
   where location_id = effective_location
     and is_staff_pick
     and id <> new.id;

  if picks >= 3 then
    raise exception
      'A restaurant can mark at most three staff picks.'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- Re-assert the posture, not just restate it: CREATE OR REPLACE FUNCTION
-- preserves whatever ACL the function already had, so the two `revoke`s
-- below have to be re-run on every replace, same as the other
-- SECURITY DEFINER functions in this codebase. `app.enforce_staff_pick_cap`
-- lives outside `public`, so it never picked up Supabase's
-- `alter default privileges in schema public grant execute ... to anon,
-- authenticated, service_role` -- but every new function still gets an
-- implicit EXECUTE grant to PUBLIC, and the original migration revoked
-- only from anon and authenticated by name, never from PUBLIC itself.
-- A verification query that joins aclexplode(proacl) to pg_roles won't
-- surface that gap: PUBLIC's grantee in the ACL is OID 0, which matches
-- no row in pg_roles, so the grant silently drops out of the report
-- instead of showing up as a role with EXECUTE.
revoke all on function app.enforce_staff_pick_cap() from public, anon, authenticated;
