import Link from "next/link";
import { Corners } from "@/components/Corners";
import { OrderMoves, OrderMovesRegion } from "@/components/OrderMoves";
import { getCurrentLocation, getOrdersBoard, type BoardOrder } from "@/lib/data";
import {
  ORDER_BOARD_COLUMN,
  ORDER_BOARD_COLUMNS,
  dateTimeIn,
  isPast,
  money,
  relative,
} from "@/lib/format";

export const metadata = { title: "Orders · Dialtone" };

/** The board a kitchen stands in front of.
 *
 *  This page was a stub that said "Not built yet" while real orders were
 *  landing in the table behind it -- a caller ordered $27.00 of food on
 *  the phone, the agent took it, the row was written, and the people who
 *  had to cook it were shown a sentence about a design file. Taking an
 *  order and then hiding it from the restaurant is the most basic
 *  promise this product makes, broken.
 *
 *  Built to design/Dialtone.html's Orders screen, which had been drawn
 *  and never implemented: three columns headed New / In the kitchen /
 *  Ready, each with its count and its own sentence for when it is empty,
 *  and a card per order carrying the number, the type, how long it has
 *  been sitting, the customer and their number, the lines with their
 *  prices, and the total.
 *
 *  Four things on the card are not in that mockup, and each is here
 *  because the data has it and a kitchen needs it:
 *
 *    * THE NOTE ON A LINE. "No onions" is said out loud, confirmed back
 *      to the caller, and stored on the line it belongs to
 *      (20260812000650_place_order_item_notes.sql). It is the difference
 *      between a right and a wrong plate, and the mockup was drawn
 *      before the column existed.
 *    * WHEN IT WAS PROMISED. "By when" is half of the only question this
 *      screen answers, and `promised_at` is what the caller was actually
 *      told.
 *    * WHERE A DELIVERY IS GOING. A delivery ticket without its address
 *      is a meal nobody can deliver -- place_order refuses to write one,
 *      so the screen should not be the place it goes missing.
 *    * THE CALL. The order was taken on the phone; when something on it
 *      reads oddly, the recording is the answer, one click away.
 *
 *  And ONE thing IN the mockup is deliberately not here.
 *
 *    * ITS TOTAL ROW READS "Total · paid by SMS link". Nothing in this
 *      product texts anybody a payment link -- lib/agent/prompt.ts has
 *      the agent say payment is handled at pickup or delivery -- so that
 *      line would tell a kitchen the food is paid for when it is not.
 *      The row says "Total".
 *
 *  THE MOCKUP'S PER-TICKET BUTTON -- "Start cooking", "Mark ready",
 *  "Picked up" -- WAS THE SECOND, AND IS NOW BUILT. It was withheld while
 *  nothing in this repository wrote `orders.status`: place_order wrote
 *  'new' and the only other toucher of the column was the trigger that
 *  LOGS a change something else made, so every genuine order sat in New
 *  and the other two columns stood empty. A button wired to nothing would
 *  have been worse on a pass than no button -- a cook who presses "Start
 *  cooking" and watches the ticket stay put has been told the next cook
 *  knows, and the next cook does not.
 *
 *  What was missing was never the button. It was in the database:
 *  app.log_order_status(), the audit trigger, was not SECURITY DEFINER,
 *  so an owner's UPDATE fired it as the owner, `order_status_events` has
 *  no INSERT policy for `authenticated`, and the whole UPDATE rolled
 *  back. 20260819000100_log_order_status_definer.sql makes that trigger a
 *  definer -- without handing anybody a direct INSERT on the log, which
 *  would let a restaurant author audit rows by hand. With that applied,
 *  <OrderMoves> writes through app/dashboard/orders/actions.ts on the
 *  signed-in user's own session, and says on the card when it could not.
 *  What it was refused with is kept by <OrderMovesRegion>, around the
 *  whole board, because the answer to the press outlives the card: a
 *  ticket somebody else moved first is repainted into another column,
 *  and the sentence has to survive that rather than be reconciled away
 *  with the card it was sitting on.
 *
 *  Read on the signed-in user's own session (lib/data.ts), so RLS
 *  decides what is on it. Nothing here is a platform-admin surface, and
 *  the only write on the page is the one control on each ticket.
 */
export default async function OrdersPage() {
  const location = await getCurrentLocation();
  if (!location) return null; // The layout already explains this case.

  const orders = await getOrdersBoard(location.id);

  const tz = location.timezone;
  const answering = location.is_live && !location.kill_switch_on;

  const columns = ORDER_BOARD_COLUMNS.map((column) => ({
    ...column,
    /* getOrdersBoard hands them over newest first and filtering keeps
       that, so the ticket nobody has read yet is at the top of its
       column. */
    orders: orders.filter((order) => ORDER_BOARD_COLUMN[order.status] === column.key),
  }));

  /* Every order that got a card, and by subtraction the ones that did
     not. Completed and cancelled orders have no column on the approved
     board; they are counted rather than dropped, because a screen that
     silently loses rows is the exact defect this one was built to undo.
     The ids are what <OrderMovesRegion> needs to tell a refused ticket
     that is still on screen from one that has left the board. */
  const onTheBoard = columns.flatMap((column) => column.orders.map((order) => order.id));
  const withheld = orders.length - onTheBoard.length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Orders</h1>
          <div className="text-muted sub">
            landing live from the agent · {tz}
          </div>
          {withheld > 0 ? (
            <div className="text-muted sub">
              {withheld} completed or cancelled{" "}
              {withheld === 1 ? "order is" : "orders are"} not on this board.
            </div>
          ) : null}
        </div>
      </div>

      {/* THE ONE PIECE OF STATE THE BOARD KEEPS FOR ITSELF: what the
          last press was refused with. It is held out here, around both
          branches, and not on the ticket -- because the refusal that
          matters most is the one raised when another screen moved the
          ticket first, and answering that repaints the board and
          reconciles the card into a different column, which would
          destroy a sentence living inside it. `onTheBoard` is every
          order that got a card, so the region can tell a refusal whose
          ticket is still on screen from one whose ticket has gone. */}
      <OrderMovesRegion onBoard={onTheBoard}>
        {orders.length === 0 ? (
          /* The honest first-run sentence. Three columns of "Nothing here."
             would be true and useless; this says what will appear, and
             what has to happen first. */
          <p className="text-muted empty-note">
            {answering
              ? "No orders yet. Every order the agent takes on the phone appears here as it is taken — what to make, who it is for, and when it was promised."
              : "No orders yet — nobody can place one until this restaurant is answering. Turn the agent back on and the first ticket appears here while the caller is still on the line."}
          </p>
        ) : (
          <div className="orders-board">
            {columns.map((column) => (
              <section key={column.key} className="orders-col">
                <div className="orders-col-head">
                  <h4>{column.name}</h4>
                  <span className="text-muted num orders-col-count">
                    {column.orders.length}
                  </span>
                </div>

                {column.orders.length === 0 ? (
                  <p className="text-muted orders-col-empty">{column.emptyNote}</p>
                ) : (
                  column.orders.map((order) => (
                    <Ticket
                      key={order.id}
                      order={order}
                      timezone={tz}
                      /* Past the time the caller was given, and not yet
                         cooked. The mockup marks the same thing off a
                         guessed twenty minutes; `promised_at` is what the
                         caller was actually told, so it is measured
                         against that instead. Not marked in the last
                         column: food waiting on the pass for someone to
                         collect it is not late in the kitchen's sense. */
                      late={
                        column.key !== "ready" &&
                        order.promisedAt !== null &&
                        isPast(order.promisedAt)
                      }
                    />
                  ))
                )}
              </section>
            ))}
          </div>
        )}
      </OrderMovesRegion>
    </>
  );
}

/** One ticket. */
function Ticket({
  order,
  timezone,
  late,
}: {
  order: BoardOrder;
  timezone: string;
  late: boolean;
}) {
  return (
    <article className="card blueprint order-card">
      <Corners />

      <div className="order-head">
        <span className="order-number num">#{order.orderNumber}</span>
        <span className="text-muted order-type">
          {order.type === "delivery" ? "Delivery" : "Pickup"}
        </span>
        {/* The word is inside the chip, so colour never carries the
            meaning on its own -- the rule every other state in this
            product is drawn by (see ORDER_TAG). */}
        <span
          className={
            late ? "order-elapsed num tag tag-out" : "order-elapsed num text-muted"
          }
        >
          {relative(order.placedAt)}
          {late ? " · late" : ""}
        </span>
      </div>

      {/* They ring people back, so the number is on the ticket and not a
          click away. */}
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
              {/* On the line it belongs to, never pooled at the bottom of
                  the card: with three lines on a ticket, a note nobody
                  can attribute is a note nobody can cook to. Already
                  scrubbed of anything card-shaped by getOrdersBoard. */}
              {line.note ? <span className="order-note">{line.note}</span> : null}
            </span>
            <span className="order-price num">{money(line.totalCents)}</span>
          </li>
        ))}
      </ul>

      <div className="order-total">
        <span className="label">Total</span>
        <span className="num">{money(order.totalCents)}</span>
      </div>

      <div className="text-muted order-when">
        <div>
          Placed <span className="num">{dateTimeIn(timezone, order.placedAt)}</span>
        </div>
        {order.promisedAt ? (
          <div>
            Promised{" "}
            <span className="num">{dateTimeIn(timezone, order.promisedAt)}</span>
          </div>
        ) : (
          /* Its own sentence rather than a blank after the label:
             "Promised —" is a gap a reader has to interpret, and
             place_order writes this column on every order it places, so
             an empty one is a fact about the row and not about the food. */
          <div>No promise time recorded</div>
        )}
        {order.type === "delivery" ? (
          <div>
            {/* place_order refuses a delivery with no address, so a blank
                one means the row came from somewhere else. Said out loud
                rather than left as an empty line, because a delivery
                nobody can deliver has to be visible before the food is
                cooked. */}
            Deliver to {order.address ?? "— no address on this order"}
          </div>
        ) : null}
      </div>

      {order.callId ? (
        <Link href={`/dashboard/calls/${order.callId}`} className="row-link">
          Listen to the call
        </Link>
      ) : null}

      {/* Last on the card, as in the mockup: everything above is what the
          ticket IS, and this is the only thing anybody does to it. The
          card knows its own status, which is what the control sends back
          -- so a press carries the column the cook was reading and not
          merely the one they want. */}
      <OrderMoves
        orderId={order.id}
        orderNumber={order.orderNumber}
        status={order.status}
      />
    </article>
  );
}
