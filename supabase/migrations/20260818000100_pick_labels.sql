-- WHICH KIND of pick, not merely that there is one.
--
-- A restaurant still nominates at most three dishes, but it now chooses
-- what the agent calls each one, from exactly two kinds. The wording
-- itself moved OUT of the prompt and INTO the get_menu payload
-- (lib/agent/menu.ts holds the one map from these codes to the spoken
-- phrase), which is why this column stores a code and not a sentence:
--
--   * the spoken phrase is presentation, and on a Spanish call the agent
--     says the Spanish for it -- a stored English sentence would invite
--     the agent to repeat it verbatim mid-sentence, the way it is
--     required to repeat an item NAME;
--   * a third kind later is one value in this constraint and one line in
--     that map, and costs the prompt nothing at all.
--
-- The old boolean is DROPPED, not migrated. Production holds zero picks
-- (verified before this was written), so there is no `true` anywhere to
-- carry forward and nothing a backfill could preserve.
--
-- text + check rather than a Postgres enum type, matching
-- locations.order_types and locations.order_delivery in
-- 20260807000100_schema.sql: a fourth value is then one migration that
-- rewrites this constraint, not an `alter type ... add value` that
-- cannot run in a transaction alongside anything else.
alter table menu_items
  drop column is_staff_pick,
  add column pick_label text
    check (pick_label in ('best_seller', 'chefs_special'));

-- Exactly ONE chef's special per restaurant. Nothing else says so, and
-- the spoken phrase depends on it being true.
--
-- The two kinds are not symmetric. lib/agent/menu.ts sends "one of our
-- best sellers" -- partitive, so three dishes may each be one and a
-- caller told about two of them has heard nothing contradictory. It
-- sends "the chef's special" DEFINITE, because a kitchen has one. The
-- cap above counts only the total, so all three of a restaurant's picks
-- could be chefs_special, and the prompt lets the agent name two picks
-- in a single call: exactly enough to tell one caller that the osso buco
-- is the chef's special and then that the branzino is too. That is the
-- phone line contradicting itself out loud about a matter of fact.
--
-- Partial and on location_id alone. A unique index is checked after the
-- BEFORE ROW triggers have run, so menu_items_sync_location has already
-- overwritten location_id from the category by then -- the spoofed
-- location_id route that 20260817000200 had to close for the cap cannot
-- walk round this. Nulls and best_seller rows are not in the index at
-- all, so they are never compared, and a collision is only ever between
-- two rows of the SAME restaurant: this leaks nothing across tenants.
--
-- 23505, deliberately NOT the cap's 23514. lib/admin/edit.ts maps the
-- two to different sentences, because "clear one of your three picks" is
-- no help at all to an operator who has picked two dishes and called
-- both of them the chef's special.
create unique index menu_items_one_chefs_special_idx
  on menu_items (location_id)
  where pick_label = 'chefs_special';

-- The cap counts LABELS now, not `true`s. Everything else about this
-- function is carried forward unchanged from
-- 20260817000200_staff_pick_cap_bypass_fix.sql, and the derivation below
-- is the whole of that fix -- read its header before touching it.
--
-- The function and trigger keep their names. Neither of the two labels is
-- called a "staff pick" any more, so the name is now a shade off, but it
-- is the name two migrations, three source comments and the operator
-- console's own courtesy count already refer to, and renaming it buys
-- nothing a comment cannot say.
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
  -- Only a row that IS a pick can push a location over the line. Null is
  -- "not a pick"; either label counts, and counts the same.
  if new.pick_label is null then
    return new;
  end if;

  -- The row's true location, derived from category_id exactly as
  -- app.sync_menu_item_location derives it -- not new.location_id, which
  -- may still hold whatever the caller supplied if this trigger fires
  -- before the sync trigger does. That is not a hypothetical: an INSERT
  -- carrying one restaurant's category_id and another's location_id got
  -- a restaurant to four picks, because same-event BEFORE ROW triggers
  -- fire in alphabetical order by name and this one sorts before
  -- menu_items_sync_location.
  select c.location_id into effective_location
  from menu_categories c
  where c.id = new.category_id;

  if effective_location is null then
    -- No such category: menu_items_sync_location raises its own
    -- foreign_key_violation for this row. Nothing to enforce here.
    return new;
  end if;

  -- Already counted: an edit to a row that was a pick before, and whose
  -- true location has not changed, changes no total. That now covers one
  -- more case than it used to -- swapping a dish from one label to the
  -- other rewords a pick the restaurant already holds and must not need
  -- a free slot to do it. Compared against the derived location rather
  -- than new.location_id, so a category change that moves the row to a
  -- different restaurant is still recounted even on an UPDATE that never
  -- touches location_id itself.
  if tg_op = 'UPDATE'
     and old.pick_label is not null
     and old.location_id = effective_location then
    return new;
  end if;

  select count(*) into picks
    from menu_items
   where location_id = effective_location
     and pick_label is not null
     and id <> new.id;

  if picks >= 3 then
    -- 23514. lib/admin/edit.ts catches exactly this SQLSTATE, on both
    -- writers of this table, and turns it into a sentence an operator
    -- can act on. Changing the errcode here silently turns that sentence
    -- back into a generic write failure.
    raise exception
      'A restaurant can mark at most three picks.'
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- Re-assert the posture, not just restate it: CREATE OR REPLACE FUNCTION
-- preserves whatever ACL the function already had, so this has to be
-- re-run on every replace, same as the other SECURITY DEFINER functions
-- in this codebase. PUBLIC is named explicitly because every new function
-- gets an implicit EXECUTE grant to it, and PUBLIC's grantee in the ACL
-- is OID 0, which matches no row in pg_roles and so drops silently out of
-- any verification query that joins aclexplode(proacl) to it.
revoke all on function app.enforce_staff_pick_cap() from public, anon, authenticated;

comment on column menu_items.pick_label is
  'Which kind of pick this dish is: best_seller, chefs_special, or null '
  'for not a pick. get_menu carries the SPOKEN phrase for it (see '
  'lib/agent/menu.ts), which the agent says in the caller''s own '
  'language -- unlike an item name, which is never translated. Capped at '
  'three non-null per location by menu_items_staff_pick_cap, and at ONE '
  'chefs_special per location by menu_items_one_chefs_special_idx, '
  'because the phrase for that one is definite and two dishes cannot '
  'both be it. Suppressed in the agent payload while the item is sold '
  'out.';
