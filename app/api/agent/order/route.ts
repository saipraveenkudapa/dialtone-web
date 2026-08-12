import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { callIdForProvider } from "@/lib/agent/context";
import { buildOrderLines, priceOrder, type PricedItem, type RequestedItem } from "@/lib/agent/orders";
import { orderMessage, sendOrderSms } from "@/lib/agent/notify";

const PROMISED_MINUTES = 25;

/** place_order. Prices from the live menu, never from what the agent
 *  believes an item costs. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const body = (await request.json().catch(() => ({}))) as {
    items?: RequestedItem[];
    type?: "pickup" | "delivery";
    customer_name?: string;
    customer_phone?: string;
    address?: string;
    provider_call_id?: string;
  };

  if (!body.items || body.items.length === 0) {
    return agentFail("I don't have any items yet.");
  }
  const requestedItems = body.items;

  if (!body.customer_name || !body.customer_phone) {
    return agentFail("I still need a name and a callback number.");
  }

  const type = body.type === "delivery" ? "delivery" : "pickup";
  if (type === "delivery" && location.order_types === "pickup") {
    return agentOk({ placed: false, reason: "no_delivery" });
  }
  if (type === "delivery" && !body.address) {
    return agentFail("I still need the delivery address.");
  }

  const supabase = supabaseAdmin();
  const { data: menu, error: menuError } = await supabase
    .from("menu_items")
    .select("id, name, price_cents, sold_out_until")
    .eq("location_id", location.id);

  if (menuError) {
    console.error("[agent] menu read failed during order", menuError);
    return agentFail("I can't reach the kitchen system right now.", 500);
  }

  const menuItems = (menu ?? []) as PricedItem[];

  // matchItem, the sold-out re-check (a manager can flag an item out
  // from the dashboard while this very call is in progress -- the same
  // reason get_menu checks it too), and quantity validation all live in
  // buildOrderLines (lib/agent/orders.ts) so they can be tested without
  // a database. "unknown_item"/"sold_out" are ordinary outcomes the
  // agent speaks to the caller; "bad_quantity" means the request itself
  // could not be understood, so it is answered like a missing name or
  // phone number -- agentFail, not a menu decision.
  const built = buildOrderLines(menuItems, requestedItems);
  if (!built.ok) {
    if (built.reason === "bad_quantity") {
      return agentFail(
        built.item
          ? `I didn't catch how many ${built.item} you wanted.`
          : "I didn't catch how many of that you wanted.",
      );
    }
    return agentOk({ placed: false, reason: built.reason, item: built.item });
  }
  const lines = built.lines;

  // Every quantity here already passed normaliseQuantity inside
  // buildOrderLines, so priceOrder's own invariant-guard throw is
  // unreachable on this call path.
  const totals = priceOrder(lines, location.tax_rate_bps);

  const { data: order, error } = await supabase
    .from("orders")
    .insert({
      location_id: location.id,
      call_id: await callIdForProvider(location.id, body.provider_call_id),
      customer_name: body.customer_name,
      customer_phone: body.customer_phone,
      type,
      status: "new",
      notes: type === "delivery" ? body.address : null,
      ...totals,
      order_number: 0,
      promised_at: new Date(Date.now() + PROMISED_MINUTES * 60_000).toISOString(),
    })
    .select("id, order_number")
    .single();

  if (error) {
    console.error("[agent] order insert failed", error);
    return agentFail("I couldn't get that order in.", 500);
  }

  const { error: itemsError } = await supabase.from("order_items").insert(
    lines.map((line) => ({
      order_id: order.id,
      menu_item_id: line.item.id,
      name_snapshot: line.item.name,
      price_cents_snapshot: line.item.price_cents,
      quantity: line.quantity,
    })),
  );

  if (itemsError) {
    console.error("[agent] order items insert failed", itemsError);
    return agentFail("I couldn't get that order in.", 500);
  }

  // Best effort, by design: the order row is already committed and on
  // the dashboard by this point, so a failed text must never turn into
  // a failure response -- that would tell a caller their food is not
  // coming when the kitchen already has the ticket. sendOrderSms logs
  // its own failure and never throws; this route's only job is to not
  // treat `false` as an error and to leave its own trace of the miss.
  const smsSent = await sendOrderSms(
    location,
    orderMessage({
      orderNumber: order.order_number,
      type,
      customerName: body.customer_name,
      customerPhone: body.customer_phone,
      lines: lines.map((l) => ({ quantity: l.quantity, name: l.item.name })),
      totalCents: totals.total_cents,
      promisedMinutes: PROMISED_MINUTES,
    }),
  );
  if (!smsSent) {
    console.error("[agent] order placed but staff sms not sent", {
      order_id: order.id,
      order_number: order.order_number,
      location_id: location.id,
    });
  }

  return agentOk({
    placed: true,
    order_number: order.order_number,
    total: `$${(totals.total_cents / 100).toFixed(2)}`,
    promised_minutes: PROMISED_MINUTES,
  });
}
