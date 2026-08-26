-- Idempotency for public.book_table -- the protection place_order already
-- has, and reservations did not.
--
-- A 500 or a timeout is precisely what makes an LLM retry a tool call.
-- place_order (20260812000400_place_order.sql) survives that: it
-- fingerprints the phone call together with the order it is asking for,
-- stores the fingerprint on the row, and a retry finds the order it
-- already placed. create_reservation had nothing of the kind, so the
-- same retry booked a second table for the same party -- and a booking
-- is not merely a duplicate record. It holds seats. Two rows for one
-- caller consume real capacity for the whole slot, so book_table's own
-- occupancy sweep counts the phantom and the next genuine caller is told
-- the restaurant is full. The caller who was double-booked hears the
-- right confirmation either way and never finds out; the restaurant
-- finds out when a table sits empty and a booking was turned away for it.
--
-- The fix is the same shape as place_order's, deliberately: the two
-- should read as siblings. What differs is only what makes a booking
-- distinct (below) and that book_table's return has to grow a
-- `duplicate` flag -- which, because you cannot change a function's
-- return type with `create or replace`, means dropping and recreating
-- it. That drop is exactly the event 20260812000300_book_table_
-- hardening.sql warned about: a new pg_proc row inherits
-- pg_default_acl's `EXECUTE -> anon, authenticated` fresh. The revoke and
-- the assert at the bottom are therefore load-bearing here, not a
-- formality carried over.

-- ── idempotency key ──────────────────────────────────────────────────

alter table bookings
  add column if not exists idempotency_key text;

comment on column bookings.idempotency_key is
  'Fingerprint of the tool call that made this booking (provider_call_id + '
  'requested_at + party_size + customer name + customer phone), computed '
  'inside public.book_table. Never supplied by a caller. NULL for bookings '
  'made without a provider_call_id, and for every booking written by any '
  'path other than book_table.';

-- Partial, so the seeded Marcus booking, the dashboard, and the Python
-- agent's own RLS-scoped INSERT (all of which leave this NULL) are
-- unaffected -- NULLs are not compared by a unique index, but the partial
-- predicate makes that explicit rather than incidental. Scoped by
-- location for the same reason orders_idempotency_key_idx is: a
-- fingerprint is only ever looked up together with the location it was
-- booked at.
create unique index if not exists bookings_idempotency_key_idx
  on bookings (location_id, idempotency_key)
  where idempotency_key is not null;

-- ── the write ────────────────────────────────────────────────────────

-- Dropped rather than replaced: `create or replace function` cannot
-- change a function's return type, and this one gains a `duplicate`
-- column. Dropped by its exact old signature so no six-argument overload
-- is left behind -- two candidates with the same name would make
-- PostgREST's by-name dispatch ambiguous (PGRST203) and break every
-- reservation instead of just the retried ones.
drop function if exists public.book_table(
  uuid, timestamptz, integer, text, text, uuid
);

-- Unchanged from 20260812000200_book_table.sql except for the
-- fingerprint, the `duplicate` column, and the new p_provider_call_id
-- argument. The peak-occupancy SQL below is verified against
-- lib/agent/availability.ts's seatsTaken across seven fixtures and stays
-- byte-for-byte as it was.
--
-- Lives in public, not app, because it is called through PostgREST and
-- the app schema is deliberately not exposed. That makes the grants
-- load-bearing rather than cosmetic: SECURITY DEFINER bypasses RLS, so
-- execute is revoked from public and given only to service_role, the
-- role the web app's tool endpoint uses. anon and authenticated cannot
-- reach it, and the Python agent (agent_service) does not call it today
-- -- it keeps its RLS-scoped INSERT -- so it is not granted either.
create or replace function public.book_table(
  p_location_id      uuid,
  p_requested_at     timestamptz,
  p_party_size       integer,
  p_customer_name    text,
  p_customer_phone   text,
  p_call_id          uuid default null,
  p_provider_call_id text default null
)
returns table (booked boolean, duplicate boolean, booking_id uuid, reason text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seats     integer;
  v_slot      integer;
  v_max_party integer;
  v_len       interval;
  v_end       timestamptz;
  v_peak      integer;
  v_id        uuid;
  v_key       text;

  -- Deliberately separate from v_id. `select ... into` sets EVERY target
  -- to NULL when it matches no row, so reading the duplicate straight
  -- back into v_id would blank it for every booking that is NOT a
  -- duplicate -- the same trap place_order documents at its own
  -- v_dup_id, and the one that killed its first live run.
  v_dup_id    uuid;
begin
  -- seats, slot length and max party size are read from the location
  -- row, never taken from the caller: the caller is a request body away
  -- from the phone network.
  select l.seats, l.reservation_slot_minutes, l.max_party_size
    into v_seats, v_slot, v_max_party
    from locations l
   where l.id = p_location_id;

  if not found then
    return query select false, false, null::uuid, 'unknown_location'::text;
    return;
  end if;

  if p_party_size is null or p_party_size < 1 then
    return query select false, false, null::uuid, 'invalid_party'::text;
    return;
  end if;

  if p_party_size > v_max_party then
    return query select false, false, null::uuid, 'large_party'::text;
    return;
  end if;

  -- The fingerprint is built here, from the arguments, so no caller can
  -- weaken it by choosing its own key. provider_call_id scopes it to one
  -- phone call: a retried tool call inside that call collides, while
  -- tomorrow's caller booking the same table for the same party does
  -- not. The rest of the key is what makes this booking THIS booking --
  -- the slot, the size of the party, and who it is for. Without them a
  -- caller who books 7pm for two and then, later in the same call, 9pm
  -- for six -- or a second table under their colleague's name -- would
  -- have the second booking swallowed as a retry of the first.
  --
  -- requested_at is rendered at UTC through to_char rather than cast
  -- with ::text, because a timestamptz's text form is written in the
  -- session's TimeZone: the same instant would fingerprint differently
  -- from two connections and the retry would not be recognised. This is
  -- the one ingredient place_order's key has no equivalent of, so it is
  -- the one that has to be pinned by hand.
  --
  -- The trade this makes, exactly as place_order makes it: two genuinely
  -- separate bookings for the same party size, same slot, same name and
  -- number, inside one call, are indistinguishable from a retry and
  -- collapse into one. A caller wanting two tables for eight says so
  -- with a party size of sixteen, or is a party big enough to need a
  -- person -- and no key built from the request alone can tell those two
  -- cases apart. Only the provider could, by not reusing the id.
  --
  -- No provider_call_id means no key and no protection: every call,
  -- retry or not, books a new table. That is honest rather than silent
  -- -- a made-up key would dedupe nothing while looking like it did --
  -- and it is why app/api/agent/reservation/route.ts forwards the
  -- provider's id and docs/vapi-setup.md tells integrators to send it.
  if coalesce(btrim(p_provider_call_id), '') <> ''
     and p_requested_at is not null then
    v_key := md5(
      btrim(p_provider_call_id)                                        || E'\n' ||
      to_char(p_requested_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || E'\n' ||
      p_party_size::text                                               || E'\n' ||
      coalesce(btrim(p_customer_name), '')                             || E'\n' ||
      coalesce(btrim(p_customer_phone), '')
    );
  end if;

  -- Everything below happens under the location's lock. Held until this
  -- transaction commits, so the occupancy this reads cannot change
  -- underneath the insert that follows it -- and so the idempotency
  -- lookup-then-insert is indivisible too: two retries of one tool call
  -- arriving together cannot both conclude they are the first.
  perform pg_advisory_xact_lock(
    hashtext('dialtone.book_table'),
    hashtext(p_location_id::text)
  );

  -- Before the occupancy sweep, not after. A retry must be answered with
  -- the booking it already has even when the restaurant filled up in the
  -- meantime; checking capacity first would refuse a retry with 'full'
  -- and the caller would be told their confirmed table does not exist.
  if v_key is not null then
    select b.id into v_dup_id
      from bookings b
     where b.location_id = p_location_id
       and b.idempotency_key = v_key;

    if found then
      return query select true, true, v_dup_id, null::text;
      return;
    end if;
  end if;

  v_len := make_interval(mins => v_slot);
  v_end := p_requested_at + v_len;

  -- Peak concurrent occupancy across the requested slot. This mirrors
  -- lib/agent/availability.ts's seatsTaken and must keep mirroring it:
  -- if the two ever disagree the agent promises a table the database
  -- refuses, or refuses one it would have taken.
  --
  --   * every booking is modelled as exactly reservation_slot_minutes
  --     long, the same length as the requested slot;
  --   * a booking competes only if its own half-open interval
  --     [start, start + slot) genuinely overlaps the requested one --
  --     `bStart < end and bEnd > start`;
  --   * peak, not sum: two bookings that both overlap the request but
  --     turn the table between themselves never need the same seats at
  --     the same instant, and summing them would refuse a table that is
  --     free;
  --   * ties are broken departures-first (`order by at, delta` puts the
  --     negative delta ahead of the positive one at the same instant),
  --     so a table that turns over at 8:01 is available to a party
  --     arriving at 8:01 and is not counted twice.
  --
  -- `rows between unbounded preceding and current row` is what makes
  -- this a row-by-row running total; the default range frame would fold
  -- every peer at the same instant into one step and lose the tie-break.
  with occupied as (
    select b.requested_at            as starts_at,
           b.requested_at + v_len    as ends_at,
           b.party_size::integer     as party
      from bookings b
     where b.location_id = p_location_id
       and b.status in ('requested', 'confirmed', 'seated')
       and b.requested_at < v_end
       and b.requested_at + v_len > p_requested_at
  ),
  events as (
    select starts_at as at,  party as delta from occupied
    union all
    select ends_at   as at, -party as delta from occupied
  ),
  sweep as (
    select sum(delta) over (
             order by at, delta
             rows between unbounded preceding and current row
           ) as held
      from events
  )
  select coalesce(max(held), 0)::integer into v_peak from sweep;

  if v_peak + p_party_size > v_seats then
    -- The ordinary full house is an answer, not a failure: raising here
    -- would make the caller read an exception to say "we're full".
    return query select false, false, null::uuid, 'full'::text;
    return;
  end if;

  insert into bookings (
    location_id, call_id, customer_name, customer_phone,
    party_size, requested_at, status, idempotency_key
  )
  values (
    p_location_id, p_call_id, p_customer_name, p_customer_phone,
    p_party_size, p_requested_at, 'confirmed', v_key
  )
  returning id into v_id;

  return query select true, false, v_id, null::text;
end;
$$;

-- anon and authenticated are named explicitly, not just PUBLIC: Supabase
-- ships `alter default privileges in schema public grant execute on
-- functions to anon, authenticated, service_role`, so a new function in
-- this schema arrives with those two already holding EXECUTE as grants
-- of their own, which `revoke ... from public` does not touch. The drop
-- above makes that literal rather than theoretical -- this is a brand
-- new pg_proc row, born with the default ACL. Left in place, anybody
-- holding the publishable anon key could POST /rest/v1/rpc/book_table
-- and write a booking into any restaurant's book, because SECURITY
-- DEFINER bypasses the RLS that otherwise stands between them and the
-- bookings table. `create or replace` does not reset an ACL either, so
-- this revoke has to be re-run every time the function is replaced,
-- which is exactly what re-running this migration does.
revoke all on function public.book_table(
  uuid, timestamptz, integer, text, text, uuid, text
) from public, anon, authenticated;

grant execute on function public.book_table(
  uuid, timestamptz, integer, text, text, uuid, text
) to service_role;

-- Turns a silent re-grant into a failed migration, the same guard and
-- the same reasoning as 20260812000300_book_table_hardening.sql and
-- 20260812000400_place_order.sql. pg_default_acl in this database still
-- carries `EXECUTE -> anon, authenticated` for functions created in
-- public, so any future migration that adds or changes a parameter --
-- or drops and recreates book_table again, as this one just did --
-- produces a NEW pg_proc row that inherits those defaults fresh and
-- reopens EXECUTE to the anon key, with nothing before this assert to
-- catch it.
do $$
begin
  assert not has_function_privilege(
    'anon',
    'public.book_table(uuid, timestamptz, integer, text, text, uuid, text)',
    'execute'
  ), 'book_table must not be executable by anon -- pg_default_acl re-grant regression';

  assert not has_function_privilege(
    'authenticated',
    'public.book_table(uuid, timestamptz, integer, text, text, uuid, text)',
    'execute'
  ), 'book_table must not be executable by authenticated -- pg_default_acl re-grant regression';
end;
$$;
