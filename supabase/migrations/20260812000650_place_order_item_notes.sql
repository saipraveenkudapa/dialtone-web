-- Per-item changes: "no onions", said out loud and then thrown away.
--
-- lib/agent/prompt.ts tells the agent to take "every item with size and
-- any changes" and to confirm each one back ("Got it, large pepperoni").
-- Nothing carried that anywhere. `place_order` took ids and quantities;
-- `orders.notes` is the delivery address, not a free field; and
-- `order_items.modifiers` -- which has existed since
-- 20260807000100_schema.sql, `jsonb not null default '[]'` -- was never
-- written by anything. So the caller heard "no onions" confirmed, the
-- ticket at the pass read `1x Margherita`, and they got onions. Every
-- modified order, silently.
--
-- The fix uses the column that is already there rather than inventing
-- storage: one free-text note per line, stored as a one-element jsonb
-- array of strings. Free text, not a priced modifier -- no money is
-- computed from it, no menu row backs it, and the "sizes and modifiers
-- aren't priced" gap in docs/vapi-setup.md stays exactly as true as it
-- was. A cook reads it; the till does not.
--
-- An array (rather than a bare jsonb string) so the column's existing
-- shape and default hold: '[]' means "no modifiers" and stays the empty
-- case, and a future priced-modifier feature can add objects alongside
-- without every existing row having to be migrated out of a different
-- shape first.
--
-- The signature has to change to carry the notes, which means a new
-- pg_proc row, which means the ACL is born fresh from pg_default_acl's
-- `EXECUTE -> anon, authenticated` (see the revoke and the assert at the
-- bottom -- load-bearing here, not a formality). Everything else in the
-- function below is byte-for-byte 20260812000400_place_order.sql: the
-- pricing, the sold-out re-check, the advisory lock, the order
-- numbering, and the idempotency lookup are unchanged.

-- ── the write ────────────────────────────────────────────────────────

-- Dropped by its exact old signature rather than left as an overload:
-- two candidates named place_order would make PostgREST's by-name
-- dispatch ambiguous (PGRST203) and break every order, not just the
-- modified ones.
drop function if exists public.place_order(
  uuid, uuid[], integer[], text, text, text, text, uuid, text, integer
);

-- p_notes is a third parallel array, same length and same order as the
-- other two, for the same reason they are arrays rather than jsonb:
-- Postgres type-checks them at the call boundary. NULL (or a NULL
-- element) means "no change to this line", which is the ordinary case
-- and must stay free to express.
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
  p_promised_minutes integer default 25,
  p_notes            text[] default null
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
  -- Kept in step with MAX_ORDER_LINES / MAX_ITEM_QUANTITY /
  -- MAX_ITEM_NOTE_LENGTH in lib/agent/orders.ts. The route refuses first
  -- so the caller hears a sentence instead of an error; these are the
  -- authority, because the route is not the only thing that can call
  -- this.
  c_max_lines       constant integer := 40;
  c_max_qty         constant integer := 50;
  c_max_note_length constant integer := 200;

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

  -- The notes, normalised once here so every use below -- the length
  -- check, the fingerprint, and the insert -- reads the same values. A
  -- caller that sends no array at all gets one of the right length full
  -- of NULLs, so `unnest` of the three arrays together still yields one
  -- row per line.
  v_notes       text[];

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

  -- A notes array of the wrong length is a mismatched request, not a
  -- reason to guess which line each note belongs to: an off-by-one here
  -- puts "no onions" on somebody else's pasta.
  if p_notes is not null
     and coalesce(array_length(p_notes, 1), 0) <> v_lines then
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

  -- Blank-to-NULL first, so '   ' and '' are the same "no change" NULL
  -- is, and one normalisation feeds the length check, the fingerprint
  -- and the insert alike.
  select array_agg(nullif(btrim(n.note), '') order by n.ord)
    into v_notes
    from unnest(coalesce(p_notes, array_fill(null::text, array[v_lines])))
         with ordinality as n(note, ord);

  -- Same reason the quantity is bounded: this is written to a column,
  -- printed on a ticket a cook reads at a pass, and put in the body of
  -- an SMS. A runaway transcript is not a modification.
  if exists (
    select 1 from unnest(v_notes) as n(note)
     where length(n.note) > c_max_note_length
  ) then
    return query select false, false, null::uuid, null::integer,
                        null::integer, null::integer, null::integer,
                        'bad_note'::text, null::text;
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
  -- the kitchen prints another. Notes change none of this: they are not
  -- priced.
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
  -- The note is part of the key, and has to be: a caller who says "one
  -- margherita" and then, correcting themselves in the same call, "one
  -- margherita, no onions" is asking for a different plate of food. With
  -- the note left out of the fingerprint the correction is
  -- indistinguishable from a retry of the first order, and the kitchen
  -- would cook exactly what the caller just changed their mind about --
  -- which is the same failure this whole migration exists to fix, moved
  -- one layer down.
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
               string_agg(l.id::text || ':' || l.quantity::text ||
                          ':' || coalesce(l.note, ''), ','
                          order by l.id, l.quantity, coalesce(l.note, '')), '')
           )
      into v_key
      from unnest(p_item_ids, p_quantities, v_notes) as l(id, quantity, note);
  end if;

  -- Everything below happens under the location's lock, held until this
  -- transaction commits. It does two jobs at once: it serialises order
  -- numbering with app.assign_order_number (20260812000400_place_order.sql,
  -- same key), and it makes the idempotency lookup-then-insert
  -- indivisible, so two retries of one tool call arriving together
  -- cannot both conclude they are the first.
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
    order_id, menu_item_id, name_snapshot, price_cents_snapshot, quantity,
    modifiers
  )
  -- Snapshots so the ticket still reads correctly after the menu changes,
  -- and taken from the same menu_items read that set the price -- there
  -- is no second source for either. Ordinality keeps the lines on the
  -- ticket in the order the caller said them.
  --
  -- The note is snapshot text like the name and the price: what the
  -- caller asked for on this line, as they asked for it, kept with the
  -- line rather than pooled in a per-order field where nobody could tell
  -- which plate it belonged to.
  select v_id, m.id, m.name, m.price_cents, l.quantity,
         case when l.note is null then '[]'::jsonb
              else jsonb_build_array(l.note) end
    from unnest(p_item_ids, p_quantities, v_notes)
         with ordinality as l(id, quantity, note, ord)
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
-- their own, which `revoke ... from public` does not touch. The drop
-- above makes that literal rather than theoretical -- this is a brand new
-- pg_proc row, born with the default ACL. Left in place, anybody holding
-- the publishable anon key could POST /rest/v1/rpc/place_order and write
-- an order -- priced correctly, but into any restaurant's queue, and with
-- any customer name and phone on it -- because SECURITY DEFINER bypasses
-- the RLS that otherwise stands between them and the orders table.
revoke all on function public.place_order(
  uuid, uuid[], integer[], text, text, text, text, uuid, text, integer, text[]
) from public, anon, authenticated;

grant execute on function public.place_order(
  uuid, uuid[], integer[], text, text, text, text, uuid, text, integer, text[]
) to service_role;

-- Turns a silent re-grant into a failed migration, the same guard and the
-- same reasoning as 20260812000300_book_table_hardening.sql,
-- 20260812000400_place_order.sql and
-- 20260812000500_book_table_idempotency.sql. pg_default_acl in this
-- database still carries `EXECUTE -> anon, authenticated` for functions
-- created in public, so any future migration that adds or changes a
-- parameter -- exactly what this one just did -- produces a NEW pg_proc
-- row that inherits those defaults fresh and reopens EXECUTE to the anon
-- key, with nothing before this assert to catch it.
do $$
begin
  assert not has_function_privilege(
    'anon',
    'public.place_order(uuid, uuid[], integer[], text, text, text, text, uuid, text, integer, text[])',
    'execute'
  ), 'place_order must not be executable by anon -- pg_default_acl re-grant regression';

  assert not has_function_privilege(
    'authenticated',
    'public.place_order(uuid, uuid[], integer[], text, text, text, text, uuid, text, integer, text[])',
    'execute'
  ), 'place_order must not be executable by authenticated -- pg_default_acl re-grant regression';

  -- The old ten-argument overload must be gone, not merely shadowed:
  -- PostgREST dispatches by name and would refuse every order with
  -- PGRST203 if both survived.
  assert not exists (
    select 1 from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname = 'place_order'
       and p.pronargs <> 11
  ), 'exactly one public.place_order overload must exist';
end;
$$;
