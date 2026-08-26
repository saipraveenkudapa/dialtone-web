-- Booking a table atomically.
--
-- create_reservation used to read the overlapping bookings, work out the
-- peak occupancy in TypeScript, and then INSERT. Those are two round
-- trips with no transaction, no row lock and no constraint between them,
-- so two callers after the same last table both read a book with room in
-- it and both write. The re-check narrowed the window; it never closed
-- it. Atomicity only exists in one place, so the decision moves here:
-- one function, one transaction, check and insert together.
--
-- Serialisation is a transaction-scoped advisory lock keyed on the
-- location, so two callers booking the SAME restaurant queue up while
-- two callers booking different restaurants never wait on each other.
-- The lock is taken before the count is read and released by commit
-- after the row is in, which is exactly the window that has to be
-- exclusive. Advisory rather than a constraint because "peak concurrent
-- occupancy over an interval" is not something a unique index or an
-- exclusion constraint can express: seats are fungible, the conflict is
-- an aggregate over a sliding window, not a clash between two rows.
--
-- Lives in public, not app, because it is called through PostgREST and
-- the app schema is deliberately not exposed. That makes the grants
-- load-bearing rather than cosmetic: SECURITY DEFINER bypasses RLS, so
-- execute is revoked from public and given only to service_role, the
-- role the web app's tool endpoint uses. anon and authenticated cannot
-- reach it, and the Python agent (agent_service) does not call it today
-- -- it keeps its RLS-scoped INSERT -- so it is not granted either.
create or replace function public.book_table(
  p_location_id   uuid,
  p_requested_at  timestamptz,
  p_party_size    integer,
  p_customer_name text,
  p_customer_phone text,
  p_call_id       uuid default null
)
returns table (booked boolean, booking_id uuid, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seats     integer;
  v_slot      integer;
  v_max_party integer;
  v_len       interval;
  v_end       timestamptz;
  v_peak      integer;
  v_id        uuid;
begin
  -- seats, slot length and max party size are read from the location
  -- row, never taken from the caller: the caller is a request body away
  -- from the phone network.
  select l.seats, l.reservation_slot_minutes, l.max_party_size
    into v_seats, v_slot, v_max_party
    from locations l
   where l.id = p_location_id;

  if not found then
    return query select false, null::uuid, 'unknown_location'::text;
    return;
  end if;

  if p_party_size is null or p_party_size < 1 then
    return query select false, null::uuid, 'invalid_party'::text;
    return;
  end if;

  if p_party_size > v_max_party then
    return query select false, null::uuid, 'large_party'::text;
    return;
  end if;

  -- Everything below happens under the location's lock. Held until this
  -- transaction commits, so the occupancy this reads cannot change
  -- underneath the insert that follows it.
  perform pg_advisory_xact_lock(
    hashtext('dialtone.book_table'),
    hashtext(p_location_id::text)
  );

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
    return query select false, null::uuid, 'full'::text;
    return;
  end if;

  insert into bookings (
    location_id, call_id, customer_name, customer_phone,
    party_size, requested_at, status
  )
  values (
    p_location_id, p_call_id, p_customer_name, p_customer_phone,
    p_party_size, p_requested_at, 'confirmed'
  )
  returning id into v_id;

  return query select true, v_id, null::text;
end;
$$;

-- anon and authenticated are named explicitly, not just PUBLIC: Supabase
-- ships `alter default privileges in schema public grant execute on
-- functions to anon, authenticated, service_role`, so a new function in
-- this schema arrives with those two already holding EXECUTE as grants
-- of their own, which `revoke ... from public` does not touch. Left in
-- place, anybody holding the anon key could POST /rest/v1/rpc/book_table
-- and write a booking into any restaurant's book, because SECURITY
-- DEFINER bypasses the RLS that otherwise stands between them and the
-- bookings table. `create or replace` does not reset an ACL either, so
-- this revoke has to be re-run every time the function is replaced --
-- which is exactly what re-running this migration does.
revoke all on function public.book_table(
  uuid, timestamptz, integer, text, text, uuid
) from public, anon, authenticated;

grant execute on function public.book_table(
  uuid, timestamptz, integer, text, text, uuid
) to service_role;
