#!/usr/bin/env node
/* Drive every tool endpoint the way the voice platform will, against the
   live database.

   AGENT_SECRET=...            secret for the demo location (required)
   CANARY_SECRET_ISOLATED=...  secret for a second, throwaway location
                                whose menu holds one item the demo
                                location's menu does not (required for
                                the cross-tenant isolation checks)
   CANARY_SECRET_KILLSWITCH=narrower secret for a throwaway location with
                                kill_switch_on = true (required for the
                                assistant fail-closed checks)
   CANARY_SECRET_NOTLIVE=...   secret for a throwaway location with
                                is_live = false (required for the same)

   node scripts/exercise-tools.mjs [base-url]

   The three CANARY_* secrets belong to locations this script does not
   own the lifecycle of -- they are provisioned and torn down around a
   run of this script, not by it. Every write this script itself causes
   (an order, a booking) is left in the database on exit; the caller is
   expected to know what it created and remove exactly that, the same
   way Task 14's own cleanup step does.
*/
const base = process.argv[2] ?? "http://localhost:3000";
const secret = process.env.AGENT_SECRET;
const isolatedSecret = process.env.CANARY_SECRET_ISOLATED;
const killSwitchSecret = process.env.CANARY_SECRET_KILLSWITCH;
const notLiveSecret = process.env.CANARY_SECRET_NOTLIVE;

if (!secret) {
  console.error("set AGENT_SECRET to the value from set-agent-secret.mjs");
  process.exit(1);
}
if (!isolatedSecret || !killSwitchSecret || !notLiveSecret) {
  console.error(
    "set CANARY_SECRET_ISOLATED, CANARY_SECRET_KILLSWITCH and CANARY_SECRET_NOTLIVE " +
      "to the secrets of the three throwaway locations this run needs " +
      "(see the task-14 report for how they were provisioned).",
  );
  process.exit(1);
}

const call = async (path, body, headerSecret = secret) => {
  const res = await fetch(`${base}/api/agent/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(headerSecret ? { "x-dialtone-secret": headerSecret } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// Track exactly what this run creates so the report can state precisely
// what needs to be cleaned up, and so a human can double check nothing
// else moved.
const created = { orders: [], bookings: [] };

// ── Auth ────────────────────────────────────────────────────────────

const noAuth = await call("menu", {}, null);
check("unauthenticated menu is rejected", noAuth.status === 401);

const badAuth = await call("menu", {}, "wrong-secret");
check("wrong secret is rejected", badAuth.status === 401);

// ── Menu ────────────────────────────────────────────────────────────

const menu = await call("menu", { item: "Squid Ink Tonnarelli" });
check("menu returns categories", Array.isArray(menu.body?.categories));
check(
  "menu marks sold out items",
  (menu.body?.sold_out ?? []).includes("Squid Ink Tonnarelli") &&
    (menu.body?.sold_out ?? []).includes("Bistecca, 32oz"),
  JSON.stringify(menu.body?.sold_out),
);
check(
  "menu suggests an alternative",
  typeof menu.body?.alternative === "string" && menu.body.alternative.length > 0,
  String(menu.body?.alternative),
);

// Cross-tenant isolation. A secret decides the location for every tool
// call (lib/agent/auth.ts::locationForSecret) -- nothing in a request
// body can move it. Proving this from the outside means fetching two
// different locations' menus with two different secrets and checking
// each side only ever sees its own data, not asserting on the auth
// function's source.
const demoMenu = await call("menu", {});
const canaryMenu = await call("menu", {}, isolatedSecret);
const demoItemNames = (demoMenu.body?.categories ?? []).flatMap((c) =>
  c.items.map((i) => i.name),
);
const canaryItemNames = (canaryMenu.body?.categories ?? []).flatMap((c) =>
  c.items.map((i) => i.name),
);
check(
  "demo secret cannot see the canary location's menu item",
  !demoItemNames.includes("Zzyzx Canary Special"),
  JSON.stringify(demoItemNames),
);
check(
  "canary secret sees its own item and none of the demo menu",
  canaryItemNames.includes("Zzyzx Canary Special") &&
    !canaryItemNames.some((n) => demoItemNames.includes(n)),
  JSON.stringify(canaryItemNames),
);

// ── Hours ───────────────────────────────────────────────────────────

const hours = await call("hours", {});
check(
  "hours answers open_now",
  typeof hours.body?.open_now === "boolean",
  `today: ${hours.body?.today}`,
);

// ── Availability ────────────────────────────────────────────────────

const when = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const avail = await call("availability", { requested_at: when, party_size: 2 });
check("availability answers", typeof avail.body?.available === "boolean");

// The brief only checked `available === false` for an oversized party.
// The route now answers with a distinct, speakable reason
// (app/api/agent/availability/route.ts) rather than folding it into the
// same "no tables" answer a full house gets -- an agent needs to say
// something different to a party of 99 than to a party of 2 that just
// didn't fit.
const huge = await call("availability", { requested_at: when, party_size: 99 });
check(
  "oversized party is refused with a distinct reason",
  huge.body?.available === false && huge.body?.reason === "large_party",
  JSON.stringify(huge.body),
);

// Past times are refused outright now (lib/agent/availability.ts::isRequestInPast),
// not answered with `available: false` -- a caller asking about a moment
// already gone should never hear a confident answer either way.
const pastWhen = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
const pastAvail = await call("availability", { requested_at: pastWhen, party_size: 2 });
check(
  "past availability request is refused, not answered",
  pastAvail.status === 400 && pastAvail.body?.ok === false,
  JSON.stringify(pastAvail.body),
);

// ── Reservation ─────────────────────────────────────────────────────

const reservationWhen = new Date(Date.now() + 26 * 3600 * 1000).toISOString();
const booking = await call("reservation", {
  requested_at: reservationWhen,
  party_size: 2,
  customer_name: "Task14 QA Caller",
  customer_phone: "+15105551014",
});
check("reservation books", booking.body?.booked === true, booking.body?.when);
if (booking.body?.booked && booking.body?.booking_id) {
  created.bookings.push(booking.body.booking_id);
}

// The capacity decision now lives in public.book_table
// (supabase/migrations/20260812000200_book_table.sql), which serialises
// on the location and counts peak occupancy under that lock rather than
// the route reading-then-writing in two round trips. This run does not
// try to exhaust the demo location's 40 seats -- that would mean leaving
// dozens of throwaway bookings against real seeded data -- so what is
// checked here is the same fail-closed shape the availability endpoint
// gets: a request for a time already past is refused before book_table
// is ever called.
const pastReservation = await call("reservation", {
  requested_at: pastWhen,
  party_size: 2,
  customer_name: "Task14 QA Caller",
  customer_phone: "+15105551014",
});
check(
  "reservation for a past time is refused",
  pastReservation.status === 400 && pastReservation.body?.ok === false,
  JSON.stringify(pastReservation.body),
);

const oversizedReservation = await call("reservation", {
  requested_at: reservationWhen,
  party_size: 99,
  customer_name: "Task14 QA Caller",
  customer_phone: "+15105551014",
});
check(
  "reservation for an over-max party is refused before booking",
  oversizedReservation.status === 400 && oversizedReservation.body?.ok === false,
  JSON.stringify(oversizedReservation.body),
);

// ── Order ───────────────────────────────────────────────────────────

const order = await call("order", {
  items: [{ name: "Cacio e Pepe", quantity: 2 }],
  type: "pickup",
  customer_name: "Task14 QA Caller",
  customer_phone: "+15105551014",
});
check(
  "order is placed",
  order.body?.placed === true,
  `#${order.body?.order_number} ${order.body?.total}`,
);
if (order.body?.placed && order.body?.order_number) {
  created.orders.push(order.body.order_number);
}

const soldOut = await call("order", {
  items: [{ name: "Squid Ink Tonnarelli", quantity: 1 }],
  type: "pickup",
  customer_name: "Task14 QA Caller",
  customer_phone: "+15105551014",
});
check(
  "sold out item is refused, distinctly from unknown",
  soldOut.body?.reason === "sold_out" && soldOut.body?.item === "Squid Ink Tonnarelli",
  JSON.stringify(soldOut.body),
);

const unknown = await call("order", {
  items: [{ name: "Chicken Tikka Masala", quantity: 1 }],
  type: "pickup",
  customer_name: "Task14 QA Caller",
  customer_phone: "+15105551014",
});
check(
  "unknown item is refused, distinctly from sold out",
  unknown.body?.reason === "unknown_item",
  JSON.stringify(unknown.body),
);

// Order type mismatch. The demo location is pickup-only
// (order_types = 'pickup'), so a delivery request must be refused by
// name, not silently accepted as pickup or 500ing.
const wrongType = await call("order", {
  items: [{ name: "Cacio e Pepe", quantity: 1 }],
  type: "delivery",
  customer_name: "Task14 QA Caller",
  customer_phone: "+15105551014",
  address: "123 Test St",
});
check(
  "delivery order is refused at a pickup-only location",
  wrongType.body?.placed === false && wrongType.body?.reason === "no_delivery",
  JSON.stringify(wrongType.body),
);

// A quantity the route cannot parse ("two" is not a number
// normaliseQuantity accepts) is not a menu decision -- lib/agent/orders.ts
// treats it the same as a missing name or phone number: agentFail, not
// agentOk({placed:false}). This is one of the "more reasons than the
// brief knows about" the task called out.
const badQuantity = await call("order", {
  items: [{ name: "Cacio e Pepe", quantity: "two" }],
  type: "pickup",
  customer_name: "Task14 QA Caller",
  customer_phone: "+15105551014",
});
check(
  "an unparseable quantity is refused as a speakable failure, not a menu reason",
  badQuantity.status === 400 &&
    badQuantity.body?.ok === false &&
    typeof badQuantity.body?.error === "string",
  JSON.stringify(badQuantity.body),
);

// Order-size limits (lib/agent/orders.ts::MAX_ORDER_LINES /
// MAX_ITEM_QUANTITY, mirrored as the authority in
// supabase/migrations/20260812000400_place_order.sql's c_max_lines /
// c_max_qty). Neither limit existed in the brief's script.
const tooManyLines = await call("order", {
  items: Array.from({ length: 41 }, () => ({ name: "Cacio e Pepe", quantity: 1 })),
  type: "pickup",
  customer_name: "Task14 QA Caller",
  customer_phone: "+15105551014",
});
check(
  "more than 40 distinct lines is refused before touching the menu",
  tooManyLines.status === 400 && tooManyLines.body?.ok === false,
  JSON.stringify(tooManyLines.body),
);

const tooManyOfOne = await call("order", {
  items: [{ name: "Cacio e Pepe", quantity: 51 }],
  type: "pickup",
  customer_name: "Task14 QA Caller",
  customer_phone: "+15105551014",
});
check(
  "more than 50 of one item is refused",
  tooManyOfOne.status === 400 && tooManyOfOne.body?.ok === false,
  JSON.stringify(tooManyOfOne.body),
);

// Idempotency. public.place_order fingerprints provider_call_id + type +
// customer + address + sorted lines, and a retry inside the same call
// returns the order that already exists instead of writing a second one
// -- this is now checked at the HTTP boundary the agent actually sees:
// two identical tool calls, same order_number back both times.
const providerCallId = `task14-idem-${Date.now()}`;
const idemFirst = await call("order", {
  items: [{ name: "Bucatini Amatriciana", quantity: 1 }],
  type: "pickup",
  customer_name: "Task14 QA Caller",
  customer_phone: "+15105551014",
  provider_call_id: providerCallId,
});
const idemSecond = await call("order", {
  items: [{ name: "Bucatini Amatriciana", quantity: 1 }],
  type: "pickup",
  customer_name: "Task14 QA Caller",
  customer_phone: "+15105551014",
  provider_call_id: providerCallId,
});
check(
  "a retried identical order does not create a second order",
  idemFirst.body?.placed === true &&
    idemSecond.body?.placed === true &&
    idemFirst.body?.order_number != null &&
    idemFirst.body?.order_number === idemSecond.body?.order_number,
  `first #${idemFirst.body?.order_number}, second #${idemSecond.body?.order_number}`,
);
if (idemFirst.body?.placed && idemFirst.body?.order_number) {
  created.orders.push(idemFirst.body.order_number);
}

// ── Transfer ────────────────────────────────────────────────────────

const transfer = await call("transfer", { reason: "Allergy question" });
check(
  "transfer returns a number",
  typeof transfer.body?.number === "string",
  transfer.body?.number,
);

// ── Assistant config ────────────────────────────────────────────────

const assistant = await call("assistant", {});
check(
  "demo location is live with the kill switch off, so the assistant is enabled",
  assistant.body?.assistant_enabled === true &&
    assistant.body?.kill_switch_on === false &&
    assistant.body?.is_live === true,
  JSON.stringify({
    assistant_enabled: assistant.body?.assistant_enabled,
    kill_switch_on: assistant.body?.kill_switch_on,
    is_live: assistant.body?.is_live,
  }),
);
check(
  "prompt has no unfilled placeholders",
  typeof assistant.body?.system_prompt === "string" &&
    !/\{\{[a-z_]+\}\}/.test(assistant.body.system_prompt),
);

// Fail-closed. The brief did not know this route could refuse at all --
// it assumed every location always gets a usable prompt. It now fails
// closed on two independent conditions, each proven against its own
// throwaway location so the demo location's live switch is never
// touched by this run.
const killSwitchAssistant = await call("assistant", {}, killSwitchSecret);
check(
  "assistant fails closed when the kill switch is on",
  killSwitchAssistant.body?.assistant_enabled === false &&
    killSwitchAssistant.body?.disabled_reason === "kill_switch" &&
    killSwitchAssistant.body?.system_prompt === null &&
    killSwitchAssistant.body?.greeting === null,
  JSON.stringify(killSwitchAssistant.body),
);

const notLiveAssistant = await call("assistant", {}, notLiveSecret);
check(
  "assistant fails closed when the location is not live",
  notLiveAssistant.body?.assistant_enabled === false &&
    notLiveAssistant.body?.disabled_reason === "not_live" &&
    notLiveAssistant.body?.system_prompt === null &&
    notLiveAssistant.body?.greeting === null,
  JSON.stringify(notLiveAssistant.body),
);

// ── Report ──────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
console.log(
  `\ncreated (needs cleanup): orders ${JSON.stringify(created.orders)}, bookings ${JSON.stringify(created.bookings)}`,
);
process.exit(failed.length ? 1 : 0);
