import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk, agentUnauthorised } from "@/lib/agent/respond";
import { parseToolCall } from "@/lib/agent/vapi";
import { callIdForProvider } from "@/lib/agent/context";
import {
  buildOrderLines,
  isRequestedItem,
  normaliseOrderType,
  MAX_ITEM_QUANTITY,
  MAX_ORDER_LINES,
  type PricedItem,
} from "@/lib/agent/orders";
import { orderMessage, sendOrderSms } from "@/lib/agent/notify";
import { openAt, type HolidayRow, type HoursRow } from "@/lib/agent/hours";

/** What `public.place_order` answers with. */
type PlaceOrderResult = {
  placed: boolean;
  duplicate: boolean;
  order_id: string | null;
  order_number: number | null;
  subtotal_cents: number | null;
  tax_cents: number | null;
  total_cents: number | null;
  reason: string | null;
  item: string | null;
};

/** Refusals the agent can say out loud. Every other reason the function
 *  can return describes a request this route has already validated, so
 *  seeing one means the two have drifted apart -- which is a fault to log
 *  and apologise for, not a reason to read to a caller. */
const SPEAKABLE_REFUSALS = new Set(["unknown_item", "sold_out", "no_delivery", "no_pickup"]);

/** place_order. Prices from the live menu, never from what the agent
 *  believes an item costs -- and, since the order and its line items are
 *  one call to `public.place_order`
 *  (supabase/migrations/20260812000400_place_order.sql), never a half
 *  order either.
 *
 *  The write is NOT made here. This used to INSERT the orders row and
 *  then INSERT its order_items as a second round trip with nothing
 *  holding the two together, so a failure on the second left a committed
 *  ticket carrying a real total, a real promise and a real customer, with
 *  no food on it -- the caller was told the order failed, ordered again,
 *  and the kitchen was left with a phantom it could not tell from a
 *  genuine order. Two statements can only be made indivisible inside a
 *  transaction, so both inserts, the pricing, the tax rate, the sold-out
 *  check and the order number now happen inside one function. Nothing
 *  about money is decided from a request body.
 *
 *  What remains here is what the caller has to be told: the validation
 *  that produces a sentence a person can hear, resolving spoken words to
 *  menu ids, and the wording of the answer. */
export async function POST(request: Request) {
  // Parsed before the secret lookup, because the unauthorised branch now
  // needs the toolCallId too -- and `request.json()` may only be consumed
  // once, so this is the single read. `null` rather than `{}` is the
  // honest "no readable body"; parseToolCall branch A handles it.
  const call = parseToolCall(await request.json().catch(() => null));

  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentUnauthorised(call.toolCallId);

  // The model's arguments live inside the tool call, never at the top
  // level of the body -- see lib/agent/vapi.ts.
  const args = call.args as {
    items?: unknown;
    type?: unknown;
    customer_name?: string;
    customer_phone?: string;
    address?: string;
  };

  // Array.isArray, not `.length`: a body of `{"items": {"length": 2}}`
  // satisfies a length check and then throws on `for...of` inside
  // buildOrderLines, and an unwrapped throw in a route becomes a
  // framework 500 -- which Vapi discards entirely, so the caller hears
  // nothing at all -- instead of a `results` envelope carrying a spoken
  // error. No route under app/api/agent/ catches exceptions;
  // they validate up front, so this one does too.
  if (!Array.isArray(args.items) || args.items.length === 0) {
    return agentFail("I don't have any items yet.", call.toolCallId);
  }
  // ...and the same argument one level down, which the check above did
  // not finish making. `Array.isArray` guards the WRAPPER only, so
  // `items:[null]` still threw on `.name` inside buildOrderLines and
  // `items:[{"name":7}]` still threw inside matchItem's `normalise` --
  // both escaping this handler as the framework 500 the comment above
  // exists to prevent, with a caller mid-order on the line. `items` is a
  // JSON.parse of a model-authored argument string, so `as
  // RequestedItem[]` was a promise to the compiler about bytes nobody
  // had looked at; `isRequestedItem` is that promise actually kept, and
  // narrowing through `.every` is what lets the cast go away entirely.
  //
  // Refused rather than skipped: an item silently dropped from a ticket
  // is the failure `bad_note` is refused for, and a caller who says four
  // things and hears three read back has to catch it themselves.
  if (!args.items.every(isRequestedItem)) {
    return agentFail("I didn't catch what you'd like to order.", call.toolCallId);
  }
  const requestedItems = args.items;

  if (!args.customer_name || !args.customer_phone) {
    return agentFail("I still need a name and a callback number.", call.toolCallId);
  }

  // "Delivery", "DELIVERY" and "delivery " all used to fall through to
  // pickup, taking the address with them.
  const type = normaliseOrderType(args.type);
  if (type === null) {
    return agentFail("I didn't catch whether that's for pickup or delivery.", call.toolCallId);
  }

  // Both directions. A location that only delivers was silently accepting
  // pickup orders, which is the same bug as one that only does pickup
  // silently accepting delivery -- and only the second was ever refused.
  if (type === "delivery" && location.order_types === "pickup") {
    return agentOk({ placed: false, reason: "no_delivery" }, call.toolCallId);
  }
  if (type === "pickup" && location.order_types === "delivery") {
    return agentOk({ placed: false, reason: "no_pickup" }, call.toolCallId);
  }
  if (type === "delivery" && !args.address) {
    return agentFail("I still need the delivery address.", call.toolCallId);
  }

  const supabase = supabaseAdmin();
  // The hours are fetched alongside the menu rather than after it -- they
  // are needed either way, and a closed kitchen is not worth a second
  // round trip to discover.
  const [menu, hours, holidays] = await Promise.all([
    supabase
      .from("menu_items")
      .select("id, name, price_cents, sold_out_until")
      .eq("location_id", location.id)
      // Menu order, the same order get_menu reads the items out in. This
      // query never needed one while every answer was about a single
      // item; an ambiguous match now reads a list of names back to the
      // caller, and without an ORDER BY that list is whatever order
      // Postgres happened to return -- so the same question could be
      // asked two different ways on two calls.
      .order("sort_order"),
    supabase.from("hours").select("*").eq("location_id", location.id),
    supabase.from("holiday_hours").select("*").eq("location_id", location.id),
  ]);

  if (menu.error || hours.error || holidays.error) {
    // Only the SQLSTATE. See the place_order log below for why nothing
    // else from a PostgrestError is safe to write down.
    console.error("[agent] menu or hours read failed during order", {
      location_id: location.id,
      code: (menu.error ?? hours.error ?? holidays.error)?.code ?? null,
    });
    return agentFail("I can't reach the kitchen system right now.", call.toolCallId);
  }

  const menuItems = (menu.data ?? []) as PricedItem[];

  // matchItem, quantity validation and the order-size limits all live in
  // buildOrderLines (lib/agent/orders.ts) so they can be tested without a
  // database. Its sold-out check is a fast path, not the authority: the
  // authority is place_order, which re-reads sold_out_until in the same
  // statement that prices the line. This pass is what turns spoken words
  // into the menu ids the function is called with, and what lets an
  // already-flagged item be refused without attempting a write at all.
  //
  // "unknown_item"/"sold_out" are ordinary outcomes the agent speaks to
  // the caller; the rest mean the request itself could not be understood
  // or could not be taken over the phone, so they are answered like a
  // missing name or phone number -- agentFail, not a menu decision.
  const built = buildOrderLines(menuItems, requestedItems);
  if (!built.ok) {
    if (built.reason === "bad_quantity") {
      return agentFail(
        built.item
          ? `I didn't catch how many ${built.item} you wanted.`
          : "I didn't catch how many of that you wanted.",
        call.toolCallId,
      );
    }
    // Not dropped and not cooked as-is: a change the caller heard
    // confirmed back is the whole reason `note` exists, so one that
    // arrived as something other than plain text, or ran on far past
    // anything a person says at a counter, is asked about again rather
    // than quietly thrown away.
    if (built.reason === "bad_note") {
      return agentFail(
        built.item
          ? `I didn't catch the change you wanted on the ${built.item}.`
          : "I didn't catch the change you wanted on that.",
        call.toolCallId,
      );
    }
    if (built.reason === "too_many_items") {
      return agentFail(
        `That's more than ${MAX_ORDER_LINES} different items -- that's too big to take over the phone. Let me put you through to someone.`,
        call.toolCallId,
      );
    }
    if (built.reason === "too_many_of_item") {
      return agentFail(
        `I can only take up to ${MAX_ITEM_QUANTITY} of ${built.item ?? "one item"} over the phone. Let me put you through to someone.`,
        call.toolCallId,
      );
    }
    // More than one thing on this menu answers to what the caller said --
    // "fries" where there are Hand Cut Fries and Cheese Fries. This used
    // to come back as `unknown_item`, so the agent apologised for not
    // selling fries and handed the call to a human, on most calls at a
    // burger shop. The refusal to guess is unchanged; what is new is that
    // the answer says which question to ask and carries the names to ask
    // it with, the way `check_availability` answers a full slot with the
    // times it could offer instead. A `result`, not an `error`: "hand cut
    // or cheese?" is an ordinary thing a host says, not a request nobody
    // could parse.
    if (built.reason === "ambiguous_item") {
      return agentOk({
        placed: false,
        reason: "ambiguous_item",
        // What the caller said. `options` is the complete list of what it
        // could have meant, never truncated -- an option the agent is not
        // told about is one the caller cannot choose, and hiding one is
        // how "which of these did you mean" quietly becomes a guess.
        item: built.item,
        options: built.options,
      }, call.toolCallId);
    }
    return agentOk({ placed: false, reason: built.reason, item: built.item }, call.toolCallId);
  }
  const lines = built.lines;

  // The kitchen has to actually be open. Nothing on this path read the
  // hours: a 3 AM order was priced, written, promised a ready time and
  // confirmed to the caller, with a line in the system prompt as the only
  // guard. Checked here rather than before the menu read so that every
  // "I didn't catch that" answer still comes first -- a caller whose
  // request could not be understood should hear that, not "we're closed"
  // -- and so this sits immediately in front of the write, which is where
  // a gate belongs.
  //
  // `unknown` is let through deliberately (see openAt): a kitchen whose
  // hours cross midnight cannot be represented in this schema, and those
  // are precisely the late-night kitchens that live on phone orders.
  // Refusing every one of their orders, forever and silently, would be a
  // far worse bug than the one this prevents.
  const verdict = openAt({
    at: new Date(),
    timezone: location.timezone,
    hours: (hours.data ?? []) as HoursRow[],
    holidays: (holidays.data ?? []) as HolidayRow[],
  });
  if (verdict.state === "closed") {
    return agentOk({
      placed: false,
      reason: "closed",
      hours_that_day: verdict.hoursThatDay,
    }, call.toolCallId);
  }

  // Per-location, per-order-type: a kitchen quotes pickup and delivery
  // differently, and one restaurant's promise is not another's (a place
  // running 45-minute tickets must not hand out the same number as one
  // running 20). Read from the location row this request already fetched
  // -- never a constant -- so the number spoken to the caller, written to
  // orders.promised_at, and printed on the kitchen ticket are always the
  // same one, and always the one this restaurant actually configured.
  const promisedMinutes =
    type === "delivery" ? location.delivery_promise_minutes : location.pickup_promise_minutes;

  // Ids and quantities only. There is no price and no tax rate in this
  // call: place_order re-reads both from menu_items and locations, which
  // is what "prices from the live menu" has to mean once the write is
  // somewhere a request body can reach.
  const { data, error } = await supabase
    .rpc("place_order", {
      p_location_id: location.id,
      p_item_ids: lines.map((line) => line.item.id),
      p_quantities: lines.map((line) => line.quantity),
      p_type: type,
      p_customer_name: args.customer_name,
      p_customer_phone: args.customer_phone,
      p_address: type === "delivery" ? args.address : null,
      p_call_id: await callIdForProvider(location.id, call.providerCallId),
      // Not the same thing as p_call_id: that is the calls row this order
      // hangs off and is null whenever no webhook has created one yet,
      // while this is the provider's own id for the call in progress and
      // is what makes a retried tool call recognisable as a retry.
      p_provider_call_id: call.providerCallId,
      p_promised_minutes: promisedMinutes,
      // Parallel to the two arrays above, same length and same order:
      // "no onions" belongs to one line, and an off-by-one here puts it
      // on somebody else's pasta. Free text, never priced -- place_order
      // reads no money out of it (see
      // supabase/migrations/20260812000650_place_order_item_notes.sql).
      p_notes: lines.map((line) => line.note),
    })
    .single<PlaceOrderResult>();

  if (error || !data) {
    // The SQLSTATE and nothing else. A PostgrestError's `details` carries
    // Postgres' "Failing row contains (...)" text, which for this table
    // is the customer's name and phone number -- logging the raw error
    // put both into the application log on every failed order. `message`
    // and `hint` are no safer in principle. The code is enough to tell a
    // constraint violation from a connection failure, and the order id is
    // not available on this path by definition.
    console.error("[agent] place_order failed", {
      location_id: location.id,
      code: error?.code ?? null,
    });
    return agentFail("I couldn't get that order in.", call.toolCallId);
  }

  if (!data.placed) {
    if (data.reason && SPEAKABLE_REFUSALS.has(data.reason)) {
      return agentOk({ placed: false, reason: data.reason, item: data.item ?? undefined }, call.toolCallId);
    }
    console.error("[agent] place_order refused for a reason this route should have caught", {
      location_id: location.id,
      reason: data.reason,
    });
    return agentFail("I couldn't get that order in.", call.toolCallId);
  }

  // Best effort, by design: the order row is already committed by this
  // point, so a failed text must never turn into a failure response --
  // that would tell a caller their food is not coming when the order is
  // already in the database. sendOrderSms logs its own failure and never
  // throws; this route's job is to not treat `false` as an error, and to
  // make the miss outlive the request instead of leaving it in a log line
  // nobody reads during service.
  //
  // "Committed" is NOT "somebody knows about it". This text is the only
  // path from a phone order to a human: app/dashboard/orders/page.tsx is
  // still a stub ("Not built yet"), so the dashboard is not a second
  // channel and there is nothing else watching. That is why the outcome
  // is recorded on the row below and reported to the caller-side in the
  // response -- an order the kitchen has never seen must not be answered
  // with "you're all set".
  //
  // Sent on a deduped retry too, deliberately. Suppressing it would mean
  // a retry that happened between the commit and the text -- the widest
  // window there is, a whole round trip to Twilio -- silently leaves an
  // order with no ticket at all, and nothing recovers that. A second copy
  // is legible: it carries the same order number, so the pass can see it
  // is one order, not two.
  const smsSent = await sendOrderSms(
    location,
    orderMessage({
      orderNumber: data.order_number ?? 0,
      type,
      customerName: args.customer_name,
      customerPhone: args.customer_phone,
      address: type === "delivery" ? args.address : null,
      lines: lines.map((l) => ({
        quantity: l.quantity,
        name: l.item.name,
        note: l.note,
      })),
      totalCents: data.total_cents ?? 0,
      promisedMinutes,
    }),
  );
  if (smsSent && data.order_id) {
    // Scoped by location as well as id: every query in this file is
    // scoped to the location the secret resolved to, and a write is not
    // the place to make an exception. Best effort in its own right -- if
    // this update fails the ticket still reached the kitchen, so the
    // caller is told the truth (`staff_notified: true` below) and the
    // failure to write it down is a log line, not a refusal.
    const { error: markError } = await supabase
      .from("orders")
      .update({ staff_notified: true, staff_notified_at: new Date().toISOString() })
      .eq("id", data.order_id)
      .eq("location_id", location.id);
    if (markError) {
      console.error("[agent] could not record staff notification", {
        location_id: location.id,
        code: markError.code,
      });
    }
  } else if (!smsSent) {
    console.error("[agent] order placed but staff sms not sent", {
      order_id: data.order_id,
      order_number: data.order_number,
      location_id: location.id,
    });
  }

  return agentOk({
    placed: true,
    order_number: data.order_number,
    total: `$${((data.total_cents ?? 0) / 100).toFixed(2)}`,
    promised_minutes: promisedMinutes,
    // The one field that says whether a human knows this order exists.
    // False means the order is real and committed but the ticket went
    // nowhere -- the agent must not sign off with "you're all set"; it
    // hands the caller to a person instead (see docs/vapi-setup.md and
    // the "Taking an order" section of lib/agent/prompt.ts). Deliberately
    // not an error: the order is fine, the notification is not.
    staff_notified: smsSent,
  }, call.toolCallId);
}
