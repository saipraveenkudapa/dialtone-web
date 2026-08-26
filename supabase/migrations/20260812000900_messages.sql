-- messages: what a caller wanted, when the answer is "a person will have
-- to ring you back".
--
-- The owner has narrowed transfers to catering and allergy questions.
-- Everything else that used to reach for the escape hatch -- an angry
-- caller, "let me speak to a manager", a complaint about last Friday's
-- order, speech the agent still cannot make out after asking twice --
-- now has nowhere to go. Without somewhere to put it, each of those
-- calls ends with the agent apologising and the restaurant never
-- learning the call happened: the caller hangs up believing they have
-- been heard, and nobody has heard them. That is a worse outcome than
-- the transfer it replaces, because a failed transfer at least rings a
-- phone.
--
-- So the call becomes a row here. Five facts, which are exactly the five
-- a person taking a message on paper writes down: who called, what
-- number to ring back, what it is about, when it came in, and whether
-- anyone has dealt with it yet.
--
-- Additive only. Nothing existing is altered or dropped; no other table,
-- policy or function is touched.
--
-- ── why a table and not a function ───────────────────────────────────
--
-- `book_table` and `place_order` are Postgres functions because their
-- writes are not single statements: a booking has to count occupancy and
-- insert under one lock, an order has to write its ticket and its lines
-- together or not at all, and both hold seats or money that a retried
-- tool call would double. A message is one INSERT of five plain facts.
-- There is nothing to serialise and nothing to price, so there is no
-- function here, and the route writes the row directly through the
-- service role the way app/api/agent/order/route.ts writes
-- `staff_notified`.
--
-- That leaves retries un-deduplicated, deliberately. A retried tool call
-- can leave two copies of the same message -- but a duplicate message is
-- legible (it carries the same name, number, words and minute, so a
-- human reads it as one message written twice) and costs the restaurant
-- a second glance, whereas a duplicate booking silently holds a table
-- and a duplicate order silently cooks food. Same reasoning as the
-- deliberately-resent staff SMS in the order route: for something a
-- person reads, one copy too many beats none at all.

create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations (id) on delete cascade,

  -- Which call this was taken on. Nullable and ON DELETE SET NULL for
  -- the same reason orders.call_id and bookings.call_id are: the tool
  -- call can arrive before Twilio's webhook has created the calls row,
  -- and a message whose call recording has aged out is still a person
  -- waiting for a callback. The message must outlive the call, never
  -- disappear with it.
  call_id     uuid references calls (id) on delete set null,

  -- Who called and how to reach them, as they said it out loud. Both
  -- nullable at the schema level -- a row that reached this table is
  -- worth keeping even if one of them is missing -- but the tool route
  -- refuses to write a message without both, because a message nobody
  -- can return is not a message.
  caller_name    text check (caller_name is null or char_length(caller_name) <= 200),
  callback_phone text check (callback_phone is null or char_length(callback_phone) <= 40),

  -- What it is about, in the caller's own words. Card-like digit runs
  -- are stripped before this is written (lib/agent/redact.ts, via
  -- lib/agent/messages.ts) exactly as they are for calls.transfer_reason
  -- and calls.transcript -- a caller reading a card number aloud into a
  -- complaint about a charge is the likeliest way one ever reaches this
  -- database, and it must not.
  --
  -- The length cap here is the outer wall, not the working limit: the
  -- route bounds what it writes far shorter (MAX_MESSAGE_LENGTH in
  -- lib/agent/messages.ts). This one exists so no other writer can turn
  -- this column into a transcript dump.
  body text not null check (char_length(btrim(body)) between 1 and 2000),

  -- When the message came in. UTC, like every timestamp here; the
  -- dashboard renders it in the location's own timezone.
  --
  -- There is no separate created_at. The row is written while the caller
  -- is still on the line, so "when the message was taken" and "when the
  -- row was created" are the same instant -- storing it twice would only
  -- create two columns that can disagree about one fact.
  taken_at timestamptz not null default now(),

  -- Whether anyone at the restaurant has actually dealt with it. False
  -- is the honest default: a message that exists and that nobody has
  -- touched is the whole point of the table.
  handled    boolean not null default false,
  handled_at timestamptz,

  -- One fact recorded twice, so a row where the two disagree ("handled,
  -- but never at any particular time") would make either one unusable
  -- for the only query that matters -- what is still outstanding here?
  -- Same shape and same reasoning as orders_staff_notified_consistent
  -- in 20260812000700_staff_notification.sql.
  constraint messages_handled_consistent check (handled = (handled_at is not null))
);

comment on table messages is
  'A message taken for the restaurant during a call, because transfers '
  'are now only for catering and allergy questions. Written by '
  'app/api/agent/message/route.ts during a live call; read and marked '
  'handled by staff in the dashboard.';

comment on column messages.body is
  'What the caller said the message is about, redacted through '
  'lib/agent/redact.ts and length-bounded before it is written. Never a '
  'card number, never a raw transcript.';

comment on column messages.handled is
  'True once someone at the restaurant has dealt with this message. '
  'False means nobody has -- not that the message is invalid.';

-- "What has come in here, newest first" -- the messages screen, and the
-- lookup behind the call detail page.
create index if not exists messages_location_taken_idx
  on messages (location_id, taken_at desc);

create index if not exists messages_call_idx
  on messages (call_id)
  where call_id is not null;

-- "Who is still waiting for a callback?" Partial, so it stays the size
-- of the problem rather than the size of the table -- in a restaurant
-- that works its messages almost every row is handled and out of this
-- index entirely. Same shape as orders_unnotified_idx.
create index if not exists messages_open_idx
  on messages (location_id, taken_at desc)
  where not handled;

-- ── row level security ───────────────────────────────────────────────
--
-- Exactly the pattern in 20260807000200_rls.sql. No table is readable
-- without a policy, so enabling RLS is what makes the default deny; the
-- policies below then open precisely two doors.

alter table messages enable row level security;

-- Staff read their own restaurant's messages and nothing else.
-- `app.can_access_location` is the same membership check every other
-- staff-facing policy uses, so a manager at Nonna Rosa cannot see a
-- message left for Marty's, and neither can a manager at neither.
create policy messages_read on messages
  for select to authenticated
  using (app.can_access_location(location_id));

-- Staff mark a message handled, add to it, correct a misheard number.
-- Update only -- no insert and no delete for authenticated, the same
-- posture `calls` takes ("staff annotate and tag; they do not fabricate
-- call records"). A message is a record of something a caller actually
-- said on a recorded line; a hand-typed one would be indistinguishable
-- from it, and a deleted one is the complaint nobody has to answer for.
-- WITH CHECK repeats the USING clause so a row cannot be updated out of
-- the restaurant that owns it.
create policy messages_update on messages
  for update to authenticated
  using (app.can_access_location(location_id))
  with check (app.can_access_location(location_id));

-- The agent's write path, the same shape as calls_insert_agent,
-- orders_insert_agent and bookings_insert_agent: insert only, scoped to
-- the location in the per-call token. No SELECT -- the agent never needs
-- to read messages back, so a compromised agent token cannot read the
-- restaurant's message book.
create policy messages_insert_agent on messages
  for insert to agent_service
  with check (location_id = app.agent_location());

grant insert on messages to agent_service;

-- Supabase's bootstrap default privileges grant every verb on every new
-- public table to anon and authenticated -- the table analogue of the
-- EXECUTE re-grant that has bitten this branch three times. RLS already
-- denies anon (it has no policy) and already denies staff an insert or a
-- delete (they have no policy for those either), so this changes no
-- outcome today; it makes the grants say the same thing the policies do,
-- so neither can be read as permission the other withholds. Stated
-- explicitly rather than inherited, so a plain Postgres restore of these
-- migrations behaves the same way.
revoke all on messages from anon;
revoke all on messages from authenticated;
grant select, update on messages to authenticated;

-- ── self-check ───────────────────────────────────────────────────────
--
-- The re-grant trap that has fired three times on this branch is about
-- functions, and this migration creates none. The equivalent silent
-- failure for a table is shipping it with RLS off (every tenant reads
-- every other one) or handing the agent role a SELECT it was never meant
-- to have. Both are asserted here, so either becomes a failed migration
-- rather than a discovery.
do $$
begin
  assert (select relrowsecurity from pg_class where oid = 'public.messages'::regclass),
    'messages must have row level security enabled -- without it every tenant reads every other one';

  assert has_table_privilege('agent_service', 'public.messages', 'insert'),
    'agent_service must be able to insert messages';
  assert not has_table_privilege('agent_service', 'public.messages', 'select'),
    'agent_service must not be able to read messages back';
  assert not has_table_privilege('agent_service', 'public.messages', 'update'),
    'agent_service must not be able to update messages';
  assert not has_table_privilege('agent_service', 'public.messages', 'delete'),
    'agent_service must not be able to delete messages';

  assert has_table_privilege('authenticated', 'public.messages', 'select'),
    'staff must be able to read their own restaurant''s messages';
  assert has_table_privilege('authenticated', 'public.messages', 'update'),
    'staff must be able to mark a message handled';
  assert not has_table_privilege('authenticated', 'public.messages', 'insert'),
    'staff must not be able to fabricate a message -- default-privilege re-grant regression';
  assert not has_table_privilege('authenticated', 'public.messages', 'delete'),
    'staff must not be able to delete a message -- default-privilege re-grant regression';

  assert not has_table_privilege('anon', 'public.messages', 'select'),
    'anon must have no reach into messages at all -- default-privilege re-grant regression';
end;
$$;
