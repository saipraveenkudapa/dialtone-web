-- cancel_reservation and change_reservation: the two halves of "Book,
-- change, or cancel a table reservation" that the system prompt has been
-- promising callers since the first version of it, with nothing behind
-- them. Because cancelling is one of the four things the prompt says the
-- agent can do, the prompt's own "transfer anything outside these" rule
-- never fired for it: a caller ringing to cancel got an agent that
-- believed it could help and had no tool to call.
--
-- Three things here, in the order they have to exist:
--
--   1. app.caller_name_key / app.caller_phone_key -- how a spoken name
--      and a spoken number are compared to what is on a booking.
--   2. app.peak_occupancy -- the occupancy sweep, lifted out of
--      public.book_table so changing a booking does not become a THIRD
--      copy of it (lib/agent/availability.ts::seatsTaken is the first,
--      book_table's inline CTE was the second). public.book_table is
--      recreated below to call it, byte-identical in behaviour.
--   3. app.matching_bookings, public.cancel_booking and
--      public.change_booking -- the identification rule and the two
--      writes.
--
-- ── How a caller on the phone identifies their booking ───────────────
--
-- The obvious key is the phone number plus roughly when the table is.
-- That key is not safe. A phone number is not a secret: it is on a
-- business card, in a group chat, on a delivery receipt, and in the
-- caller ID of anyone this person has ever rung. Anyone holding one
-- could then ring the restaurant, say the number and "seven-ish
-- tonight", and empty a stranger's table -- silently, with the
-- restaurant believing the guest cancelled. That is a worse failure than
-- refusing a genuine caller, because the genuine caller gets a human and
-- the victim gets nothing.
--
-- So a booking is identified by THREE independent facts, all of which
-- must line up, plus one the caller cannot influence at all:
--
--   * the location -- taken only from the secret the tool call
--     authenticated with (lib/agent/auth.ts::locationForSecret), never
--     from a request body. A caller who dialled restaurant A cannot
--     reach a booking at restaurant B even with a perfect name, number
--     and time, because p_location_id never comes from anything they
--     said;
--   * the phone number on the booking, compared on its last ten digits
--     so "+1 (510) 555-1014" and "5105551014" are one number;
--   * the first name on the booking, compared case- and
--     punctuation-insensitively, because a caller says "it's Marcus",
--     not "Marcus Webb";
--   * roughly when it is -- within one reservation slot either side of
--     the time the caller gave. A person says "around seven", not
--     19:00:00Z, and the slot is the unit this restaurant already keeps
--     its book in.
--
-- and only ever among bookings that are still live ('requested' or
-- 'confirmed') and still in the future.
--
-- What that refuses, stated plainly, because a rule is only as good as
-- the list of things it says no to:
--
--   * a phone number alone, however obtained -- without the name on the
--     booking AND roughly when it is, nothing matches;
--   * a name alone, likewise;
--   * any booking at any other restaurant, at any time, under any name;
--   * a booking that has already happened. It is not the caller's to
--     touch: the seats are either occupied or gone, and cancelling
--     history only corrupts the restaurant's own record of its night;
--   * a booking already cancelled, seated, or marked no-show;
--   * and -- the case that matters most -- ANY request where more than
--     one booking could be the one meant. Nothing is written and the
--     answer is 'ambiguous', because the whole design of this agent is
--     that it hands the call to a person rather than picking. Guessing
--     here cancels a table belonging to someone who is not on the phone.
--
-- What it deliberately does NOT do is treat a name as a password. Two
-- people called Marcus with the same number and a table the same evening
-- are the ambiguous case, not an authentication decision, and they get a
-- human. This raises the bar from "knows a phone number" to "knows the
-- number, the name and the evening" -- which is what a person who made
-- the booking knows and a person who found the number does not. It is
-- not proof of identity, and it is not sold as one: the fallback for
-- every case it cannot settle is a human, not a guess.

-- ── the two comparison keys ──────────────────────────────────────────

-- Pure, immutable, no table access, and deliberately in `app` (never
-- exposed through PostgREST) rather than public. Both return NULL for
-- anything too thin to identify anyone, and NULL never equals NULL in
-- SQL -- so a booking with no name on it, or a caller who gave no
-- number, matches nothing at all rather than matching everything. That
-- fail-closed direction is the entire reason these return NULL instead
-- of ''.
create or replace function app.caller_phone_key(p_phone text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  -- Last ten digits: the agent hears a number spoken in whatever shape
  -- the caller says it, and the booking may have been written by the
  -- dashboard, by the Python agent, or by create_reservation, each with
  -- its own punctuation and country code. Fewer than seven digits is not
  -- a phone number anyone could be reached on -- it is a fragment the
  -- agent misheard -- and must not be allowed to match a real booking
  -- whose number happens to end the same way.
  select case
           when length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) < 7
             then null
           else right(regexp_replace(p_phone, '[^0-9]', '', 'g'), 10)
         end;
$$;

create or replace function app.caller_name_key(p_name text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  -- First name only, folded to lower case, with anything that is not a
  -- letter or a space removed first, so "O'Brien", "obrien" and
  -- "  O'Brien " agree and "Marcus" matches a booking under "Marcus
  -- Webb". Matching on the whole name would fail the common case -- the
  -- caller gave one name when they booked and both when they rang back,
  -- or the other way round -- and every such failure is a real customer
  -- transferred for nothing.
  select nullif(
    lower(
      split_part(
        btrim(regexp_replace(coalesce(p_name, ''), '[^[:alpha:][:space:]]', '', 'g')),
        ' ', 1
      )
    ),
    ''
  );
$$;

revoke all on function app.caller_phone_key(text) from public, anon, authenticated;
revoke all on function app.caller_name_key(text) from public, anon, authenticated;

-- ── the occupancy sweep, in one place ────────────────────────────────

-- Lifted verbatim out of public.book_table
-- (supabase/migrations/20260812000500_book_table_idempotency.sql), which
-- now calls this instead of carrying its own copy. Changing a booking is
-- a capacity question and needed the same maths; a third implementation
-- of it -- after lib/agent/availability.ts::seatsTaken and book_table's
-- inline CTE -- is three things to keep in step, and the first time any
-- two of them disagreed the agent would promise a table the database
-- refuses, or refuse one it would have taken.
--
-- p_exclude_booking_id is the only thing here that is new, and it is
-- what makes changing a booking possible at all: a booking being moved
-- must not be counted as competing with itself. Without it, moving a
-- table for four from 7:00 to 7:30 in a 90-minute slot would find its own
-- four seats already taken at 7:30 and refuse the move as a full house.
create or replace function app.peak_occupancy(
  p_location_id        uuid,
  p_at                 timestamptz,
  p_slot_minutes       integer,
  p_exclude_booking_id uuid default null
)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with params as (
    select p_at                                          as slot_start,
           p_at + make_interval(mins => p_slot_minutes)  as slot_end,
           make_interval(mins => p_slot_minutes)         as slot_len
  ),
  occupied as (
    select b.requested_at              as starts_at,
           b.requested_at + p.slot_len as ends_at,
           b.party_size::integer       as party
      from bookings b, params p
     where b.location_id = p_location_id
       and b.status in ('requested', 'confirmed', 'seated')
       and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
       and b.requested_at < p.slot_end
       and b.requested_at + p.slot_len > p.slot_start
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
  select coalesce(max(held), 0)::integer from sweep;
$$;

revoke all on function app.peak_occupancy(uuid, timestamptz, integer, uuid)
  from public, anon, authenticated;

-- ── the identification rule, in one place ────────────────────────────

-- Every booking that could be the one the caller means. Both writes
-- below ask this the same question and both refuse to act on more than
-- one answer, so the rule cannot drift between cancelling and changing.
--
-- `b.requested_at > now()` is the future-only rule, and it is here
-- rather than in the routes on purpose: a route can be bypassed by the
-- next caller of this function, and "a past booking is not the caller's
-- to touch" is a property of the book, not of one HTTP endpoint.
create or replace function app.matching_bookings(
  p_location_id uuid,
  p_name_key    text,
  p_phone_key   text,
  p_when        timestamptz,
  p_window      interval,
  p_statuses    text[]
)
returns table (id uuid, requested_at timestamptz, party_size integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select b.id, b.requested_at, b.party_size::integer
    from bookings b
   where b.location_id = p_location_id
     and b.status = any (p_statuses)
     and b.requested_at > now()
     and b.requested_at >= p_when - p_window
     and b.requested_at <= p_when + p_window
     and app.caller_phone_key(b.customer_phone) = p_phone_key
     and app.caller_name_key(b.customer_name)   = p_name_key;
$$;

revoke all on function app.matching_bookings(uuid, text, text, timestamptz, interval, text[])
  from public, anon, authenticated;

-- ── cancel ───────────────────────────────────────────────────────────

-- Lives in public, not app, because it is called through PostgREST and
-- the app schema is deliberately not exposed -- which is what makes the
-- grants at the bottom load-bearing rather than cosmetic. SECURITY
-- DEFINER bypasses RLS, so anybody holding the publishable anon key
-- could otherwise POST /rest/v1/rpc/cancel_booking and cancel tables in
-- any restaurant's book.
create or replace function public.cancel_booking(
  p_location_id    uuid,
  p_customer_name  text,
  p_customer_phone text,
  p_when           timestamptz
)
returns table (
  cancelled         boolean,
  already_cancelled boolean,
  booking_id        uuid,
  booking_at        timestamptz,
  reason            text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_slot      integer;
  v_window    interval;
  v_name_key  text;
  v_phone_key text;
  v_matches   integer;
  v_id        uuid;
  v_at        timestamptz;
begin
  -- The slot length is read from the location row, never taken from the
  -- caller: the caller is a request body away from the phone network,
  -- and the slot is what decides how wide "roughly when" is allowed to
  -- be. A caller-chosen window is a caller-chosen blast radius.
  select l.reservation_slot_minutes into v_slot
    from locations l
   where l.id = p_location_id;

  if not found then
    return query select false, false, null::uuid, null::timestamptz, 'unknown_location'::text;
    return;
  end if;

  v_name_key  := app.caller_name_key(p_customer_name);
  v_phone_key := app.caller_phone_key(p_customer_phone);

  -- Refused before any lookup, not answered with 'not_found'. A missing
  -- name or number is the agent not having asked yet; telling it "no
  -- such booking" would send it on to say so out loud to a caller whose
  -- booking is sitting right there.
  if v_name_key is null or v_phone_key is null or p_when is null then
    return query select false, false, null::uuid, null::timestamptz, 'missing_details'::text;
    return;
  end if;

  v_window := make_interval(mins => v_slot);

  -- The same lock key public.book_table takes, deliberately: a cancel, a
  -- change and a booking at one location serialise against each other,
  -- so seats can never be counted from a book that is being rewritten
  -- underneath the count.
  --
  -- It is also what makes count-then-update indivisible here. Without
  -- it, two retries of one cancel both see exactly one live match, both
  -- run the UPDATE, and the second matches no rows -- returning
  -- `cancelled = true` with a NULL booking id, the same `select ... into`
  -- trap place_order documents at its own v_dup_id.
  perform pg_advisory_xact_lock(
    hashtext('dialtone.book_table'),
    hashtext(p_location_id::text)
  );

  select count(*) into v_matches
    from app.matching_bookings(
      p_location_id, v_name_key, v_phone_key, p_when, v_window,
      array['requested', 'confirmed']
    );

  if v_matches = 0 then
    -- Nothing live matched. Before saying "no such booking", look for
    -- one already cancelled: an LLM retries a tool call after a timeout,
    -- and the first attempt may well have committed. Telling a caller
    -- "I can't find that booking" two seconds after cancelling it is a
    -- worse answer than saying it is cancelled -- which is, after all,
    -- true. No write happens on this path; it only changes the sentence.
    select count(*) into v_matches
      from app.matching_bookings(
        p_location_id, v_name_key, v_phone_key, p_when, v_window,
        array['cancelled']
      );

    if v_matches = 1 then
      select m.id, m.requested_at into v_id, v_at
        from app.matching_bookings(
          p_location_id, v_name_key, v_phone_key, p_when, v_window,
          array['cancelled']
        ) m;
      return query select true, true, v_id, v_at, null::text;
      return;
    end if;

    return query select false, false, null::uuid, null::timestamptz, 'not_found'::text;
    return;
  end if;

  if v_matches > 1 then
    -- Not a guess, not the nearest one, not the first one. Two bookings
    -- could be meant and only one of them is on the phone.
    return query select false, false, null::uuid, null::timestamptz, 'ambiguous'::text;
    return;
  end if;

  select m.id into v_id
    from app.matching_bookings(
      p_location_id, v_name_key, v_phone_key, p_when, v_window,
      array['requested', 'confirmed']
    ) m;

  -- Scoped by location again, and by the same live statuses, even though
  -- the id came from a query that already checked both. A write is not
  -- the place to rely on a previous statement's filter.
  update bookings b
     set status = 'cancelled'
   where b.id = v_id
     and b.location_id = p_location_id
     and b.status in ('requested', 'confirmed')
  returning b.requested_at into v_at;

  if not found then
    return query select false, false, null::uuid, null::timestamptz, 'not_found'::text;
    return;
  end if;

  return query select true, false, v_id, v_at, null::text;
end;
$$;

-- ── change ───────────────────────────────────────────────────────────

-- Changing a booking is a capacity question, so this is not an UPDATE
-- with a new timestamp on it. Freeing the old slot and taking the new
-- one has to be one indivisible act, and it has to answer the same four
-- questions create_reservation answers: is that time in the past, is the
-- restaurant open then, is the party too big, and are there seats.
--
-- Indivisible how, concretely:
--
--   * everything below the advisory lock happens with every other
--     booking, change and cancel at this location held off, so the
--     occupancy this counts cannot move under the UPDATE that follows;
--   * the release and the take are the SAME STATEMENT. There is no
--     moment -- not even inside this transaction -- where the old seats
--     have been given back and the new ones not yet claimed, so a
--     concurrent booker can never slip into a gap this function opened,
--     and a failure partway cannot leave a caller with no table at all;
--   * the old seats are released only in the arithmetic, by excluding
--     this booking from the sweep (app.peak_occupancy's
--     p_exclude_booking_id). If the new time cannot be had, nothing is
--     written and the caller still has exactly the booking they rang up
--     with.
--
-- Past-time and opening hours are checked in front of this, in
-- app/api/agent/change-reservation/route.ts, exactly where
-- create_reservation checks them and for exactly the same reason: hours
-- live in two tables with a holiday override and a timezone, and
-- lib/agent/hours.ts is where that reasoning already exists, tested. A
-- second implementation in SQL would be a third copy of those rules too.
create or replace function public.change_booking(
  p_location_id      uuid,
  p_customer_name    text,
  p_customer_phone   text,
  p_when             timestamptz,
  p_new_requested_at timestamptz,
  p_new_party_size   integer default null
)
returns table (
  changed            boolean,
  already_changed    boolean,
  booking_id         uuid,
  booking_at         timestamptz,
  booking_party_size integer,
  reason             text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_seats     integer;
  v_slot      integer;
  v_max_party integer;
  v_window    interval;
  v_name_key  text;
  v_phone_key text;
  v_matches   integer;
  v_id        uuid;
  v_party     integer;
  v_at        timestamptz;
  v_peak      integer;
begin
  -- Seats, slot length and max party size come from the location row,
  -- never from the caller -- the same rule public.book_table follows, so
  -- a changed booking can never be held to a looser capacity than the one
  -- it was originally taken under.
  select l.seats, l.reservation_slot_minutes, l.max_party_size
    into v_seats, v_slot, v_max_party
    from locations l
   where l.id = p_location_id;

  if not found then
    return query select false, false, null::uuid, null::timestamptz, null::integer,
                        'unknown_location'::text;
    return;
  end if;

  v_name_key  := app.caller_name_key(p_customer_name);
  v_phone_key := app.caller_phone_key(p_customer_phone);

  if v_name_key is null or v_phone_key is null
     or p_when is null or p_new_requested_at is null then
    return query select false, false, null::uuid, null::timestamptz, null::integer,
                        'missing_details'::text;
    return;
  end if;

  v_window := make_interval(mins => v_slot);

  perform pg_advisory_xact_lock(
    hashtext('dialtone.book_table'),
    hashtext(p_location_id::text)
  );

  select count(*) into v_matches
    from app.matching_bookings(
      p_location_id, v_name_key, v_phone_key, p_when, v_window,
      array['requested', 'confirmed']
    );

  if v_matches = 0 then
    -- Same retry reasoning as cancel_booking, one step further along:
    -- once the change has committed, the booking no longer sits at the
    -- time the caller described, so a retried tool call would look for
    -- it at the OLD time and find nothing. Look for it where this
    -- function would have put it instead. No write on this path either.
    select count(*) into v_matches
      from app.matching_bookings(
        p_location_id, v_name_key, v_phone_key, p_new_requested_at, v_window,
        array['requested', 'confirmed']
      ) m
     where m.requested_at = p_new_requested_at
       and (p_new_party_size is null or m.party_size = p_new_party_size);

    if v_matches = 1 then
      select m.id, m.requested_at, m.party_size into v_id, v_at, v_party
        from app.matching_bookings(
          p_location_id, v_name_key, v_phone_key, p_new_requested_at, v_window,
          array['requested', 'confirmed']
        ) m
       where m.requested_at = p_new_requested_at
         and (p_new_party_size is null or m.party_size = p_new_party_size);
      return query select true, true, v_id, v_at, v_party, null::text;
      return;
    end if;

    return query select false, false, null::uuid, null::timestamptz, null::integer,
                        'not_found'::text;
    return;
  end if;

  if v_matches > 1 then
    return query select false, false, null::uuid, null::timestamptz, null::integer,
                        'ambiguous'::text;
    return;
  end if;

  select m.id, m.party_size into v_id, v_party
    from app.matching_bookings(
      p_location_id, v_name_key, v_phone_key, p_when, v_window,
      array['requested', 'confirmed']
    ) m;

  -- A caller who only moves the time never has to restate the party, so
  -- a missing p_new_party_size keeps the size the booking already has.
  v_party := coalesce(p_new_party_size, v_party);

  if v_party < 1 then
    return query select false, false, null::uuid, null::timestamptz, null::integer,
                        'invalid_party'::text;
    return;
  end if;

  if v_party > v_max_party then
    return query select false, false, null::uuid, null::timestamptz, null::integer,
                        'large_party'::text;
    return;
  end if;

  -- Excluding this booking, so it does not compete with itself for the
  -- seats it is already holding. Everything else about the count is
  -- identical to the one book_table does, because it is the same
  -- function.
  v_peak := app.peak_occupancy(p_location_id, p_new_requested_at, v_slot, v_id);

  if v_peak + v_party > v_seats then
    -- An ordinary answer, not a failure: the agent says the new time is
    -- full and offers to keep the old one. The booking is untouched.
    return query select false, false, null::uuid, null::timestamptz, null::integer,
                        'full'::text;
    return;
  end if;

  update bookings b
     set requested_at = p_new_requested_at,
         party_size   = v_party
   where b.id = v_id
     and b.location_id = p_location_id
     and b.status in ('requested', 'confirmed')
  returning b.requested_at, b.party_size::integer into v_at, v_party;

  if not found then
    return query select false, false, null::uuid, null::timestamptz, null::integer,
                        'not_found'::text;
    return;
  end if;

  return query select true, false, v_id, v_at, v_party, null::text;
end;
$$;

-- ── book_table, now sharing the sweep ────────────────────────────────

-- Replaced, not dropped: the signature and the return type are exactly
-- what 20260812000500_book_table_idempotency.sql left, so `create or
-- replace` is legal and -- unlike a drop -- does not mint a fresh
-- pg_proc row carrying pg_default_acl's `EXECUTE -> anon, authenticated`.
-- The revoke and the assert below still run, because `create or replace`
-- does not reset an ACL either and re-running this migration must
-- re-establish it.
--
-- The ONLY behavioural difference from the version above it: the inline
-- peak-occupancy CTE is now a call to app.peak_occupancy, which is that
-- CTE moved unchanged. v_len and v_end went with it -- nothing else in
-- this function used them.
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
  -- not. See 20260812000500_book_table_idempotency.sql for the full
  -- reasoning, including why requested_at is rendered at UTC by hand.
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

  -- Peak concurrent occupancy across the requested slot, in the one
  -- place it now lives (app.peak_occupancy, above). Nothing is excluded:
  -- this booking does not exist yet.
  v_peak := app.peak_occupancy(p_location_id, p_requested_at, v_slot);

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

-- ── grants ───────────────────────────────────────────────────────────

-- anon and authenticated are named explicitly, not just PUBLIC. Supabase
-- ships `alter default privileges in schema public grant execute on
-- functions to anon, authenticated, service_role` -- confirmed live in
-- this database, for owners postgres AND supabase_admin -- so every new
-- function in this schema arrives with those two already holding EXECUTE
-- as grants of their own, which `revoke ... from public` does not touch.
-- cancel_booking and change_booking are brand new pg_proc rows and were
-- born that way. Left in place, anybody holding the publishable anon key
-- could POST /rest/v1/rpc/cancel_booking and empty any restaurant's book,
-- because SECURITY DEFINER bypasses the RLS that otherwise stands
-- between them and the bookings table.
--
-- This trap has already fired twice on this branch (see
-- 20260812000300_book_table_hardening.sql and
-- 20260812000500_book_table_idempotency.sql). It is not theoretical and
-- it is not a formality carried over.
revoke all on function public.cancel_booking(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.cancel_booking(uuid, text, text, timestamptz)
  to service_role;

revoke all on function public.change_booking(
  uuid, text, text, timestamptz, timestamptz, integer
) from public, anon, authenticated;
grant execute on function public.change_booking(
  uuid, text, text, timestamptz, timestamptz, integer
) to service_role;

revoke all on function public.book_table(
  uuid, timestamptz, integer, text, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.book_table(
  uuid, timestamptz, integer, text, text, uuid, text
) to service_role;

-- Turns a silent re-grant into a failed migration, the same guard and
-- the same reasoning as 20260812000300_book_table_hardening.sql,
-- 20260812000400_place_order.sql and
-- 20260812000500_book_table_idempotency.sql. Every function this
-- migration creates or replaces is checked, including the app.* helpers
-- -- they are not reachable through PostgREST today, and asserting it is
-- how that stays true.
do $$
begin
  assert not has_function_privilege(
    'anon', 'public.cancel_booking(uuid, text, text, timestamptz)', 'execute'
  ), 'cancel_booking must not be executable by anon -- pg_default_acl re-grant regression';
  assert not has_function_privilege(
    'authenticated', 'public.cancel_booking(uuid, text, text, timestamptz)', 'execute'
  ), 'cancel_booking must not be executable by authenticated -- pg_default_acl re-grant regression';

  assert not has_function_privilege(
    'anon',
    'public.change_booking(uuid, text, text, timestamptz, timestamptz, integer)',
    'execute'
  ), 'change_booking must not be executable by anon -- pg_default_acl re-grant regression';
  assert not has_function_privilege(
    'authenticated',
    'public.change_booking(uuid, text, text, timestamptz, timestamptz, integer)',
    'execute'
  ), 'change_booking must not be executable by authenticated -- pg_default_acl re-grant regression';

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

  assert not has_function_privilege(
    'anon', 'app.peak_occupancy(uuid, timestamptz, integer, uuid)', 'execute'
  ), 'app.peak_occupancy must not be executable by anon';
  assert not has_function_privilege(
    'authenticated', 'app.peak_occupancy(uuid, timestamptz, integer, uuid)', 'execute'
  ), 'app.peak_occupancy must not be executable by authenticated';

  assert not has_function_privilege(
    'anon',
    'app.matching_bookings(uuid, text, text, timestamptz, interval, text[])',
    'execute'
  ), 'app.matching_bookings must not be executable by anon';
  assert not has_function_privilege(
    'authenticated',
    'app.matching_bookings(uuid, text, text, timestamptz, interval, text[])',
    'execute'
  ), 'app.matching_bookings must not be executable by authenticated';
end;
$$;
