-- THE AUDIT LOG HAS NEVER BEEN READ, SO NOTHING HAS EVER NOTICED THAT
-- READING IT IS A SEQUENTIAL SCAN.
--
-- `order_status_events` (20260807000100_schema.sql) has a primary key on
-- `id` and a foreign key on `order_id`, and that is all. Postgres does
-- NOT create an index behind a foreign key -- it creates one behind a
-- primary key and a unique constraint, and a REFERENCES clause gets
-- nothing. Every other child table in this schema was given the index
-- its parent lookup needs by hand (`order_items_order_idx`,
-- `call_events_call_idx`); this one was not, and until now that cost
-- nothing at all, because no query in this product had ever asked the
-- table a question. The whole table appeared in the repository only
-- inside comments.
--
-- /dashboard/orders/<id> asks it one, on every open:
--
--   select id, from_status, to_status, changed_by, changed_at
--     from order_status_events
--    where order_id = $1
--    order by changed_at;
--
-- WITHOUT AN INDEX THAT IS A SEQ SCAN OF EVERY STATUS CHANGE EVER MADE
-- BY EVERY RESTAURANT ON THE PLATFORM, to render four rows. The table is
-- not scoped by location or by organization -- its RLS policy reaches the
-- tenant boundary through a join to `orders` -- so it is one shared,
-- append-only, never-pruned table across the whole platform, and it is
-- the fastest-growing one here: roughly four rows per order (placed,
-- started, ready, picked up) against one row per order. A hundred
-- restaurants taking sixty orders a night write about 8.8 MILLION rows a
-- year into it. This is exactly the page that gets slower every week
-- until it times out, and it would do it first for the busiest customer,
-- because every other restaurant's traffic is in the same scan.
--
-- `changed_at` is the second column and not decoration: the read is
-- ordered by it, so with both columns the planner gets the rows already
-- sorted and the ORDER BY is free. It also makes the index cover the
-- lookup's shape exactly -- one order's events, in order, which is the
-- only question anything asks of this table.
--
-- NOT UNIQUE, deliberately. Two status changes on one order inside the
-- same transaction share `now()`, and a unique constraint here would
-- turn an ordinary double-write into a failed UPDATE on `orders` --
-- which is precisely the class of failure 20260819000100 was written to
-- undo. An audit log must never be able to refuse the thing it is
-- auditing.
--
-- A HUMAN APPLIES THIS. Nothing in this repository runs migrations
-- against the production database.
--
-- Nothing else is needed for the history screen. Its list read is
--
--   select ... from orders
--    where location_id = $1 and status in ('completed','cancelled')
--      and placed_at >= $2
--    order by placed_at desc
--    limit 50 offset $3;
--
-- which is `orders_location_status_idx on orders (location_id, status,
-- placed_at desc)`, already in the schema, column for column.
create index if not exists order_status_events_order_idx
  on order_status_events (order_id, changed_at);

comment on index order_status_events_order_idx is
  'One order''s status log, in order -- the only question anything asks '
  'of this table. Added when /dashboard/orders/<id> became the first '
  'reader it has ever had; before that the missing index cost nothing '
  'because nothing looked. The table is platform-wide and append-only '
  '(its tenant boundary is a join to orders, not a column), so an '
  'unindexed lookup is a seq scan of every restaurant''s history to '
  'render one order''s four rows.';
