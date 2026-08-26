-- THE KITCHEN COULD NOT MOVE A TICKET, AND THE REASON WAS NEVER THE
-- BUTTON.
--
-- /dashboard/orders draws the approved board's three columns -- New, In
-- the kitchen, Ready -- and every genuine order sat in the first of them
-- forever. `place_order` writes 'new'; the only other toucher of the
-- column was `orders_log_status`, the trigger that LOGS a change
-- something else made. There was no writer, and the board shipped with no
-- button on purpose while that was true.
--
-- Adding the writer in the web app alone does not work, and this is the
-- whole of why:
--
--   1. an owner UPDATEs orders.status. `orders_rw` allows it -- the row
--      is their restaurant's.
--   2. `orders_log_status` fires AFTER UPDATE OF status. It was NOT
--      security definer, so the trigger function ran as the owner.
--   3. it INSERTs into `order_status_events`, which has RLS enabled, a
--      SELECT policy for `authenticated`, and no INSERT policy for
--      `authenticated` at all.
--   4. the INSERT is refused (42501), and because a trigger runs inside
--      the statement's own transaction, the UPDATE in step 1 rolls back
--      with it.
--
-- So the audit table, which exists to record status changes, was the
-- thing preventing them. A UI-only attempt at this feature fails here
-- every time, and it fails as a write that looks accepted right up until
-- the row does not change.
--
-- THE SAME TRAP IS ON THE AGENT'S SIDE and is closed by the same line.
-- `20260807000200_rls.sql` grants INSERT on `order_status_events` to
-- `agent_service` with the comment "The status trigger writes here on the
-- agent's behalf" -- but it never adds an INSERT POLICY for that role,
-- and RLS denies what no policy allows regardless of the grant. Every
-- agent-side order that reaches the table today does so through
-- `public.place_order`, which is SECURITY DEFINER and so runs this
-- trigger as the definer already. A direct INSERT into `orders` by the
-- Python agent -- which the schema's own header says it makes, and which
-- `app.assign_order_number`'s lock exists to serialise against -- would
-- hit exactly the failure above. That grant is left in place: it is
-- harmless, it is not what this migration is about, and removing a
-- privilege from a service this repository does not migrate is not a
-- change to make on the way past. It is now vestigial, and is recorded
-- here as a finding rather than fixed silently.
--
-- ── the decision: a definer trigger, NOT a grant ─────────────────────
--
-- The other way to close this is `grant insert on order_status_events to
-- authenticated` plus an INSERT policy. That is rejected, and the reason
-- is the integrity of the log. This table is the only record of who moved
-- what and when. A restaurant holding a direct INSERT on it could write
-- audit rows by hand -- claiming a ticket was ready at a time it was not,
-- against a user who never pressed anything -- and every reader of the
-- table, now and later, would have no way to tell those rows from the
-- real ones. A definer trigger keeps every row in this table a
-- CONSEQUENCE of a status change that actually happened, rather than
-- something anybody can author.
--
-- `changed_by` still records the REAL user, and that is checked rather
-- than assumed: `auth.uid()` reads the request's JWT claims out of a GUC
-- (`current_setting('request.jwt.claims', true)::jsonb ->> 'sub'`, see
-- Supabase's own auth schema). SECURITY DEFINER changes `current_user` --
-- who the statement runs AS -- and does not touch that setting, which
-- PostgREST sets per request before the statement runs. The owner who
-- pressed the button is still the uuid in the log; a row written on the
-- agent's path still has no `sub` in its token and so still logs null,
-- exactly as it does today.
--
-- ── WHAT THIS ACTUALLY CHANGES ABOUT WHO MAY WRITE orders.status ─────
--
-- Stated plainly, because it is the privilege delta of this migration and
-- nothing else in the tree records it.
--
-- BEFORE: `orders_rw` (20260807000200_rls.sql:323 -- `for all to
-- authenticated`, using and with check `app.can_access_location`) already
-- permitted the UPDATE. What stopped it was this trigger rolling the
-- statement back, every time, for every authenticated role. So in
-- practice NO signed-in user could change an order's status to anything
-- at all, and none could INSERT a row into `orders` either -- the AFTER
-- INSERT arm died the same way.
--
-- AFTER: that accidental prohibition is gone. A signed-in member of the
-- restaurant can set any of the six values in the `order_status` enum
-- directly, and insert orders, through PostgREST -- the anon key and the
-- session are both in the browser (lib/supabase/client.ts), so this is
-- reachable and not theoretical. RLS still confines every one of those
-- writes to their own restaurant's rows, and every status change is now
-- logged with the uuid that made it.
--
-- THE FOUR MOVES THE BOARD OFFERS ARE AN APPLICATION RULE, NOT A DATABASE
-- ONE. lib/orders/moves.ts is read by app/dashboard/orders/actions.ts
-- before it writes, so that action skips no column and cancels nothing.
-- The database enforces neither. Do not build anything on "an order can
-- never reach 'cancelled'" or "'completed' is only ever reached through
-- the kitchen" -- those are true of that action and of no other caller.
--
-- Not closed with a second trigger, and this is why: the same policy that
-- permits the UPDATE is `for all`, and 20260807000200_rls.sql:374 grants
-- `select, insert, update, delete on all tables in schema public to
-- authenticated`. A member of the restaurant can therefore DELETE the
-- order row outright today, which fires no trigger and leaves no log
-- line -- strictly more destructive than setting their own ticket to
-- 'cancelled', and available before this migration and after it. A
-- transition constraint on `status` alone would be a lock on the window
-- beside an open door, and it would also have to carve out `place_order`
-- and the agent's own inserts to avoid breaking the only writers that
-- exist. If the transitions are ever wanted as a database invariant, the
-- place for them is a BEFORE UPDATE OF status trigger on `orders` that
-- rejects pairs outside the set for non-service roles -- one change,
-- deliberately taken, and not a side effect of this one.
--
-- ── the posture, re-asserted and not merely restated ─────────────────
--
-- Everything below the function body has to be re-run on every replace:
-- CREATE OR REPLACE FUNCTION keeps the existing ACL, so a revoke written
-- in an earlier migration does not cover a body written in this one. Same
-- as app.enforce_staff_pick_cap (20260817000200, 20260818000100) and
-- public.place_order (20260812000400).
--
-- `set search_path` is IN the definition and not left to
-- 20260807000300_realtime_publication.sql's
-- `alter function app.log_order_status() set search_path = public, auth`.
-- That ALTER is superseded here: a SET clause is part of a function's
-- definition, so a CREATE OR REPLACE without one would drop the pinning
-- that migration added and hand a caller the ability to decide what
-- `order_status_events` resolves to -- on a function that now runs as its
-- owner. `pg_temp` is named LAST for the same reason
-- app.enforce_staff_pick_cap names it: the temp schema is searched first
-- for relation names unless it appears explicitly, so listing it at the
-- end is what stops a session-local table called `order_status_events`
-- from shadowing the real one.
create or replace function app.log_order_status()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    insert into order_status_events (order_id, from_status, to_status, changed_by)
    values (new.id, old.status, new.status, auth.uid());
  elsif tg_op = 'INSERT' then
    insert into order_status_events (order_id, from_status, to_status, changed_by)
    values (new.id, null, new.status, auth.uid());
  end if;
  return new;
end;
$$;

-- PUBLIC is named explicitly and not only anon/authenticated: every new
-- function carries an implicit EXECUTE grant to PUBLIC, and PUBLIC's
-- grantee in an ACL is OID 0, which matches no row in pg_roles -- so it
-- drops silently out of any verification query that joins aclexplode
-- (proacl) to that table. anon and authenticated are named because
-- Supabase's `alter default privileges ... grant execute on functions to
-- anon, authenticated, service_role` gives them grants of their own,
-- which `revoke ... from public` does not touch. (That default applies to
-- schema public; app.log_order_status lives in `app`. Named anyway, so
-- this reads the same as every other SECURITY DEFINER function here and
-- so a later `alter default privileges` on `app` cannot quietly change
-- what this migration means.)
--
-- Nothing needs EXECUTE on it. Postgres checks that privilege when a
-- trigger is CREATED, not each time it fires, and `orders_log_status`
-- already exists and is not recreated here.
revoke all on function app.log_order_status() from public, anon, authenticated;

comment on function app.log_order_status() is
  'Audit trigger for orders.status. SECURITY DEFINER since 20260819000100 '
  'because order_status_events has no INSERT policy for authenticated: '
  'without it an owner''s UPDATE fired this as the owner, the log INSERT '
  'was refused, and the UPDATE rolled back with it -- so nothing but a '
  'SECURITY DEFINER function could ever change an order''s status. '
  'Deliberately NOT closed by granting INSERT on the log to anybody: a '
  'direct INSERT would let a restaurant author audit rows by hand, and '
  'this table is the only record of who moved what and when. changed_by '
  'is still auth.uid(), which reads the request JWT and not the function '
  'owner.';
