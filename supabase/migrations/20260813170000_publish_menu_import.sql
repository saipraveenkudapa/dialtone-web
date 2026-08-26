-- The human gate, in one transaction.
--
-- This is the only door between a menu_imports row and menu_items, and
-- the shape of the door is the whole point of the feature:
--
--   * It takes no extraction. There is no raw_extraction argument, no
--     import id it reads items out of, and not one statement below reads
--     that column. Every name, price and description arrives in an
--     argument array, typed by or confirmed by a person on the review
--     screen. So there is no code path -- not a retry, not a bug, not a
--     future caller of this function -- by which what a model read can
--     reach the live menu without a human having sent it. That is THE
--     OWNER'S RULE expressed as a signature rather than as a comment.
--
--   * It is one transaction. Publishing means: create the categories,
--     create the items, and mark the import confirmed with who and when.
--     Done as three round trips from the browser, a failure on the second
--     leaves a menu half-written that the assistant starts quoting on the
--     very next call, and an import that still says "needs review" over a
--     menu that has already half-changed. Same reasoning as place_order
--     (20260812000400_place_order.sql) and book_table: atomicity only
--     exists inside a transaction, so the whole write lives here.
--
--   * Money is integer cents and Postgres type-checks it at the call
--     boundary. p_item_prices_cents is integer[], so a float price is a
--     22P02 from PostgREST before a single statement runs. Dollars are
--     turned into cents exactly once, in parseDollarsToCents on the
--     server action (lib/money.ts), from the string the human typed.
--
--   * It cannot be called by the service role. The revoke at the bottom
--     names service_role along with anon, and the assert proves it: the
--     only principal that can publish a menu is a signed-in member of the
--     restaurant's own organization, checked here with the same
--     app.can_access_location that RLS uses. A webhook cannot publish a
--     menu. A leaked publishable key cannot publish a menu.
--
-- SECURITY DEFINER, so the authorization check has to be explicit and
-- first -- which it is.

create or replace function public.publish_menu_import(
  p_location_id       uuid,
  p_batch_id          uuid,
  -- 'add'     -- keep the menu that is there and append to it
  -- 'replace' -- delete the menu that is there and put this one in its place
  p_mode              text,
  p_category_names    text[],
  -- For each item, the index into p_category_names of the section it
  -- belongs to. Zero-based, because it is written by TypeScript.
  p_item_category     integer[],
  p_item_names        text[],
  p_item_prices_cents integer[],
  -- '' means "no description". The column is nullable and the empty
  -- string is not a description, so it is stored as NULL.
  p_item_descriptions text[]
)
returns table (
  published          boolean,
  reason             text,
  categories_created integer,
  items_created      integer,
  categories_removed integer,
  items_removed      integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Kept in step with MAX_PUBLISH_ITEMS / MAX_PUBLISH_CATEGORIES and the
  -- field limits in lib/menu-imports/review.ts. The review screen refuses
  -- first so a person sees a sentence; these are the authority, because
  -- the screen is not the only thing that can call this.
  c_max_categories   constant integer := 60;
  c_max_items        constant integer := 500;
  c_max_price_cents  constant integer := 1000000;  -- $10,000
  c_max_name         constant integer := 120;
  c_max_category     constant integer := 80;
  c_max_description  constant integer := 280;

  v_user        uuid := auth.uid();
  v_items       integer;
  v_categories  integer;
  v_ids         uuid[];
  v_cat_ids     uuid[] := '{}';
  v_cat_base    integer[] := '{}';
  v_created     integer := 0;
  v_inserted    integer := 0;
  v_cat_removed integer := 0;
  v_item_removed integer := 0;
  v_name        text;
  v_cid         uuid;
  v_order       integer;
begin
  -- Authorization before anything else, and from the session rather than
  -- from an argument: SECURITY DEFINER means RLS is not standing behind
  -- this function, so this line is the tenant boundary. A stranger with a
  -- location uuid learns only 'not_found'.
  if v_user is null or not app.can_access_location(p_location_id) then
    return query select false, 'not_found'::text, 0, 0, 0, 0;
    return;
  end if;

  if p_mode is null or p_mode not in ('add', 'replace') then
    return query select false, 'invalid_mode'::text, 0, 0, 0, 0;
    return;
  end if;

  v_categories := coalesce(array_length(p_category_names, 1), 0);
  v_items := coalesce(array_length(p_item_names, 1), 0);

  -- Publishing nothing is not publishing. An import with no items left is
  -- discarded, not confirmed -- confirming it would mark a menu as signed
  -- for while leaving the restaurant with whatever was there before.
  if v_items = 0 or v_categories = 0 then
    return query select false, 'no_items'::text, 0, 0, 0, 0;
    return;
  end if;

  if v_items > c_max_items or v_categories > c_max_categories then
    return query select false, 'too_many'::text, 0, 0, 0, 0;
    return;
  end if;

  -- Four parallel arrays describe one item each. A short one would
  -- silently pair a name with another item's price.
  if v_items <> coalesce(array_length(p_item_category, 1), 0)
     or v_items <> coalesce(array_length(p_item_prices_cents, 1), 0)
     or v_items <> coalesce(array_length(p_item_descriptions, 1), 0) then
    return query select false, 'mismatched_items'::text, 0, 0, 0, 0;
    return;
  end if;

  if exists (
    select 1 from unnest(p_category_names) as heading(label)
     where heading.label is null
        or btrim(heading.label) = ''
        or length(btrim(heading.label)) > c_max_category
  ) then
    return query select false, 'bad_category'::text, 0, 0, 0, 0;
    return;
  end if;

  if exists (
    select 1 from unnest(p_item_names) as dish(label)
     where dish.label is null
        or btrim(dish.label) = ''
        or length(btrim(dish.label)) > c_max_name
  ) then
    return query select false, 'bad_item'::text, 0, 0, 0, 0;
    return;
  end if;

  if exists (
    select 1 from unnest(p_item_descriptions) as blurb(label)
     where blurb.label is null or length(btrim(blurb.label)) > c_max_description
  ) then
    return query select false, 'bad_description'::text, 0, 0, 0, 0;
    return;
  end if;

  -- The check this function exists for. A price is a whole number of
  -- cents, present, not negative, and not absurd: a misread that turned
  -- $12.00 into $1,200.00 is money out of the restaurant's pocket the
  -- moment the assistant says it out loud.
  if exists (
    select 1 from unnest(p_item_prices_cents) as price(cents)
     where price.cents is null or price.cents < 0 or price.cents > c_max_price_cents
  ) then
    return query select false, 'bad_price'::text, 0, 0, 0, 0;
    return;
  end if;

  if exists (
    select 1 from unnest(p_item_category) as filed(under)
     where filed.under is null or filed.under < 0 or filed.under >= v_categories
  ) then
    return query select false, 'bad_category_index'::text, 0, 0, 0, 0;
    return;
  end if;

  -- Everything from here to commit happens under this location's lock, so
  -- two people pressing Publish on the same import at the same moment
  -- cannot both find it unconfirmed and both write the menu.
  perform pg_advisory_xact_lock(
    hashtext('dialtone.publish_menu_import'),
    hashtext(p_location_id::text)
  );

  -- The import rows are the gate's own record. Taking them FOR UPDATE
  -- here, before a single menu row is touched, is what makes a second
  -- publish of the same batch a no-op rather than a duplicate menu: the
  -- second call waits, then finds nothing in 'needs_review'.
  select array_agg(s.id) into v_ids
  from (
    select mi.id
      from menu_imports mi
     where mi.location_id = p_location_id
       and mi.batch_id = p_batch_id
       and mi.status = 'needs_review'
     for update
  ) s;

  if v_ids is null then
    return query select false, 'nothing_to_publish'::text, 0, 0, 0, 0;
    return;
  end if;

  -- Replace: the menu that is there now goes. Items first so the count is
  -- honest -- deleting the categories alone would cascade the items away
  -- silently (menu_items.category_id is ON DELETE CASCADE) and report
  -- nothing removed. Nothing here touches orders: order_items keeps its
  -- own name and price snapshot of what was actually sold, which is why
  -- last week's tickets still read correctly after this.
  if p_mode = 'replace' then
    delete from menu_items where location_id = p_location_id;
    get diagnostics v_item_removed = row_count;
    delete from menu_categories where location_id = p_location_id;
    get diagnostics v_cat_removed = row_count;
  end if;

  -- One pass over the sections. A name that already exists at this
  -- location is reused rather than created a second time: 'add' must not
  -- leave a restaurant with two sections called Pizze, and after the
  -- delete above 'replace' has nothing to match except sections this same
  -- call just created, which is exactly how a duplicate name inside one
  -- import collapses into one section.
  for i in 1 .. v_categories loop
    -- A section nothing was filed under is not created at all. The review
    -- screen drops a section whose every item was deleted, and an empty
    -- heading on the live menu would be a section the assistant offers
    -- and then has nothing to read out of.
    if not (i - 1 = any(p_item_category)) then
      v_cat_ids := v_cat_ids || null::uuid;
      v_cat_base := v_cat_base || 0;
      continue;
    end if;

    v_name := btrim(p_category_names[i]);

    select c.id into v_cid
      from menu_categories c
     where c.location_id = p_location_id
       and lower(c.name) = lower(v_name)
     order by c.sort_order
     limit 1;

    if v_cid is null then
      select coalesce(max(c.sort_order), -1) + 1 into v_order
        from menu_categories c
       where c.location_id = p_location_id;

      insert into menu_categories (location_id, name, sort_order)
      values (p_location_id, v_name, v_order)
      returning menu_categories.id into v_cid;

      v_created := v_created + 1;
    end if;

    v_cat_ids := v_cat_ids || v_cid;

    -- Where this section's new items start. Appending into a section that
    -- already has items must not renumber the ones already there.
    select coalesce(max(m.sort_order), -1) + 1 into v_order
      from menu_items m
     where m.category_id = v_cid;

    v_cat_base := v_cat_base || v_order;
  end loop;

  -- The items, in the order the menu prints them. location_id is passed
  -- explicitly and then overwritten by app.sync_menu_item_location from
  -- the category -- belt and braces on the one column that decides which
  -- restaurant an item belongs to.
  --
  -- The window is partitioned by the RESOLVED category id, not by the
  -- index the caller sent. Two sections named the same thing collapse
  -- onto one id in the loop above; partitioning by the index would number
  -- both runs from the same base and land two items on sort_order 0, so
  -- the menu would come out in an order nobody chose.
  insert into menu_items (category_id, location_id, name, description, price_cents, sort_order)
  select v_cat_ids[l.category + 1],
         p_location_id,
         btrim(l.name),
         nullif(btrim(l.description), ''),
         l.cents,
         v_cat_base[l.category + 1]
           + (row_number() over (partition by v_cat_ids[l.category + 1] order by l.ord))::integer
           - 1
    from unnest(p_item_category, p_item_names, p_item_prices_cents, p_item_descriptions)
         with ordinality as l(category, name, cents, description, ord);

  get diagnostics v_inserted = row_count;

  -- Nothing is copied into allergen_note, and nothing ever will be. The
  -- ingredients the model read off the card are what a laminated menu
  -- happened to print; they cannot know the fryer is shared or that a
  -- dish is finished in butter, and the assistant still transfers every
  -- allergy question to a human. See the comment on
  -- menu_imports.raw_extraction (20260813150000_menu_import_extraction.sql).

  -- The signature. confirmed_at is required by the CHECK on this table
  -- whenever status is 'confirmed'; confirmed_by is the person, taken
  -- from the session and not from an argument, so the record of who
  -- signed for these prices cannot be handed in by the caller.
  update menu_imports
     set status = 'confirmed',
         confirmed_by = v_user,
         confirmed_at = now()
   where id = any(v_ids);

  return query select true, null::text, v_created, v_inserted,
                      v_cat_removed, v_item_removed;
end;
$$;

comment on function public.publish_menu_import(
  uuid, uuid, text, text[], integer[], text[], integer[], text[]
) is
  'The only path from a menu_imports batch to menu_items. Takes the items '
  'as arguments -- it never reads raw_extraction -- so nothing a model '
  'extracted can reach the live menu without a human having sent it. '
  'Creates the categories and items, marks every row of the batch '
  'confirmed with confirmed_by/confirmed_at, and does all of it in one '
  'transaction. p_mode is ''add'' or ''replace''.';

-- anon and service_role are named explicitly, not just PUBLIC: Supabase
-- ships `alter default privileges in schema public grant execute on
-- functions to anon, authenticated, service_role`, so a new function in
-- this schema arrives with all three already holding EXECUTE as grants of
-- their own, which `revoke ... from public` does not touch. `create or
-- replace` does not reset an ACL either, so this revoke has to be re-run
-- every time the function is replaced -- which is what re-running this
-- migration does.
--
-- service_role is revoked on purpose, and it is the interesting one.
-- Every other write in this product has some server-side path that can
-- reach it; this one must not. A menu goes live because a person who is a
-- member of the restaurant's organization signed for it, so the only role
-- that may publish is `authenticated`, and the check inside the function
-- is the same app.can_access_location that RLS uses. A webhook, a
-- background job, or anything else holding the service-role key is
-- refused by Postgres before the function body runs.
revoke all on function public.publish_menu_import(
  uuid, uuid, text, text[], integer[], text[], integer[], text[]
) from public, anon, authenticated, service_role;

grant execute on function public.publish_menu_import(
  uuid, uuid, text, text[], integer[], text[], integer[], text[]
) to authenticated;

-- Turns a silent re-grant into a failed migration. pg_default_acl in this
-- database still carries `EXECUTE -> anon, authenticated, service_role`
-- for functions created in public, so any future migration that adds or
-- changes a parameter produces a NEW pg_proc row that inherits those
-- defaults fresh and reopens EXECUTE to the anon key. Same guard, same
-- reasoning as 20260812000300_book_table_hardening.sql -- with the third
-- assert added because "an owner can publish their own menu" is as much a
-- requirement as "nobody else can".
do $$
declare
  c_signature constant text :=
    'public.publish_menu_import(uuid, uuid, text, text[], integer[], text[], integer[], text[])';
begin
  assert not has_function_privilege('anon', c_signature, 'execute'),
    'publish_menu_import must not be executable by anon -- pg_default_acl re-grant regression';

  assert not has_function_privilege('service_role', c_signature, 'execute'),
    'publish_menu_import must not be executable by service_role -- a menu goes live because a person signed for it';

  assert has_function_privilege('authenticated', c_signature, 'execute'),
    'publish_menu_import must be executable by authenticated -- an owner cannot confirm their own menu otherwise';
end;
$$;
