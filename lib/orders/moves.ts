import type { OrderStatus } from "@/lib/supabase/types";

/** WHAT A COOK MAY DO TO A TICKET, and the words the button wears.
 *
 *  This is the writer `orders.status` never had. `place_order` writes
 *  'new'; the only other toucher of the column was the trigger that LOGS
 *  a change something else made, so until this shipped, two of the
 *  approved board's three columns could not fill and every order a
 *  restaurant had ever taken piled into the first. The board deliberately
 *  carried no button while that was true -- a cook who presses "Start
 *  cooking" and watches the ticket stay put has been told the next cook
 *  knows, and the next cook does not.
 *
 *  KEYED ON THE CURRENT STATUS, not on the board column, and that is what
 *  makes it safe to drive from a browser. The client sends the status the
 *  cook was looking at and the status they want; the server looks the pair
 *  up HERE before it writes. So there is no request MOVEORDER ACCEPTS
 *  that sets an order to an arbitrary value, none that goes from 'new'
 *  straight to 'completed' skipping the kitchen, and none that reaches
 *  'cancelled' at all -- cancelling somebody's dinner is not a thing that
 *  should happen because a thumb landed on a tablet at the pass, and this
 *  board does not offer it.
 *
 *  THAT IS A RULE ABOUT THIS ACTION AND NOT ABOUT THE DATABASE, and the
 *  difference matters to anyone reading this table as a guarantee.
 *  `orders_rw` is `for all to authenticated`, so a signed-in member of
 *  the restaurant holds a direct UPDATE on its own orders through
 *  PostgREST with the anon key that is already in their browser; since
 *  20260819000100 made the audit trigger a definer, that write is no
 *  longer rolled back. The header of that migration records the whole
 *  privilege delta. What this table decides is what THIS product writes.
 *
 *  Closed union, like ORDER_BOARD_COLUMN in lib/format.ts: a seventh
 *  status added to the schema fails to compile here rather than quietly
 *  arriving with no moves and no button. */

export type OrderMoveDirection = "forward" | "back";

export type OrderMove = {
  /** The status this press writes. */
  to: OrderStatus;
  /** What the button says. The three forward words are the approved
   *  mockup's own (design/Dialtone.html's Orders screen). */
  label: string;
  direction: OrderMoveDirection;
};

/** GOING BACK IS OFFERED, and it is offered from exactly the two columns
 *  that have a column behind them.
 *
 *  A ticket started by mistake is an ordinary mid-service event: two
 *  cooks, one tablet at the pass, a thumb on the wrong card. Without a
 *  way back, the only correction available is the one this whole screen
 *  exists to prevent -- the board saying one thing and the kitchen doing
 *  another. Nothing is destroyed by it either: `order_status_events`
 *  records every step with who made it and when, so a ticket walked
 *  forward and back reads as a correction that somebody made, at a time,
 *  rather than as a status that was quietly rewritten. That is now a
 *  statement about a screen and not only about a table --
 *  /dashboard/orders/<id> renders the log, and orderEventTitle in
 *  lib/orders/history.ts is what keeps the step back from reading as the
 *  step it undoes.
 *
 *  Not offered from New, which has nothing behind it. Not offered on a
 *  ticket that has left the board: 'completed' and 'cancelled' have no
 *  column on the approved design, so there is no card to press -- which
 *  means "Picked up" is the one press on this board that cannot be
 *  undone from it. That is stated rather than hidden, and it is no
 *  longer only a count: the board says out loud how many completed or
 *  cancelled orders it is not showing AND links to them, so a mis-press
 *  is now a named order on /dashboard/orders/history whose timeline says
 *  who pressed it and at what minute. Undoing it is still not something
 *  this product does -- that would want a move out of 'completed', which
 *  this table deliberately does not offer -- but finding it is no longer
 *  guesswork. */
export const ORDER_MOVES: Record<OrderStatus, readonly OrderMove[]> = {
  new: [{ to: "preparing", label: "Start cooking", direction: "forward" }],
  /* 'confirmed' shares the board's first column with 'new': both mean a
     ticket nobody has started cooking, so both offer the same press.
     Nothing in this product writes it today, which is exactly why the
     step BACK out of the kitchen writes 'new' and not 'confirmed' --
     'new' is the one value that column is ever actually populated with,
     and inventing the other on the way back would put a ticket into a
     state no writer in this system has ever produced. */
  confirmed: [{ to: "preparing", label: "Start cooking", direction: "forward" }],
  preparing: [
    { to: "ready", label: "Mark ready", direction: "forward" },
    { to: "new", label: "Not started after all", direction: "back" },
  ],
  ready: [
    { to: "completed", label: "Picked up", direction: "forward" },
    { to: "preparing", label: "Back in the kitchen", direction: "back" },
  ],
  completed: [],
  cancelled: [],
};

/** The one move that gets an order from `from` to `to`, or null when the
 *  board offers no such move.
 *
 *  The server calls this before it writes, so this function -- and not
 *  the buttons a page happened to render -- is what decides whether a
 *  status change is one this product makes. A "use server" export is a
 *  live HTTP endpoint from the moment it compiles. */
export function orderMove(from: OrderStatus, to: OrderStatus): OrderMove | null {
  return ORDER_MOVES[from]?.find((move) => move.to === to) ?? null;
}

/** Whether a string off the wire names a status at all. ORDER_MOVES is
 *  keyed on the whole enum, so its own keys are the list -- there is no
 *  second copy of the enum here to drift from the schema. */
export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && Object.hasOwn(ORDER_MOVES, value);
}

/* ── what a cook is told when the ticket does not move ───────────────
 *
 * THE REFUSAL PATH IS THE ONE THAT MATTERS. A card that stays where it
 * was and says nothing has told a cook the next cook knows, which is the
 * exact failure the missing button was withheld to avoid -- and shipping
 * the button and then swallowing its errors would be that failure with a
 * control on top of it. Every path out of moveOrder that did not write
 * ends in one of these sentences, rendered on the ticket itself.
 *
 * None of them is the database's own sentence. A PostgrestError's
 * message, details and hint name columns, constraints and sometimes the
 * failing row -- which for `orders` is the caller's name and their phone
 * number. Only `code` is ever read, exactly as lib/menu.ts's pickRefusal
 * reads it. */

/** Quoted from app/dashboard/calls/actions.ts on purpose: one rule, one
 *  sentence, wherever an account that has not finished its handover
 *  tries to write. */
export const MOVE_PASSWORD_TEMPORARY =
  "Set your own password before changing anything here.";

/** Not a step this board takes. Reachable in the ordinary product only by
 *  a form that has been open since before a deploy; reachable at any time
 *  by a POST straight at the action. Either way the answer is the same
 *  and nothing is written. */
export const MOVE_NOT_ALLOWED = "That is not a move this board makes.";

/** The ticket was not where the cook was looking at it -- somebody else
 *  moved it first, or it belongs to a restaurant this account cannot
 *  write to and RLS matched no row. Those are two different facts and the
 *  browser cannot tell them apart, so the sentence claims neither: it
 *  says what is certainly true, which is that the board in front of them
 *  is now the truth and the one they pressed was not. */
export const MOVE_ALREADY_MOVED =
  "This ticket had already moved. The board is up to date now — read it again before pressing.";

/** The database refused the write outright: SQLSTATE 42501, which is what
 *  both a missing grant and a row-level security policy raise.
 *
 *  Its own sentence, and NOT "check the connection", because that would
 *  send a kitchen looking for a fault they do not have and cannot fix.
 *  This is the state of a database on which
 *  20260819000100_log_order_status_definer.sql has not been applied: the
 *  UPDATE on `orders` is allowed, the audit trigger then fires as the
 *  signed-in user, `order_status_events` has no INSERT policy for
 *  `authenticated`, and the whole transaction rolls back. Every press
 *  fails the same way until a human applies that migration, so the
 *  sentence says pressing again will not help. */
export const MOVE_REFUSED_BY_DATABASE =
  "This restaurant’s system will not let the board move orders. Pressing again will not help — " +
  "tell Dialtone.";

/** Anything else: a dropped connection, a timeout, a database that is not
 *  there. The one refusal where pressing again is the right answer. */
export const MOVE_WRITE_FAILED = "That did not move. Check the connection and press again.";

/** The SQLSTATE, turned into the sentence that names what actually
 *  stopped the write. Mapped rather than guessed, exactly as
 *  lib/menu.ts's pickRefusal maps 23514 and 23505. */
export function moveRefusal(code: string | null | undefined): string {
  if (code === "42501") return MOVE_REFUSED_BY_DATABASE;
  return MOVE_WRITE_FAILED;
}
