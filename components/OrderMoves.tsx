"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { moveOrder } from "@/app/dashboard/orders/actions";
import { MOVE_WRITE_FAILED, ORDER_MOVES } from "@/lib/orders/moves";
import type { OrderStatus } from "@/lib/supabase/types";

/** The control the approved design draws on every ticket, and the
 *  sentence it owes a cook when the press does not land.
 *
 *  design/Dialtone.html ends each card with one full-width button --
 *  "Start cooking", "Mark ready", "Picked up" -- moving the card one
 *  column along. This board shipped without it, deliberately, because
 *  nothing in the product wrote `orders.status`: a cook who presses
 *  "Start cooking" and watches the ticket stay put has been told the next
 *  cook knows, and the next cook does not. There is a writer now
 *  (app/dashboard/orders/actions.ts), so the button is here -- and the
 *  same argument is why the REFUSAL is on the card rather than in a
 *  console. A press that silently fails leaves exactly the lie the button
 *  was withheld to avoid, with a control on top of it.
 *
 *  A client component for that one reason: what a cook has to be told is
 *  what came BACK from the write, and a server-rendered form can only
 *  show that by putting it in the URL, where it outlives the moment it
 *  was true. Same shape as <CallNotes>, one route over -- a transition
 *  around the server action, `.auth-error` for what it refused with.
 *
 *  Which presses exist is not decided here. ORDER_MOVES is the one table,
 *  read again by the action before it writes, so a button this file could
 *  render and the server would refuse cannot exist.
 *
 *  THE SENTENCE DOES NOT LIVE ON THE CARD, and that is the whole reason
 *  <OrderMovesRegion> exists. See the note on it below.
 */

/** One refusal: which ticket it was about, and what the cook is told. */
type OrderRefusal = { orderId: string; orderNumber: number; message: string };

type OrderRefusalStore = {
  refusal: OrderRefusal | null;
  /** null clears it: the answer to the press just made, whatever it was. */
  say: (refusal: OrderRefusal | null) => void;
};

const OrderRefusalContext = createContext<OrderRefusalStore | null>(null);

/** WHY THE REFUSAL IS HELD ABOVE THE BOARD AND NOT ON THE TICKET.
 *
 *  One of the four refusals -- MOVE_ALREADY_MOVED -- is raised by a write
 *  that found no row, which happens when another screen in the same
 *  kitchen moved the ticket first. The action repaints the board before
 *  it answers, because a card left sitting in the wrong column is the
 *  defect this screen exists to prevent. But the repaint moves the card:
 *  app/dashboard/orders/page.tsx renders each column as its own
 *  <section>, so a ticket that changed status is reconciled under a
 *  DIFFERENT PARENT -- React unmounts it and mounts a new one. Any state
 *  inside the card goes with it. Held on the card, the sentence explaining
 *  the repaint would be destroyed by the repaint, and the only cook who
 *  ever needed it -- the one who lost the race -- would watch their card
 *  jump columns and be told nothing.
 *
 *  So the state is held here, wrapping the whole board, where nothing the
 *  server revalidates can reconcile it away. The ticket still RENDERS its
 *  own sentence (see <OrderMoves>), so the words stay under the thumb
 *  that pressed and travel with the card into its new column. This
 *  component draws the sentence itself in the one case where there is no
 *  card left to draw it: the ticket somebody else has already completed,
 *  or an id that was never on this board at all. `onBoard` is what makes
 *  that decision an answer rather than a guess -- the page knows exactly
 *  which orders it drew a card for.
 *
 *  One refusal at a time, on purpose. It is the answer to the press just
 *  made; two stale answers competing on one board is worse than one live
 *  one, and a map keyed by ticket would keep sentences alive for cards
 *  nobody is looking at any more.
 */
export function OrderMovesRegion({
  onBoard,
  children,
}: {
  /** The ids of the orders this board drew a card for. */
  onBoard: readonly string[];
  children: ReactNode;
}) {
  const [refusal, setRefusal] = useState<OrderRefusal | null>(null);
  const store = useMemo<OrderRefusalStore>(
    () => ({ refusal, say: setRefusal }),
    [refusal],
  );

  const orphaned = refusal && !onBoard.includes(refusal.orderId) ? refusal : null;

  return (
    <OrderRefusalContext.Provider value={store}>
      {/* Above the board rather than below it: it is read after a press
          that appeared to do nothing, and the number is how a kitchen
          names a ticket ("#1003"), because the card it belongs to is
          exactly what is no longer on the screen. */}
      {orphaned ? (
        <p className="auth-error" role="status" aria-live="polite">
          #{orphaned.orderNumber}: {orphaned.message}
        </p>
      ) : null}
      {children}
    </OrderRefusalContext.Provider>
  );
}

/** Loud rather than quiet if the board forgets to wrap itself. A missing
 *  provider would otherwise mean a control that swallows its refusals --
 *  the one behaviour this whole file exists to prevent -- and it would
 *  swallow them only on the screen and never in a test. */
function useOrderRefusals(): OrderRefusalStore {
  const store = useContext(OrderRefusalContext);
  if (!store) {
    throw new Error("<OrderMoves> has to be rendered inside <OrderMovesRegion>.");
  }
  return store;
}

export function OrderMoves({
  orderId,
  orderNumber,
  status,
}: {
  orderId: string;
  /** Spoken on every button; printed only when the card carrying it has
   *  gone. On a board of a dozen cards, "Start cooking" twelve times is
   *  not a list anybody can navigate. */
  orderNumber: number;
  status: OrderStatus;
}) {
  const { refusal, say } = useOrderRefusals();
  const [pending, startTransition] = useTransition();

  const moves = ORDER_MOVES[status];
  // 'completed' and 'cancelled' have no column on this board, so no card
  // and nothing to press. Nothing is rendered rather than an empty box.
  if (moves.length === 0) return null;

  const press = (to: OrderStatus) =>
    startTransition(async () => {
      try {
        const result = await moveOrder(orderId, status, to);
        // Cleared on the way out as well as set: a sentence about the
        // press before last, sitting under a button that has since
        // worked, is a ticket telling a kitchen something that is no
        // longer true.
        say("error" in result ? { orderId, orderNumber, message: result.error } : null);
      } catch {
        // THE PRESS THAT NEVER REACHED THE ACTION. A server action is a
        // POST: a tablet at a pass that has wandered off the wifi, a 500,
        // or an action id that no longer resolves after a deploy while
        // this board was left open all rejects here rather than coming
        // back as a result to read. Uncaught, React 19 rethrows a
        // rejected transition into the render pass and -- there being no
        // error boundary over /dashboard -- takes the whole board off the
        // screen. That is worse than the silence the button was withheld
        // to avoid: the cook is not merely told nothing, the ticket
        // disappears. This is the one refusal where pressing again is the
        // right answer, and it says so.
        say({ orderId, orderNumber, message: MOVE_WRITE_FAILED });
      }
    });

  const mine = refusal?.orderId === orderId ? refusal.message : null;

  return (
    <div className="order-moves">
      {moves.map((move) => (
        <button
          key={move.to}
          type="button"
          className={move.direction === "forward" ? "btn btn-secondary" : "btn btn-ghost"}
          aria-label={`${move.label}, order #${orderNumber}`}
          // Both of them, not just the one pressed: mid-service a double
          // press is a thumb resting on a tablet, and the second one
          // would be aimed at a status the card no longer has.
          disabled={pending}
          onClick={() => press(move.to)}
        >
          {move.label}
        </button>
      ))}

      {mine ? (
        <p className="auth-error" role="status" aria-live="polite">
          {mine}
        </p>
      ) : null}
    </div>
  );
}
