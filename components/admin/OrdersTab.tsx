import { Corners } from "@/components/Corners";
import { OrderRoutingSection } from "@/components/admin/EditSections";
import { ORDER_TAG, dateTimeIn, money } from "@/lib/format";
import type { OrderRow } from "@/lib/supabase/types";

/* Where orders go, then the orders that went there.
 *
 * WHY THESE TWO ARE ONE TAB. "An order never reached us" is one ticket
 * and its two halves were on two routes: the destination was a card on
 * /edit, the last ten orders were a panel on /admin/<id>. The log is the
 * EVIDENCE that the routing setting is right, so reading it beside the
 * setting is the whole job; reading it three clicks away is guesswork.
 *
 * It also settles a vocabulary collision. "Orders" meant the routing
 * setting on one screen and the order log on the other, and an operator
 * asked to "check orders" had to know which screen the asker meant.
 *
 * And it retires the worst single symptom of the rot this pass is
 * about: those ten rows used to render inside .soldout-list /
 * .soldout-row -- the sold-out list's furniture, borrowed for orders
 * because it happened to be the right shape. They are a .table now,
 * which is what a list of records with columns is.
 */
export function OrdersTab({
  locationId,
  timezone,
  orders,
  orderDelivery,
  orderSmsTo,
  orderEmailTo,
  updatedAt,
  hasNumber,
  answering,
}: {
  locationId: string;
  /** The restaurant's own clock, for the Placed column. `placed_at` is
   *  UTC in the database and nobody at a restaurant thinks in it.
   *
   *  REQUIRED, and it was optional for one pass only. The tab that
   *  added the Placed column could not make it required without
   *  breaking a file it did not own, so it shipped optional with a
   *  UTC-and-labelled fallback and a note asking for this. The one call
   *  site -- app/admin/[locationId]/page.tsx, which already computes
   *  `tz` for <CallsTab> two panels up -- now passes it, so the fallback
   *  has no way of being reached and the type says so rather than the
   *  comment. A column headed "Placed" that could be in either of two
   *  clocks depending on a prop nobody had to pass is exactly the
   *  ambiguity the date on these rows exists to end. */
  timezone: string;
  orders: OrderRow[];
  orderDelivery: string;
  orderSmsTo: string | null;
  orderEmailTo: string | null;
  /** locations.updated_at as this page was rendered from. The save is
   *  conditional on it server-side, so a stale tab refuses rather than
   *  putting another operator's change back. */
  updatedAt: string;
  /** Whether this restaurant has a Vapi number yet. It is the SMS
   *  `From` on a kitchen ticket, so without one no ticket can be sent
   *  however good the destination is. */
  hasNumber: boolean;
  /** Live and not killed. Decides which of the two empty-log sentences
   *  is true, off the same row the go-live panel reads. */
  answering: boolean;
}) {
  /* The restaurant's clock, always -- the prop is required now, so
     there is no second branch to keep in step. */
  const placedAt = (iso: string) => dateTimeIn(timezone, iso);

  return (
    <>
      <OrderRoutingSection
        locationId={locationId}
        orderDelivery={orderDelivery}
        orderSmsTo={orderSmsTo}
        orderEmailTo={orderEmailTo}
        updatedAt={updatedAt}
        hasNumber={hasNumber}
      />

      <section id="recent-orders" className="card blueprint setup-card">
        <Corners />
        <h2>Recent orders</h2>
        <p className="text-muted sub">
          The last ten, newest first. This is the record of what the setting above actually did.
        </p>

        {/* When the order came in, in restaurant time.
            WHY THE COLUMN EXISTS AT ALL. These four columns were order
            number, customer, status and total -- not one of them says
            WHEN, so "the last ten, newest first" was an ordering the
            reader had to take on trust, and the ticket this tab is built
            around ("an order never reached us, at about seven last
            night") could not be answered from the log that is supposed
            to be the evidence. A missing timestamp is the same defect as
            a bare "11:09 AM" one panel over, further along.

            First, like the Calls tab's When column one press away: both
            logs are sorted by it, and a sorted list shows its sort key
            first. Absolute and year-bearing -- see dateTimeIn. */}
        {orders.length === 0 ? (
          <p className="text-muted empty-note">
            {answering
              ? "No orders yet. The assistant takes them straight from the call."
              : "No orders yet — nobody can place one until this restaurant is answering."}
          </p>
        ) : (
          /* STACKS ON A PHONE, for the same reason and by the same
             machinery as the call log one press away (.stack-table in
             app/app.css, and the roles are load-bearing there for the
             reason written out in full in CallsTab).

             The Placed column brought the identical defect with it:
             measured at 375px this table fits its 300px box exactly --
             0px hidden -- but "Aug 15, 2026, 10:08 PM" in a 61.1px
             column breaks into four lines and takes the row to 101.4px.
             Nothing was off the right edge here, so nothing was hidden;
             the cost was paid entirely in height. Stacked, the whole
             instant sits on one line of a 145px track.

             Two logs one press apart in one console get one treatment.
             The alternative -- stacking Recent calls because it also
             scrolls sideways and leaving Recent orders to wrap -- would
             have made "how does a log read on a phone" have two answers
             inside one page. */
          <div className="table-scroll">
            <table className="table stack-table" role="table">
              <thead role="rowgroup">
                <tr role="row">
                  <th role="columnheader">Placed</th>
                  <th role="columnheader">Order</th>
                  <th role="columnheader">Customer</th>
                  <th role="columnheader">Status</th>
                  <th role="columnheader">Total</th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {orders.map((o) => (
                  <tr key={o.id} role="row">
                    <td role="cell" className="num">
                      {placedAt(o.placed_at)}
                    </td>
                    <td role="cell" className="num">
                      #{o.order_number}
                    </td>
                    {/* Each of the last three carries the name of its
                        own column, hidden at desktop where the <th>
                        says it and shown at stacked width where the
                        whole <thead> is gone. */}
                    <td role="cell">
                      <span className="cell-label">Customer</span>
                      <span>{o.customer_name ?? "—"}</span>
                    </td>
                    {/* A chip, like every other state in the console.
                        The Calls tab one press away puts a call's
                        outcome through OUTCOME_TAG and the go-live
                        checklist puts its six checks through the same
                        four tags; a bare word here was the one status
                        column in the rebuilt console answering "how is
                        a state shown" differently. The word is inside
                        the chip, so colour is never carrying it. */}
                    <td role="cell">
                      <span className="cell-label">Status</span>
                      <span className={ORDER_TAG[o.status]}>{o.status}</span>
                    </td>
                    <td role="cell" className="num">
                      <span className="cell-label">Total</span>
                      <span>{money(o.total_cents)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
