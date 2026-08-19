"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { passwordIsStillTemporary } from "@/lib/auth/password-gate";
import {
  MOVE_ALREADY_MOVED,
  MOVE_NOT_ALLOWED,
  MOVE_PASSWORD_TEMPORARY,
  isOrderStatus,
  moveRefusal,
  orderMove,
} from "@/lib/orders/moves";
import type { OrderStatus } from "@/lib/supabase/types";

export type MoveOrderResult = { ok: true } | { error: string };

/** Move one ticket one column along -- the writer `orders.status` never
 *  had.
 *
 *  `place_order` wrote 'new' and nothing else in this product ever wrote
 *  the column again, so the board's other two columns could not fill and
 *  every genuine order sat in New forever. The board carried no button
 *  while that was true, on purpose. This is what earns it one.
 *
 *  Written with the user's OWN session, never the service role, so RLS
 *  decides whether this order belongs to a restaurant they work at --
 *  which is the whole authorisation check, and has to be, because a
 *  server function is reachable by a direct POST and not only by the
 *  button that renders above it. An id from another restaurant matches no
 *  row and changes nothing. Same shape as setMessageHandled next door,
 *  and for the same reasons.
 *
 *  `completed_at` is deliberately NOT written alongside 'completed'.
 *  `order_status_events` already records every step with who made it and
 *  when -- that is the whole reason this feature needed a migration --
 *  and a column nothing reads, kept in step by hand from one of two
 *  writers, is a second answer to "when did this order finish" that can
 *  disagree with the first.
 */
export async function moveOrder(
  orderId: string,
  from: OrderStatus,
  to: OrderStatus,
): Promise<MoveOrderResult> {
  // The middleware will not let the board load while the account is still
  // using the password its operator generated -- but this export is an
  // HTTP endpoint of its own, reachable by anyone holding its action id
  // without ever loading that page. That is precisely the hole /signup
  // left open, so the refusal lives in the thing that does the writing.
  if (await passwordIsStillTemporary()) return { error: MOVE_PASSWORD_TEMPORARY };

  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return { error: MOVE_NOT_ALLOWED };

  // Both statuses arrive as strings over the wire. Checked against the
  // schema's own enum first, so a value that is not one never reaches
  // Postgres to come back as a type error naming the column -- and then
  // checked as a PAIR, because this and not the rendered buttons is what
  // decides which status changes this product makes. There is no request
  // that skips the kitchen and none that cancels an order.
  if (!isOrderStatus(from) || !isOrderStatus(to)) return { error: MOVE_NOT_ALLOWED };
  if (!orderMove(from, to)) return { error: MOVE_NOT_ALLOWED };

  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("orders")
    .update({ status: to })
    // Narrowed on the status the cook was looking at as well as on the
    // id. A kitchen runs more than one screen: without this, a press
    // aimed at a card as it used to be would drag a ticket somebody else
    // has already started back out of the kitchen.
    .eq("id", orderId)
    .eq("status", from)
    .select("id");

  if (error) {
    // The SQLSTATE only. A PostgrestError's `details` carries Postgres'
    // "Failing row contains (...)", which for this table is the caller's
    // name and the number they left.
    console.error("[orders] could not move an order", { code: error.code });
    return { error: moveRefusal(error.code) };
  }

  if ((data ?? []).length === 0) {
    // No error and no row: another screen moved it first, or it belongs
    // to a restaurant this account cannot write to and RLS matched
    // nothing. Repaint before answering, so the board the cook reads
    // after the sentence is the truth rather than the card they pressed.
    revalidatePath("/dashboard/orders");
    return { error: MOVE_ALREADY_MOVED };
  }

  // The card has to appear under a different heading now, and the count
  // beside two headings has to change with it. Nothing on this page costs
  // anything to re-render -- unlike the call screen, whose repaint remints
  // a signed recording URL.
  revalidatePath("/dashboard/orders");
  return { ok: true };
}
