import { Corners } from "@/components/Corners";
import { OrderRoutingSection } from "@/components/admin/EditSections";
import { ORDER_TAG, money } from "@/lib/format";
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
  orders,
  orderDelivery,
  orderSmsTo,
  orderEmailTo,
  updatedAt,
  hasNumber,
  answering,
}: {
  locationId: string;
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

        {orders.length === 0 ? (
          <p className="text-muted empty-note">
            {answering
              ? "No orders yet. The assistant takes them straight from the call."
              : "No orders yet — nobody can place one until this restaurant is answering."}
          </p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="num">#{o.order_number}</td>
                    <td>{o.customer_name ?? "—"}</td>
                    {/* A chip, like every other state in the console.
                        The Calls tab one press away puts a call's
                        outcome through OUTCOME_TAG and the go-live
                        checklist puts its six checks through the same
                        four tags; a bare word here was the one status
                        column in the rebuilt console answering "how is
                        a state shown" differently. The word is inside
                        the chip, so colour is never carrying it. */}
                    <td>
                      <span className={ORDER_TAG[o.status]}>{o.status}</span>
                    </td>
                    <td className="num">{money(o.total_cents)}</td>
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
