-- Whether anybody at the restaurant was actually told about an order.
--
-- The staff SMS is the only path from a phone order to a human. The
-- dashboard is not a second channel: app/dashboard/orders/page.tsx is
-- still a stub that says "Not built yet", so an order that fails to text
-- is an order nobody sees. And it fails silently: `sendOrderSms`
-- (lib/agent/notify.ts) returns false when `order_sms_to` or
-- `twilio_number` is unset, when Twilio rejects the message, and when the
-- request to Twilio never completes -- all correctly, because the order
-- is already committed and a failed text must never turn into a failed
-- order. The route logged the miss and told the caller "you're all set"
-- anyway. The log line is in a process nobody reads during service.
--
-- So the outcome goes on the row, where it outlives the request and can
-- be queried: which orders has nobody at this restaurant been told about?
-- That is the question a manager, a support call, or the orders screen
-- (when it exists) actually has to answer, and until now the database
-- could not answer it at all.
--
-- Additive only. Every existing order -- the seeded demo order included
-- -- takes the default and reads as "not notified", which is honestly
-- what we know about them: nothing recorded that they were.

alter table orders
  add column if not exists staff_notified boolean not null default false,
  add column if not exists staff_notified_at timestamptz;

comment on column orders.staff_notified is
  'True once the staff SMS for this order was accepted by Twilio '
  '(lib/agent/notify.ts::sendOrderSms returning true), written by '
  'app/api/agent/order/route.ts after the order itself is committed. '
  'False means no human has been told this order exists -- not that the '
  'order is invalid. NULL is not possible; an order written by any other '
  'path (the dashboard, the Python agent) simply stays false.';

comment on column orders.staff_notified_at is
  'When staff_notified became true, in UTC. NULL exactly when '
  'staff_notified is false.';

-- The two columns are one fact recorded twice, and a row where they
-- disagree ("notified, but never at any particular time") would make
-- either one unusable for the question above. Existing rows all take the
-- defaults false/NULL, which satisfies this, so the constraint validates
-- without a rewrite of anything.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'orders'::regclass
       and conname = 'orders_staff_notified_consistent'
  ) then
    alter table orders
      add constraint orders_staff_notified_consistent
      check (staff_notified = (staff_notified_at is not null));
  end if;
end;
$$;

-- The query this exists for: "what has nobody been told about here?",
-- newest first. Partial, so it stays the size of the problem rather than
-- the size of the orders table -- in a healthy restaurant almost every
-- row is notified and out of this index entirely.
create index if not exists orders_unnotified_idx
  on orders (location_id, placed_at desc)
  where not staff_notified;
