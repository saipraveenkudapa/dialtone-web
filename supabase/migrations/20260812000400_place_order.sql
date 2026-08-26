-- Placing an order atomically, priced by the database.
--
-- place_order was two round trips from the route: INSERT the orders row,
-- then INSERT its order_items. Nothing wrapped them, so a failure on the
-- second left the first committed -- status 'new', a real total, a real
-- promise time, the caller's name and phone, an order_status_events row,
-- and no food on it. The caller heard "I couldn't get that order in",
-- ordered again, and the kitchen was left holding a ticket that carries
-- money, cannot be cooked, and is indistinguishable from a genuine order
-- in both the pass queue and the revenue numbers. Exactly the class of
-- bug book_table (20260812000200_book_table.sql) fixed for reservations,
-- and the same fix: atomicity only exists inside a transaction, so the
-- whole write moves into one function and commits together or not at all.
--
-- Three more things follow from the write living here rather than in the
-- route:
--
--   * Price authority. There is no price argument. The route matches
--     spoken words to menu rows -- fuzzy word matching is not something
--     to reimplement in SQL -- but the money is worked out from
--     menu_items inside this function, keyed by id AND location. A price
--     in an argument list is a price the phone network can set, and
--     "prices from the live menu, never from what the agent believes an
--     item costs" is the entire point of the tool.
--
--   * Order numbering. app.assign_order_number does an unlocked
--     `select max(order_number) + 1`. Under READ COMMITTED two orders
--     placed at one location in the same moment compute the same number
--     and the unique (location_id, order_number) kills one insert with
--     23505 -- on a product whose whole premise is answering simultaneous
--     calls. This function and that trigger now take the SAME
--     per-location advisory lock, so numbering is serialised whichever
--     path does the writing.
--
--   * Idempotency. A 500 is precisely what makes an LLM retry a tool
--     call. A fingerprint of the phone call and the order it is asking
--     for is stored on the row and made unique per location, so a retry
--     finds the order it already placed instead of placing a second one.

-- ── idempotency key ──────────────────────────────────────────────────

alter table orders
  add column if not exists idempotency_key text;

comment on column orders.idempotency_key is
  'Fingerprint of the tool call that placed this order (provider_call_id + '
  'type + customer + address + sorted lines), computed inside '
  'public.place_order. Never supplied by a caller. NULL for orders placed '
  'without a provider_call_id, and for every order written by any path '
  'other than place_order.';

-- Partial so the pre-existing seeded order, the dashboard, and the Python
-- agent's own inserts (all of which leave this NULL) are unaffected --
-- NULLs are not compared by a unique index, but the partial predicate
-- makes that explicit rather than incidental. Scoped by location for the
-- same reason every other index here is: a fingerprint is only ever
-- looked up together with the location it was placed at.
create unique index if not exists orders_idempotency_key_idx
  on orders (location_id, idempotency_key)
  where idempotency_key is not null;

-- ── serialised order numbering ───────────────────────────────────────

-- Unchanged except for the lock (and pinning pg_temp out of the search
-- path, matching 20260812000300_book_table_hardening.sql). The lock has
-- to be here as well as in place_order below: place_order taking it
-- alone would still lose the race against any other writer that inserts
-- an order straight into the table -- the Python voice agent does today,
-- per the schema's own header -- because that writer's trigger would
-- compute max+1 without waiting, and the insert that then fails with
-- 23505 could just as easily be place_order's. Both paths take the same
-- key, so both queue.
create or replace function app.assign_order_number()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.order_number is null or new.order_number = 0 then
    -- Transaction-scoped: taken before the max is read, released by
    -- commit after the row is in, which is exactly the window that has
    -- to be exclusive. Keyed on the location, so two restaurants
    -- numbering orders at the same instant never wait on each other.
    perform pg_advisory_xact_lock(
      hashtext('dialtone.order_number'),
      hashtext(new.location_id::text)
    );

    select coalesce(max(order_number), 1000) + 1 into new.order_number
    from orders
    where location_id = new.location_id;
  end if;
  return new;
end;
$$;

-- ── the write ────────────────────────────────────────────────────────

-- Lives in public, not app, because it is called through PostgREST and
-- the app schema is deliberately not exposed -- which makes the grants at
-- the bottom load-bearing rather than cosmetic.
--
-- Lines arrive as two parallel arrays rather than jsonb so that Postgres
-- type-checks them at the call boundary: a malformed id or a
-- non-numeric quantity is a 22P02 from PostgREST before a single
-- statement of this function runs, instead of a cast that raises halfway
-- through it. There is no price and no tax rate among them.
create or replace function public.place_order(
  p_location_id      uuid,
  p_item_ids         uuid[],
  p_quantities       integer[],
  p_type             text,
  p_customer_name    text,
  p_customer_phone   text,
  p_address          text default null,
  p_call_id          uuid default null,
  p_provider_call_id text default null,
  p_promised_minutes integer default 25
)
returns table (
  placed         boolean,
  duplicate      boolean,
  order_id       uuid,
  order_number   integer,
  subtotal_cents integer,
  tax_cents      integer,
  total_cents    integer,
  reason         text,
  item           text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Kept in step with MAX_ORDER_LINES / MAX_ITEM_QUANTITY in
  -- lib/agent/orders.ts. The route refuses first so the caller hears a
  -- sentence instead of an error; these are the authority, because the
  -- route is not the only thing that can call this.
  c_max_lines constant integer := 40;
  c_max_qty   constant integer := 50;

  v_tax_bps     integer;
  v_order_types text;
  v_lines       integer;
  v_matched     integer;
  v_item        text;
  v_subtotal    integer;
  v_tax         integer;
  v_total       integer;
  v_key         text;
  v_id          uuid;
  v_number      integer;

  -- Deliberately separate from v_subtotal/v_tax/v_total above. `select
  -- ... into` sets EVERY target to NULL when it matches no row, so
  -- reading the duplicate straight back into the pricing variables blanks
  -- the totals of every order that is NOT a duplicate -- which is exactly
  -- what the first live run of this function did, dying on
  -- subtotal_cents' NOT NULL with the customer's name and phone in the
  -- error detail.
  v_dup_id       uuid;
  v_dup_number   integer;
  v_dup_subtotal integer;
  v_dup_tax      integer;
  v_dup_total    integer;
begin
  -- The tax rate and which order types this restaurant takes are read
  -- from the location row, never taken from an argument: every argument
  -- here is a request body away from the phone network.
  select l.tax_rate_bps, l.order_types
    into v_tax_bps, v_order_types
    from locations l
   where l.id = p_location_id;

  if not found then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'unknown_location'::text, null::text;
    return;
  end if;

  if p_type is null or p_type not in ('pickup', 'delivery') then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'invalid_type'::text, null::text;
    return;
  end if;

  -- Both directions. A location set to 'delivery' silently taking pickup
  -- orders is the same bug as one set to 'pickup' silently taking
  -- delivery, and only one of the two was ever refused.
  if p_type = 'delivery' and v_order_types = 'pickup' then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'no_delivery'::text, null::text;
    return;
  end if;

  if p_type = 'pickup' and v_order_types = 'delivery' then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'no_pickup'::text, null::text;
    return;
  end if;

  -- A delivery ticket with no address is a meal nobody can deliver.
  if p_type = 'delivery' and coalesce(btrim(p_address), '') = '' then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'missing_address'::text, null::text;
    return;
  end if;

  if coalesce(btrim(p_customer_name), '') = ''
     or coalesce(btrim(p_customer_phone), '') = '' then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'missing_customer'::text, null::text;
    return;
  end if;

  v_lines := coalesce(array_length(p_item_ids, 1), 0);

  if v_lines = 0 then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'no_items'::text, null::text;
    return;
  end if;

  if v_lines <> coalesce(array_length(p_quantities, 1), 0) then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'mismatched_lines'::text, null::text;
    return;
  end if;

  if v_lines > c_max_lines then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'too_many_items'::text, null::text;
    return;
  end if;

  -- An unbounded quantity is an unbounded subtotal and an unbounded
  -- ticket. A transcription slip ("fifteen" heard as "fifty thousand")
  -- must not become a five-figure order.
  if exists (
    select 1 from unnest(p_quantities) as q(quantity)
     where q.quantity is null or q.quantity < 1 or q.quantity > c_max_qty
  ) then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'bad_quantity'::text, null::text;
    return;
  end if;

  if p_promised_minutes is null
     or p_promised_minutes < 1 or p_promised_minutes > 240 then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'bad_promise'::text, null::text;
    return;
  end if;

  -- Price authority starts here. Every id is looked up in menu_items
  -- scoped to THIS location, so an id belonging to another restaurant's
  -- menu can neither be priced nor attached to this order -- it simply
  -- fails to match and the whole order is refused.
  select count(*) into v_matched
    from unnest(p_item_ids) as l(id)
    join menu_items m on m.id = l.id and m.location_id = p_location_id;

  if v_matched <> v_lines then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'unknown_item'::text, null::text;
    return;
  end if;

  -- The sold-out re-check belongs wherever the prices are read, because
  -- it is the same read: a manager can flag an item out from the
  -- dashboard while this very call is in progress, and this is now the
  -- last checkpoint before the write. lib/agent/orders.ts still checks
  -- it against the menu the route fetched a moment earlier -- that stays
  -- because it is what produces a refusal the agent can say out loud
  -- without attempting a write at all, and because it is the same pass
  -- that resolves a spoken name to the id used here. It is a fast path,
  -- not the authority. This is.
  select m.name into v_item
    from unnest(p_item_ids) as l(id)
    join menu_items m on m.id = l.id and m.location_id = p_location_id
   where m.sold_out_until is not null
   limit 1;

  if v_item is not null then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'sold_out'::text, v_item;
    return;
  end if;

  select coalesce(sum(m.price_cents * l.quantity), 0)::integer
    into v_subtotal
    from unnest(p_item_ids, p_quantities) as l(id, quantity)
    join menu_items m on m.id = l.id and m.location_id = p_location_id;

  -- Basis points over numeric, so no float ever holds money. Postgres'
  -- round() breaks ties away from zero and JavaScript's Math.round breaks
  -- them upward; both operands are non-negative here, so the two agree
  -- and priceOrder in lib/agent/orders.ts stays a faithful mirror of this
  -- line. If that ever stops being true the agent quotes one total and
  -- the kitchen prints another.
  v_tax := round(v_subtotal::numeric * v_tax_bps / 10000)::integer;
  v_total := v_subtotal + v_tax;

  -- The fingerprint is built here, from the arguments, so no caller can
  -- weaken it by choosing its own key. provider_call_id scopes it to one
  -- phone call: a retried tool call inside that call collides, while
  -- tomorrow's caller ordering the same food does not. The rest of the
  -- key is what makes this order this order -- without it, a caller who
  -- adds a dessert halfway through would have the second place_order
  -- swallowed as a retry of the first. Lines are sorted so a retry that
  -- reorders them is still recognised.
  --
  -- The trade this makes: two genuinely identical orders inside one call
  -- are indistinguishable from a retry and collapse into one. A caller
  -- who wants twice as much says so with a quantity, and no key built
  -- from the request alone can tell those two cases apart -- only the
  -- provider could, by not retrying with the same id.
  --
  -- No provider_call_id means no key and no protection. That is honest
  -- rather than silent: a made-up key would dedupe nothing while looking
  -- like it did.
  if coalesce(btrim(p_provider_call_id), '') <> '' then
    select md5(
             btrim(p_provider_call_id) || E'\n' ||
             p_type                    || E'\n' ||
             btrim(p_customer_name)    || E'\n' ||
             btrim(p_customer_phone)   || E'\n' ||
             coalesce(btrim(p_address), '') || E'\n' ||
             coalesce(
               string_agg(l.id::text || ':' || l.quantity::text, ','
                          order by l.id, l.quantity), '')
           )
      into v_key
      from unnest(p_item_ids, p_quantities) as l(id, quantity);
  end if;

  -- Everything below happens under the location's lock, held until this
  -- transaction commits. It does two jobs at once: it serialises order
  -- numbering with app.assign_order_number above (same key), and it makes
  -- the idempotency lookup-then-insert indivisible, so two retries of one
  -- tool call arriving together cannot both conclude they are the first.
  perform pg_advisory_xact_lock(
    hashtext('dialtone.order_number'),
    hashtext(p_location_id::text)
  );

  if v_key is not null then
    select o.id, o.order_number, o.subtotal_cents, o.tax_cents, o.total_cents
      into v_dup_id, v_dup_number, v_dup_subtotal, v_dup_tax, v_dup_total
      from orders o
     where o.location_id = p_location_id
       and o.idempotency_key = v_key;

    -- Answered with the order that already exists, and with its totals as
    -- stored rather than as just recomputed: a retry must describe what
    -- is actually on the pass, even if a price changed in between.
    if found then
      return query select true, true, v_dup_id, v_dup_number,
                          v_dup_subtotal, v_dup_tax, v_dup_total,
                          null::text, null::text;
      return;
    end if;
  end if;

  insert into orders (
    location_id, call_id, order_number, customer_name, customer_phone,
    type, status, subtotal_cents, tax_cents, total_cents, notes,
    promised_at, idempotency_key
  )
  values (
    p_location_id, p_call_id, 0, btrim(p_customer_name), btrim(p_customer_phone),
    p_type, 'new', v_subtotal, v_tax, v_total,
    case when p_type = 'delivery' then btrim(p_address) else null end,
    now() + make_interval(mins => p_promised_minutes), v_key
  )
  -- 0 leaves the number to app.assign_order_number, which runs BEFORE
  -- this insert and under the lock already held above; RETURNING reads
  -- back what the trigger actually assigned. Qualified because
  -- order_number is also the name of one of this function's OUT columns.
  returning orders.id, orders.order_number into v_id, v_number;

  -- The insert this function exists for. Same transaction, same commit:
  -- if this raises -- a constraint, a deleted menu item, a disk error --
  -- the orders row above goes with it and the caller is told no, rather
  -- than the kitchen being handed an empty ticket.
  insert into order_items (
    order_id, menu_item_id, name_snapshot, price_cents_snapshot, quantity
  )
  -- Snapshots so the ticket still reads correctly after the menu changes,
  -- and taken from the same menu_items read that set the price -- there
  -- is no second source for either. Ordinality keeps the lines on the
  -- ticket in the order the caller said them.
  select v_id, m.id, m.name, m.price_cents, l.quantity
    from unnest(p_item_ids, p_quantities) with ordinality as l(id, quantity, ord)
    join menu_items m on m.id = l.id and m.location_id = p_location_id
   order by l.ord;

  return query select true, false, v_id, v_number,
                      v_subtotal, v_tax, v_total,
                      null::text, null::text;
end;
$$;

-- anon and authenticated are named explicitly, not just PUBLIC: Supabase
-- ships `alter default privileges in schema public grant execute on
-- functions to anon, authenticated, service_role`, so a new function in
-- this schema arrives with those two already holding EXECUTE as grants of
-- their own, which `revoke ... from public` does not touch. Left in
-- place, anybody holding the publishable anon key could POST
-- /rest/v1/rpc/place_order and write an order -- priced correctly, but
-- into any restaurant's queue, and with any customer name and phone on
-- it -- because SECURITY DEFINER bypasses the RLS that otherwise stands
-- between them and the orders table. `create or replace` does not reset
-- an ACL either, so this revoke has to be re-run every time the function
-- is replaced, which is exactly what re-running this migration does.
revoke all on function public.place_order(
  uuid, uuid[], integer[], text, text, text, text, uuid, text, integer
) from public, anon, authenticated;

grant execute on function public.place_order(
  uuid, uuid[], integer[], text, text, text, text, uuid, text, integer
) to service_role;

-- Turns a silent re-grant into a failed migration. pg_default_acl in this
-- database still carries `EXECUTE -> anon, authenticated` for functions
-- created in public, so any future migration that adds or changes a
-- parameter -- or drops and recreates place_order -- produces a NEW
-- pg_proc row that inherits those defaults fresh and reopens EXECUTE to
-- the anon key, with nothing before this assert to catch it. Same guard,
-- same reasoning as 20260812000300_book_table_hardening.sql.
do $$
begin
  assert not has_function_privilege(
    'anon',
    'public.place_order(uuid, uuid[], integer[], text, text, text, text, uuid, text, integer)',
    'execute'
  ), 'place_order must not be executable by anon -- pg_default_acl re-grant regression';

  assert not has_function_privilege(
    'authenticated',
    'public.place_order(uuid, uuid[], integer[], text, text, text, text, uuid, text, integer)',
    'execute'
  ), 'place_order must not be executable by authenticated -- pg_default_acl re-grant regression';
end;
$$;
