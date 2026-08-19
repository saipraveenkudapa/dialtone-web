"use client";

import { useState, useTransition } from "react";
import { moveOrder } from "@/app/dashboard/orders/actions";
import { ORDER_MOVES } from "@/lib/orders/moves";
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
 *  render and the server would refuse cannot exist. */
export function OrderMoves({
  orderId,
  orderNumber,
  status,
}: {
  orderId: string;
  /** Only ever spoken, never shown: on a board of a dozen cards, "Start
   *  cooking" twelve times is not a list anybody can navigate. */
  orderNumber: number;
  status: OrderStatus;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const moves = ORDER_MOVES[status];
  // 'completed' and 'cancelled' have no column on this board, so no card
  // and nothing to press. Nothing is rendered rather than an empty box.
  if (moves.length === 0) return null;

  const press = (to: OrderStatus) =>
    startTransition(async () => {
      const result = await moveOrder(orderId, status, to);
      // Cleared on the way out as well as set: a sentence about the press
      // before last, sitting under a button that has since worked, is a
      // ticket telling a kitchen something that is no longer true.
      setRefusal("error" in result ? result.error : null);
    });

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

      {refusal ? (
        <p className="auth-error" role="status" aria-live="polite">
          {refusal}
        </p>
      ) : null}
    </div>
  );
}
