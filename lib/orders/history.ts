import type { OrderStatus } from "@/lib/supabase/types";

/** HOW A ROW OF `order_status_events` IS READ OUT LOUD.
 *
 *  That table has been written on every status change since the schema's
 *  first migration -- order_id, from_status, to_status, changed_by,
 *  changed_at -- and until now it was read by nothing at all. It is the
 *  reason 20260819000100 had to make app.log_order_status() SECURITY
 *  DEFINER, and its entire contents were invisible: "who marked this
 *  ready, and when" was recorded and unreadable.
 *
 *  This module is the two translations that make a row of it legible,
 *  and nothing else. It is pure -- the reads are getOrderRecord in
 *  lib/data.ts, the markup is app/dashboard/orders/[id] -- so both
 *  decisions can be pinned by lib/orders/history.test.ts rather than
 *  inferred from rendered HTML.
 *
 *  Beside lib/orders/moves.ts, which is the same kind of file for the
 *  other half of the same table: moves.ts says what a cook may DO to an
 *  order, this says how what they did is read back afterwards.
 */

/** The words for arriving at each status.
 *
 *  A row is a pair of enum values, and a pair of enum values is not a
 *  sentence: "preparing" tells a reader what the order became, not what
 *  somebody did. So each destination gets the words for the press that
 *  reaches it, and where the board has its own words (ORDER_MOVES in
 *  lib/orders/moves.ts) those are the words used -- an owner reading the
 *  log should see the button their cook pressed, in past tense, rather
 *  than a paraphrase of it.
 *
 *  Closed union, like ORDER_MOVES and ORDER_BOARD_COLUMN: a seventh
 *  status added to the schema fails to compile here rather than
 *  rendering as a blank line in an audit log. */
const ORDER_EVENT_REACHED: Record<OrderStatus, string> = {
  new: "Put back to New",
  confirmed: "Confirmed",
  preparing: "Started cooking",
  ready: "Marked ready",
  completed: "Picked up",
  cancelled: "Cancelled",
};

/** What one logged status change SAYS happened.
 *
 *  Keyed on where the order arrived, with two exceptions keyed on where
 *  it came from:
 *
 *    * A null `from` is app.log_order_status's AFTER INSERT arm -- the
 *      order row being created. Whatever status it was created in, the
 *      thing that happened is that the order arrived, and on every order
 *      this product has ever taken that moment is a caller on the phone.
 *    * ready -> preparing is a step BACK, and it must not read as the
 *      "Started cooking" that first put it there. The board offers both
 *      ways back on purpose (see ORDER_MOVES); a log that could not tell
 *      a correction from the move it corrects would make a ticket walked
 *      forward and back read as two identical lines. */
export function orderEventTitle(from: OrderStatus | null, to: OrderStatus): string {
  if (from === null) return "Placed";
  if (from === "ready" && to === "preparing") return "Back in the kitchen";
  return ORDER_EVENT_REACHED[to];
}

/** What `memberships.role` can be -- the `membership_role` enum in
 *  20260807000100_schema.sql. */
export type OrderActorRole = "owner" | "manager";

/** WHAT A RESTAURANT SEES WHERE `changed_by` IS, and why it is never the
 *  uuid.
 *
 *  `order_status_events.changed_by` is `uuid references auth.users (id)`.
 *  On the signed-in owner's own session there is no way to turn that
 *  into a name: `auth.users` is not exposed through PostgREST and carries
 *  no policy for `authenticated`, and this screen is not allowed a
 *  service-role read -- an owner's screen that quietly used the platform
 *  key to look a person up would be a cross-tenant read added to a tenant
 *  page. So a name is not something the database can supply here, and
 *  inventing one would be worse than saying less. The uuid itself is not
 *  an answer either: it is the shape of the fact that we could not
 *  answer, printed at a restaurant.
 *
 *  What the database CAN supply is three true things, and this returns
 *  exactly those:
 *
 *    * WHETHER IT WAS YOU. auth.uid() is the session's own claim, so the
 *      comparison is free and exact.
 *    * WHAT ROLE A COLLEAGUE HOLDS. `memberships` is readable by any
 *      member of the organization (RLS's membership_read_own), and
 *      `role` is `owner` or `manager`. In a restaurant with one owner
 *      "an owner" identifies a person; in one with four managers it
 *      narrows to four. That is less than a name and it is the whole of
 *      what is knowable without one.
 *    * WHETHER ANYBODY WAS SIGNED IN AT ALL. A null uuid is
 *      app.log_order_status running under a token with no `sub` claim,
 *      which is every write on the agent's path: public.place_order is
 *      SECURITY DEFINER and is called with the per-call agent_service
 *      token, so the row it logs names nobody. That is not missing
 *      information -- it is the order being taken on the phone, which is
 *      the first line of every order's timeline.
 *
 *  A uuid with no membership row today held one when it wrote: `orders_rw`
 *  requires org membership to change a status at all. So it is somebody
 *  who has since left, and that is said plainly rather than as
 *  "unknown", which would read as a fault in the log rather than as
 *  staff turnover. */
export function orderEventActor(
  changedBy: string | null,
  viewerId: string | null,
  roles: Readonly<Record<string, OrderActorRole>>,
): string {
  if (changedBy === null) return "the agent, on the call";
  if (viewerId !== null && changedBy === viewerId) return "you";

  const role = roles[changedBy];
  if (role === "owner") return "an owner";
  if (role === "manager") return "a manager";

  return "someone who has left this restaurant";
}
