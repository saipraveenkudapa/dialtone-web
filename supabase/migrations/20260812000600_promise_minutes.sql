-- Per-location, per-order-type promise times.
--
-- app/api/agent/order/route.ts used to hardcode `PROMISED_MINUTES = 25`
-- and hand that same number to every caller, at every restaurant,
-- regardless of order type, order size, or how backed up the kitchen is
-- right now. It is spoken to the caller, written to `orders.promised_at`
-- (public.place_order, 20260812000400_place_order.sql), and printed on
-- the kitchen ticket (lib/agent/notify.ts). A busy kitchen running
-- 45-minute tickets was promising every caller 25 minutes anyway, and the
-- customer who believed it showed up angry -- at the restaurant, not at
-- this codebase.
--
-- Two columns, not one. Pickup and delivery are not the same promise:
-- pickup is prep time plus a wait at the counter, delivery is prep time
-- plus however long a driver takes to get there, and the two routinely
-- differ by fifteen minutes or more at the same kitchen on the same
-- night. A single `promise_minutes` column would force every location
-- that takes both order types to either understate pickup or understate
-- delivery -- the exact bug this migration exists to fix, just moved one
-- level up. This still does not make the promise load-aware (a fixed
-- number per order type, not one that rises as the kitchen backs up) --
-- see the docs/vapi-setup.md gap this migration narrows but does not
-- close.
--
-- Defaults preserve today's behaviour for every existing row: pickup
-- defaults to the same 25 minutes the constant used to hand out
-- unconditionally, and delivery defaults to a realistically longer 45 --
-- both are a starting point for an owner to correct, not a claim that
-- either is right for any specific kitchen. The seeded demo location
-- (a10c0000-0000-0000-0000-00000000000a) takes both defaults; this
-- migration writes no data.
alter table locations
  add column pickup_promise_minutes integer not null default 25
    check (pickup_promise_minutes between 5 and 180),
  add column delivery_promise_minutes integer not null default 45
    check (delivery_promise_minutes between 5 and 180);
