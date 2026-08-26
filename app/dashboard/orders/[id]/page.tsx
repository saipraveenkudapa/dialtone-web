import Link from "next/link";
import { notFound } from "next/navigation";
import { Corners } from "@/components/Corners";
import { getCurrentLocation, getOrderRecord } from "@/lib/data";
import { orderEventActor, orderEventTitle } from "@/lib/orders/history";
import { ORDER_TAG, dateTimeIn, money, relative } from "@/lib/format";

/** ONE ORDER, WHOLE -- AND THE FIRST TIME `order_status_events` HAS EVER
 *  BEEN SHOWN TO ANYBODY.
 *
 *  That table has been written on every status change since the schema's
 *  first migration: order_id, from_status, to_status, changed_by,
 *  changed_at, by a trigger 20260819000100 had to make SECURITY DEFINER
 *  before a cook could move a ticket at all. Nothing in this repository
 *  read a row of it -- a grep found comments and no code. "Who marked
 *  this ready, and when" was recorded, guarded, migrated for, and
 *  unreadable.
 *
 *  Read on the signed-in user's own session. `order_status_events_read`
 *  (20260807000200_rls.sql) is `for select to authenticated using (exists
 *  (select 1 from orders o where o.id = order_id and
 *  app.can_access_location(o.location_id)))`, so an owner may read the
 *  log of their own orders and of nobody else's -- confirmed by reading
 *  that policy rather than assumed. No service role, no platform-admin
 *  gate.
 *
 *  ── WHAT STANDS WHERE `changed_by` IS ───────────────────────────────
 *
 *  A uuid. There is no name to print: `auth.users` is not exposed
 *  through PostgREST and has no policy for `authenticated`, and an
 *  owner's screen may not reach for the platform's service-role key to
 *  look a person up. So this renders the three things the database CAN
 *  supply -- whether it was you, what role a colleague holds, and
 *  whether anybody was signed in at all -- and never the uuid, which is
 *  the shape of a question we could not answer rather than an answer.
 *  The whole argument is on orderEventActor in lib/orders/history.ts.
 *
 *  ── WHAT THIS SCREEN DOES NOT DO ────────────────────────────────────
 *
 *  It writes nothing. The board is the one place in this product that
 *  moves an order, and every refusal sentence a cook is owed lives
 *  there, on the ticket they pressed. A second writer on a record screen
 *  would be a second answer to "what is the kitchen doing", which is the
 *  disagreement the board exists to end.
 *
 *  It is reachable for a LIVE order too, and deliberately so: this is a
 *  page about an order, not about history, and an order half way through
 *  service has a timeline worth reading. Nothing links here from the
 *  board -- a ticket at a pass has exactly the controls it had before
 *  this shipped, and one more tap target beside "Picked up" is the last
 *  thing that screen needs.
 *
 *  Its layout is the call detail page's, class for class: `.split`, two
 *  `.panel`s, the record on the wide side and the facts on the narrow
 *  one. The order card is the board's own `.order-card` furniture -- the
 *  same subject wearing the same clothes, which is the opposite of the
 *  borrowing app.css warns about.
 */
export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Checked before anything is asked of the database, exactly as on the
  // call detail page: a value off the URL that is not a uuid must not
  // reach Postgres to come back as a type error naming a column.
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const location = await getCurrentLocation();
  if (!location) notFound();

  const record = await getOrderRecord(location.id, location.org_id, id);
  // RLS makes "another restaurant's order" and "no such order"
  // indistinguishable, which is what we want: a 404 tells a stranger
  // nothing about whether the row exists.
  if (!record) notFound();

  const { order, events, actors, viewerId } = record;
  const tz = location.timezone;

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/dashboard/orders/history" className="row-link">
            ← Finished orders
          </Link>
          <h1>Order #{order.orderNumber}</h1>
          <div className="text-muted sub">
            {order.type === "delivery" ? "Delivery" : "Pickup"} ·{" "}
            {relative(order.placedAt)} · {tz}
          </div>
        </div>
        <div className="actions">
          {/* The word is inside the chip, so colour never carries the
              meaning on its own -- the rule every other state in this
              product is drawn by (ORDER_TAG). */}
          <span className={ORDER_TAG[order.status]}>{order.status}</span>
        </div>
      </div>

      <div className="split">
        <div className="panel">
          <article className="card blueprint order-card">
            <Corners />

            <div className="order-head">
              <span className="order-number num">#{order.orderNumber}</span>
              <span className="text-muted order-type">
                {order.type === "delivery" ? "Delivery" : "Pickup"}
              </span>
            </div>

            <div className="order-who">
              {order.customerName ?? "No name taken"} ·{" "}
              <span className="num">{order.customerPhone ?? "no number taken"}</span>
            </div>

            <ul className="order-lines">
              {order.lines.map((line) => (
                <li key={line.id} className="order-line">
                  <span className="order-qty num">{line.quantity} ×</span>
                  <span className="order-item">
                    {line.name}
                    {/* On the line it belongs to, never pooled at the
                        bottom of the card -- and on this screen for a
                        second reason: an owner checking a complaint is
                        checking whether the plate matched the note. */}
                    {line.note ? <span className="order-note">{line.note}</span> : null}
                  </span>
                  <span className="order-price num">{money(line.totalCents)}</span>
                </li>
              ))}
            </ul>

            {/* "Total", never the mockup's "Total · paid by SMS link".
                Nothing in this product texts anybody a payment link, and
                this is the screen a dispute gets checked against. */}
            <div className="order-total">
              <span className="label">Total</span>
              <span className="num">{money(order.totalCents)}</span>
            </div>

            <div className="text-muted order-when">
              <div>
                Placed <span className="num">{dateTimeIn(tz, order.placedAt)}</span>
              </div>
              {order.promisedAt ? (
                <div>
                  Promised{" "}
                  <span className="num">{dateTimeIn(tz, order.promisedAt)}</span>
                </div>
              ) : (
                <div>No promise time recorded</div>
              )}
              {order.type === "delivery" ? (
                <div>Deliver to {order.address ?? "— no address on this order"}</div>
              ) : null}
            </div>

            {order.callId ? (
              <Link href={`/dashboard/calls/${order.callId}`} className="row-link">
                Listen to the call
              </Link>
            ) : (
              /* `orders.call_id` is ON DELETE SET NULL, so an order
                 outlives its call -- and a recording ages out long
                 before an argument about the order does. Said out loud,
                 in the same words the message book uses, rather than
                 left as a missing link somebody reads as a fault. */
              <span className="text-muted">No call record</span>
            )}
          </article>
        </div>

        <div className="panel">
          <div className="card blueprint admin-facts">
            <Corners />
            {/* The clock, once, on the card every time in it belongs to
                -- the same header CallTimelineCard carries next door. */}
            <div className="card-kicker">Timeline · {tz}</div>

            {events.length === 0 ? (
              <p className="card-body">
                No status changes recorded for this order. Every move made on the
                board is written here by the database itself, so an order with an
                empty log reached its status some other way.
              </p>
            ) : (
              <dl>
                {events.map((e) => (
                  <div key={e.id} className="fact-row">
                    <dt className="text-muted">{orderEventTitle(e.from, e.to)}</dt>
                    <dd>
                      {/* The whole instant, not timeIn's bare clock: an
                          order placed at 11pm is picked up on the next
                          date, and a timeline is the one place that
                          reads as a contradiction rather than as noise. */}
                      <span className="num">{dateTimeIn(tz, e.changedAt)}</span>
                      <span className="text-muted timeline-delta">
                        {` · ${orderEventActor(e.changedBy, viewerId, actors)}`}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
