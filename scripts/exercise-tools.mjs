#!/usr/bin/env node
/* Drive every tool endpoint the way the voice platform will, against the
   live database.

   AGENT_SECRET=...             secret for the demo location (required;
                                 the value from set-agent-secret.mjs)
   NEXT_PUBLIC_SUPABASE_URL=... required -- this script talks to the
   SUPABASE_SERVICE_ROLE_KEY=...  database directly (not just over HTTP)
                                 for three things an HTTP-only script
                                 cannot do: price an order independently
                                 of the route under test, provision and
                                 tear down its own throwaway tenants, and
                                 audit the demo location's tables before
                                 and after the run.

   node scripts/exercise-tools.mjs [base-url]

   This script is self-contained: every canary location it needs (one
   for cross-tenant isolation, one with the kill switch on, one that is
   not live, one that is shut every day of the week, and one open 9 to 5
   with exactly two seats) is created here, used here, and deleted here,
   in a try/finally that runs even if a check throws partway through --
   so a second run of this script starts from exactly the same database
   state as the first.

   Two of those exist because the routes now read opening hours
   (lib/agent/hours.ts::openAt) before taking a booking or an order, and
   an assertion about that has to be pinned to hours this script controls
   rather than to what time of day it happens to run. The demo
   location's own hours are used too, but only for what they really say:
   its bookings are made inside them, and the one check that has to
   happen "now" -- placing an order -- asserts that the route agrees with
   those hours either way. The demo location itself (a10c0000-0000-0000-0000-
   00000000000a) and its seeded rows are never written to except for the
   orders/bookings this run itself places, and those are removed at the
   end; an audit at the bottom proves it by snapshotting orders,
   order_items, bookings, calls, order_status_events and menu_items for
   that location before and after and asserting they are identical. */
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const base = process.argv[2] ?? "http://localhost:3000";
const secret = process.env.AGENT_SECRET;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!secret) {
  console.error("set AGENT_SECRET to the value from set-agent-secret.mjs");
  process.exit(1);
}
if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (same " +
      ".env.local values the app itself uses) -- this script provisions " +
      "and tears down its own canary tenants and audits the demo " +
      "location directly, both of which need database access beyond " +
      "what the HTTP API exposes.",
  );
  process.exit(1);
}

const DEMO_LOCATION_ID = "a10c0000-0000-0000-0000-00000000000a";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Same algorithm as lib/agent/auth.ts::hashAgentSecret. Duplicated
 *  rather than imported: that file is `import "server-only"`, which
 *  throws outside a Next.js server context, and pulling in the TS
 *  compiler for one function is a worse trade than nine lines that must
 *  stay in step with it. */
const hashAgentSecret = (value) =>
  crypto.createHash("sha256").update(value, "utf-8").digest("hex");

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

/** Throws with the failing operation named, instead of a check quietly
 *  comparing against `undefined` because a Postgres error was ignored. */
async function mustOk(promise, label) {
  const { data, error } = await promise;
  if (error) throw new Error(`${label} failed: ${error.message}`);
  return data;
}

// ── real-data replicas of the pure functions the routes use ───────────
//
// These mirror lib/agent/hours.ts::openState and
// lib/agent/availability.ts::seatsTaken closely enough to answer "what
// should the route say right now" from the same rows the route itself
// reads, independent of the route's own output -- that independence is
// the entire point: comparing the route's answer to itself would prove
// nothing. Both files are TypeScript importing `next/font`-adjacent and
// `server-only` dependencies that do not resolve outside the Next.js
// build, so the logic is copied rather than imported; keep these in step
// by hand if either source function changes.

const toMinutesOfDay = (time) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

const spokenTimeOfDay = (time) => {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
};

function localParts(now, timezone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    dayOfWeek: days.indexOf(parts.weekday),
  };
}

/** Same shape as lib/agent/hours.ts::openState's `today`/`open_now`
 *  (next_open omitted -- no check here needs it). */
function computeOpenState(now, timezone, hoursRows, holidayRows) {
  const local = localParts(now, timezone);
  const holiday = holidayRows.find((h) => h.date === local.date);
  const weekday = hoursRows.find((h) => h.day_of_week === local.dayOfWeek);
  const today = holiday
    ? { is_closed: holiday.is_closed, open_time: holiday.open_time, close_time: holiday.close_time }
    : {
        is_closed: weekday?.is_closed ?? true,
        open_time: weekday?.open_time ?? null,
        close_time: weekday?.close_time ?? null,
      };

  if (today.is_closed || !today.open_time || !today.close_time) {
    return { open_now: false, today: "closed" };
  }
  const opens = toMinutesOfDay(today.open_time);
  const closes = toMinutesOfDay(today.close_time);
  return {
    open_now: local.minutes >= opens && local.minutes < closes,
    today: `${spokenTimeOfDay(today.open_time)} to ${spokenTimeOfDay(today.close_time)}`,
  };
}

/** Verbatim port of lib/agent/availability.ts::seatsTaken. */
function seatsTakenJS(bookings, slotStart, slotMinutes) {
  const start = slotStart.getTime();
  const end = start + slotMinutes * 60_000;

  const overlapping = bookings
    .map((booking) => {
      const bStart = new Date(booking.requested_at).getTime();
      return { bStart, bEnd: bStart + slotMinutes * 60_000, party: booking.party_size };
    })
    .filter((b) => b.bStart < end && b.bEnd > start);

  const events = overlapping.flatMap((b) => [
    { time: b.bStart, delta: b.party },
    { time: b.bEnd, delta: -b.party },
  ]);
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);

  let running = 0;
  let peak = 0;
  for (const event of events) {
    running += event.delta;
    if (running > peak) peak = running;
  }
  return peak;
}

// ── local wall-clock arithmetic ──────────────────────────────────────
//
// Several checks below have to name an instant by what a clock on the
// restaurant's wall says -- "quarter past five on the next day this place
// is open", "three in the morning" -- because that is the only thing the
// hours rows can be compared against, and the routes now refuse a
// booking or an order outside them (lib/agent/hours.ts::openAt). Doing
// that from UTC arithmetic alone is wrong twice a year; this converts
// through the zone the same way Intl does, which is what the routes use.

/** How far the location's wall clock is from UTC at this instant. */
function tzOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** The instant at which the location's clock reads `dateStr` (YYYY-MM-DD)
 *  at `minutesOfDay`. Offsets are resolved twice because the first guess
 *  can land on the wrong side of a DST transition. */
function instantAtLocal(dateStr, minutesOfDay, timeZone) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, Math.floor(minutesOfDay / 60), minutesOfDay % 60);
  const firstGuess = new Date(wall - tzOffsetMs(new Date(wall), timeZone));
  const corrected = new Date(wall - tzOffsetMs(firstGuess, timeZone));
  return corrected;
}

const localDateOf = (date, timeZone) =>
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);

const addDays = (dateStr, days) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
};

const calendarDayOfWeek = (dateStr) => {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** The next local dates, starting tomorrow, on which the location is
 *  actually open, with the minute it opens. Holiday rows override the
 *  weekday row, the same precedence lib/agent/hours.ts uses. Starting
 *  tomorrow rather than today keeps every instant built from these in the
 *  future no matter what time this script runs. */
function openDaysAhead(hoursRows, holidayRows, timezone, count) {
  const today = localDateOf(new Date(), timezone);
  const days = [];
  for (let offset = 1; offset <= 14 && days.length < count; offset++) {
    const date = addDays(today, offset);
    const holiday = holidayRows.find((h) => h.date === date);
    const weekday = hoursRows.find((h) => h.day_of_week === calendarDayOfWeek(date));
    const isClosed = holiday ? holiday.is_closed : (weekday?.is_closed ?? true);
    const openTime = holiday ? holiday.open_time : (weekday?.open_time ?? null);
    if (!isClosed && openTime) days.push({ date, opensAt: toMinutesOfDay(openTime) });
  }
  return days;
}

// ── canary tenant lifecycle ─────────────────────────────────────────
//
// Five throwaway locations this run owns start to finish, replacing
// the ad hoc SQL a human used to run outside the repo (see the task-14
// report) with something `node scripts/exercise-tools.mjs` can redo on
// its own, in CI, forever. Ids are pushed into `canaryLocationIds` the
// instant each insert succeeds -- not returned in a batch at the end --
// so a failure partway through provisioning still leaves every already-
// created row tracked for teardown.
const canaryLocationIds = [];

// The demo location's tax_rate_bps is 0 -- real seeded data, left
// untouched (see the module header) -- so nothing else in this script
// ever exercises place_order's `round(subtotal * tax_bps / 10000)`. A
// wrong divisor, truncation instead of rounding, or tax applied to the
// wrong base would all still pass every other check here. This rate and
// price are chosen so two different quantities of one item land the
// pre-rounding tax on opposite sides of a half cent: qty 5 gives a raw
// tax of 3.25 (below half, must round DOWN to 3) and qty 10 gives exactly
// 6.5 (a genuine tie, must round AWAY FROM ZERO to 7, matching Postgres'
// round() and place_order's own comment on it). A bug that rounds each
// unit's tax before summing instead of taxing the whole subtotal is
// caught too: round(13 * 500 / 10000) = 1 per unit, so 5x1=5 and
// 10x1=10 -- neither matches either case.
const TAX_CANARY_RATE_BPS = 500; // 5% -- nonzero, unlike the demo location
const TAX_CANARY_ITEM_PRICE_CENTS = 13;
const TAX_CANARY_ITEM_NAME = "Zzyzx Tax Canary";

// The canary the hours checks run against: a window narrow enough that
// times either side of it are unambiguously shut, and exactly two seats,
// so one booking for two fills it and the alternatives the route offers
// have to be filtered by capacity as well as by the clock. Both numbers
// are picked so every expectation below is a fixed string, not something
// recomputed from whatever the demo location happens to be doing.
const HOURS_CANARY_OPEN = "09:00:00";
const HOURS_CANARY_CLOSE = "17:00:00";
const HOURS_CANARY_TZ = "America/Los_Angeles";
const HOURS_CANARY_SEATS = 2;
const HOURS_CANARY_SLOT_MINUTES = 90;

async function createCanaryLocation(
  orgId,
  { name, is_live, kill_switch_on, tax_rate_bps = 0, timezone, seats, reservation_slot_minutes },
) {
  const plaintextSecret = crypto.randomBytes(32).toString("base64url");
  const row = await mustOk(
    admin
      .from("locations")
      .insert({
        org_id: orgId,
        name,
        is_live,
        kill_switch_on,
        tax_rate_bps,
        agent_secret_hash: hashAgentSecret(plaintextSecret),
        ...(timezone ? { timezone } : {}),
        ...(seats ? { seats } : {}),
        ...(reservation_slot_minutes ? { reservation_slot_minutes } : {}),
      })
      .select("id")
      .single(),
    `insert canary location "${name}"`,
  );
  canaryLocationIds.push(row.id);
  return { id: row.id, secret: plaintextSecret };
}

/** One hours row per weekday. Locations with no rows at all are a
 *  separate case on purpose -- openAt calls those "unknown" and the
 *  routes let them through, which is what keeps every OTHER canary here
 *  able to place an order whatever time this script runs. */
async function giveCanaryHours(locationId, { open_time, close_time, is_closed = false }) {
  await mustOk(
    admin.from("hours").insert(
      Array.from({ length: 7 }, (_, day) => ({
        location_id: locationId,
        day_of_week: day,
        open_time,
        close_time,
        is_closed,
      })),
    ),
    `insert canary hours for ${locationId}`,
  );
}

/** A menu with one orderable item, so a check about something other than
 *  the menu (hours, notes, notification) has something to order. */
async function giveCanaryMenu(locationId, itemName, priceCents) {
  const category = await mustOk(
    admin.from("menu_categories").insert({ location_id: locationId, name: "Canary" }).select("id").single(),
    `insert canary menu category for ${locationId}`,
  );
  await mustOk(
    admin.from("menu_items").insert({
      category_id: category.id,
      location_id: locationId,
      name: itemName,
      price_cents: priceCents,
    }),
    `insert canary menu item ${itemName}`,
  );
  return category.id;
}

async function provisionCanaries(orgId) {
  // Isolated: proves get_menu AND place_order never cross a secret
  // boundary. Its first item deliberately shares no name with anything on
  // the demo menu, so a name-based order lookup has nothing to
  // accidentally collide with either. It also carries this run's only
  // nonzero tax_rate_bps (TAX_CANARY_RATE_BPS above) and a second item
  // priced to pin place_order's rounding -- reusing this location rather
  // than provisioning a fourth one, since nothing about the tax check
  // needs a location of its own.
  const isolated = await createCanaryLocation(orgId, {
    name: "Task14 Canary Isolated (exercise-tools, ephemeral)",
    is_live: true,
    kill_switch_on: false,
    tax_rate_bps: TAX_CANARY_RATE_BPS,
  });
  const category = await mustOk(
    admin.from("menu_categories").insert({ location_id: isolated.id, name: "Canary" }).select("id").single(),
    "insert canary menu category",
  );
  await mustOk(
    admin.from("menu_items").insert({
      category_id: category.id,
      location_id: isolated.id,
      name: "Zzyzx Canary Special",
      price_cents: 999,
    }),
    "insert canary menu item",
  );
  await mustOk(
    admin.from("menu_items").insert({
      category_id: category.id,
      location_id: isolated.id,
      name: TAX_CANARY_ITEM_NAME,
      price_cents: TAX_CANARY_ITEM_PRICE_CENTS,
    }),
    "insert canary tax item",
  );

  // Kill-switch and not-live: prove the assistant route fails closed on
  // each condition independently, without ever touching the demo
  // location's own live switch -- that is real, user-facing
  // configuration this task must leave untouched.
  const killSwitch = await createCanaryLocation(orgId, {
    name: "Task14 Canary KillSwitch (exercise-tools, ephemeral)",
    is_live: true,
    kill_switch_on: true,
  });
  const notLive = await createCanaryLocation(orgId, {
    name: "Task14 Canary NotLive (exercise-tools, ephemeral)",
    is_live: false,
    kill_switch_on: false,
  });

  // Shut every day of the week, so "the kitchen is closed" is a fixed
  // answer rather than one that depends on what time this script runs.
  // The demo location's own hours are checked separately, against
  // whatever they really say right now.
  const closed = await createCanaryLocation(orgId, {
    name: "Task16 Canary Closed (exercise-tools, ephemeral)",
    is_live: true,
    kill_switch_on: false,
  });
  await giveCanaryHours(closed.id, {
    open_time: HOURS_CANARY_OPEN,
    close_time: HOURS_CANARY_CLOSE,
    is_closed: true,
  });
  await giveCanaryMenu(closed.id, "Zzyzx Closed Kitchen Special", 1500);

  // Open 9 to 5, two seats. Everything the alternatives checks assert is
  // derived from those two numbers and nothing else.
  const hoursWindow = await createCanaryLocation(orgId, {
    name: "Task16 Canary Hours (exercise-tools, ephemeral)",
    is_live: true,
    kill_switch_on: false,
    timezone: HOURS_CANARY_TZ,
    seats: HOURS_CANARY_SEATS,
    reservation_slot_minutes: HOURS_CANARY_SLOT_MINUTES,
  });
  await giveCanaryHours(hoursWindow.id, {
    open_time: HOURS_CANARY_OPEN,
    close_time: HOURS_CANARY_CLOSE,
  });

  return {
    isolatedLocationId: isolated.id,
    isolatedSecret: isolated.secret,
    killSwitchSecret: killSwitch.secret,
    notLiveSecret: notLive.secret,
    closedLocationId: closed.id,
    closedSecret: closed.secret,
    hoursLocationId: hoursWindow.id,
    hoursSecret: hoursWindow.secret,
  };
}

async function teardownCanaries() {
  if (!canaryLocationIds.length) return;
  // menu_categories/menu_items/hours/bookings/orders (and, from orders,
  // order_items and order_status_events -- the tax, note and idempotency
  // checks below place real orders against the canary locations) all
  // cascade from locations via ON DELETE CASCADE (confirmed in
  // supabase/migrations/20260807000100_schema.sql), so deleting the
  // location is the whole teardown.
  const { error } = await admin.from("locations").delete().in("id", canaryLocationIds);
  if (error) {
    console.error("cleanup: failed to delete canary locations", error.message, canaryLocationIds);
  }
}

// ── what this run writes to the demo location ──────────────────────

const created = { orders: [], bookings: [] };

async function teardownDemoWrites() {
  if (created.orders.length) {
    const rows = await mustOk(
      admin
        .from("orders")
        .select("id")
        .eq("location_id", DEMO_LOCATION_ID)
        .in("order_number", created.orders),
      "look up created orders for cleanup",
    );
    const ids = (rows ?? []).map((r) => r.id);
    if (ids.length) {
      // order_status_events cascades from orders' own delete (FK
      // order_id -> orders(id) on delete cascade), so deleting the
      // order is enough to remove its events too -- verified by the
      // before/after audit below, not just assumed.
      await mustOk(admin.from("order_items").delete().in("order_id", ids), "delete created order_items");
      await mustOk(admin.from("orders").delete().in("id", ids), "delete created orders");
    }
  }
  if (created.bookings.length) {
    await mustOk(admin.from("bookings").delete().in("id", created.bookings), "delete created bookings");
  }
}

// ── before/after audit of the demo location ────────────────────────
//
// Full-row snapshots, not just counts: "byte-for-byte unchanged" means
// the seeded Dana order and Marcus booking must read back identically,
// not merely that the row counts still add up. `.order("id")` on every
// query makes the comparison independent of Postgres' unspecified
// default row order, which otherwise would make two genuinely identical
// snapshots compare unequal by chance.

async function snapshotTable(table, build) {
  return mustOk(build(admin.from(table).select("*")), `snapshot ${table}`);
}

async function snapshotDemoLocation() {
  const orders = await snapshotTable("orders", (q) =>
    q.eq("location_id", DEMO_LOCATION_ID).order("id"),
  );
  const orderIds = orders.map((o) => o.id);
  const orderItems = orderIds.length
    ? await snapshotTable("order_items", (q) => q.in("order_id", orderIds).order("id"))
    : [];
  const orderStatusEvents = orderIds.length
    ? await snapshotTable("order_status_events", (q) => q.in("order_id", orderIds).order("id"))
    : [];
  const bookings = await snapshotTable("bookings", (q) =>
    q.eq("location_id", DEMO_LOCATION_ID).order("id"),
  );
  const calls = await snapshotTable("calls", (q) => q.eq("location_id", DEMO_LOCATION_ID).order("id"));
  const menuItems = await snapshotTable("menu_items", (q) =>
    q.eq("location_id", DEMO_LOCATION_ID).order("id"),
  );
  return { orders, order_items: orderItems, bookings, calls, order_status_events: orderStatusEvents, menu_items: menuItems };
}

const tableCounts = (snapshot) =>
  Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.length]));

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  const before = await snapshotDemoLocation();
  console.log("before (demo location row counts):", JSON.stringify(tableCounts(before)));

  const demoLocation = await mustOk(
    admin.from("locations").select("*").eq("id", DEMO_LOCATION_ID).single(),
    "read demo location",
  );
  const cacioPepe = await mustOk(
    admin
      .from("menu_items")
      .select("price_cents")
      .eq("location_id", DEMO_LOCATION_ID)
      .eq("name", "Cacio e Pepe")
      .single(),
    "read Cacio e Pepe price",
  );

  let canaries = null;
  let runError = null;

  try {
    canaries = await provisionCanaries(demoLocation.org_id);
    await runChecks(demoLocation, cacioPepe, canaries);
  } catch (err) {
    runError = err;
    console.error("\nFATAL — a check threw instead of failing normally:", err.stack ?? err);
  } finally {
    // Cleanup runs even when a check above threw partway through, so a
    // crash never leaves this run's writes (or its canary tenants)
    // behind for the next one to trip over.
    await teardownDemoWrites();
    await teardownCanaries();
  }

  const after = await snapshotDemoLocation();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  check(
    "demo location's orders, order_items, bookings, calls, order_status_events and menu_items are byte-for-byte unchanged",
    unchanged,
    unchanged
      ? JSON.stringify(tableCounts(after))
      : `before ${JSON.stringify(tableCounts(before))}, after ${JSON.stringify(tableCounts(after))}`,
  );

  // ── report ────────────────────────────────────────────────────────

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log(`\nafter (demo location row counts):`, JSON.stringify(tableCounts(after)));

  if (runError || failed.length) process.exit(1);
  process.exit(0);
}

async function runChecks(demoLocation, cacioPepe, canaries) {
  // ── Auth ──────────────────────────────────────────────────────────

  const noAuth = await call("menu", {}, null);
  check("unauthenticated menu is rejected", noAuth.status === 401);

  const badAuth = await call("menu", {}, "wrong-secret");
  check("wrong secret is rejected", badAuth.status === 401);

  // The auth gate (lib/agent/auth.ts::locationForSecret) is shared code
  // every route calls first, but "shared" is not "tested" -- proving it
  // once on a read tells you nothing about the two routes that write.
  // A write reaching another tenant is worse than a read reaching one,
  // so both WRITE endpoints get their own missing/wrong-secret pair.
  const noAuthOrder = await call("order", {}, null);
  check("unauthenticated order is rejected", noAuthOrder.status === 401);
  const badAuthOrder = await call("order", {}, "wrong-secret");
  check("wrong secret is rejected on order", badAuthOrder.status === 401);

  const noAuthReservation = await call("reservation", {}, null);
  check("unauthenticated reservation is rejected", noAuthReservation.status === 401);
  const badAuthReservation = await call("reservation", {}, "wrong-secret");
  check("wrong secret is rejected on reservation", badAuthReservation.status === 401);

  // ── Menu ──────────────────────────────────────────────────────────

  // "squid", not "Squid Ink Tonnarelli". A caller says a word; they do
  // not read the menu title back. Passing the exact name pinned the weak
  // behaviour this check was supposed to be about -- suggestAlternative
  // used to need a whole-name match, so an exact name was the only input
  // that made it answer at all, and the check passed while the thing the
  // agent actually asks for ("we're out of the squid ink one, what else
  // is there") returned nothing.
  const menu = await call("menu", { item: "squid" });
  check("menu returns categories", Array.isArray(menu.body?.categories));
  check(
    "menu marks sold out items",
    (menu.body?.sold_out ?? []).includes("Squid Ink Tonnarelli") &&
      (menu.body?.sold_out ?? []).includes("Bistecca, 32oz"),
    JSON.stringify(menu.body?.sold_out),
  );

  // Not just "some string came back" -- the suggestion has to be a real
  // item on THIS menu, in stock, or an agent that reads it aloud is
  // promising food the kitchen cannot make.
  const allMenuItems = (menu.body?.categories ?? []).flatMap((c) => c.items);
  const suggested = allMenuItems.find((i) => i.name === menu.body?.alternative);
  check(
    "a spoken word for a sold-out item gets an alternative that is an actual in-stock item on this menu",
    typeof menu.body?.alternative === "string" &&
      menu.body.alternative.length > 0 &&
      suggested !== undefined &&
      suggested.sold_out === false,
    String(menu.body?.alternative),
  );

  // Cross-tenant isolation. A secret decides the location for every tool
  // call (lib/agent/auth.ts::locationForSecret) -- nothing in a request
  // body can move it. Proving this from the outside means fetching two
  // different locations' menus with two different secrets and checking
  // each side only ever sees its own data, not asserting on the auth
  // function's source. The canary tenant is provisioned by this script,
  // above, specifically so this is not the ad hoc, unreproducible setup
  // it used to be.
  const demoMenu = await call("menu", {});
  const canaryMenu = await call("menu", {}, canaries.isolatedSecret);
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

  // Isolation on the READ side (get_menu) says nothing about the WRITE
  // side. "Cacio e Pepe" exists only on the demo menu -- the canary
  // tenant's own menu has exactly one item and it is not this one -- so
  // a canary secret asking to order it has to be refused the same way
  // an item that does not exist anywhere would be. This exercises
  // place_order's location-scoped menu_items join, not just the route's
  // name lookup: even if the route's matching ever stopped being
  // per-tenant, the database function prices and validates every id
  // against `m.location_id = p_location_id` and would still refuse it.
  const canaryOrderAttempt = await call(
    "order",
    {
      items: [{ name: "Cacio e Pepe", quantity: 1 }],
      type: "pickup",
      customer_name: "Task14 Canary Probe",
      customer_phone: "+15105559999",
    },
    canaries.isolatedSecret,
  );
  check(
    "a canary secret cannot place an order against the demo location's menu",
    canaryOrderAttempt.body?.placed === false && canaryOrderAttempt.body?.reason === "unknown_item",
    JSON.stringify(canaryOrderAttempt.body),
  );

  // ── Hours ─────────────────────────────────────────────────────────

  const hours = await call("hours", {});
  const hoursRows = await mustOk(
    admin.from("hours").select("day_of_week, open_time, close_time, is_closed").eq("location_id", DEMO_LOCATION_ID),
    "read hours for independent check",
  );
  const holidayRows = await mustOk(
    admin.from("holiday_hours").select("date, is_closed, open_time, close_time").eq("location_id", DEMO_LOCATION_ID),
    "read holiday_hours for independent check",
  );
  const expectedHoursState = computeOpenState(new Date(), demoLocation.timezone, hoursRows, holidayRows);
  check(
    "hours answers open_now, matching today's real hours row computed independently of the route",
    hours.body?.open_now === expectedHoursState.open_now && hours.body?.today === expectedHoursState.today,
    `expected ${JSON.stringify(expectedHoursState)}, got open_now=${hours.body?.open_now} today=${JSON.stringify(hours.body?.today)}`,
  );

  // ── Availability ────────────────────────────────────────────────────

  // Every instant this section and the reservation section below ask
  // about is built from the demo location's own hours rows, not from
  // "now plus twenty-six hours". Both endpoints now refuse a time the
  // restaurant is shut (lib/agent/hours.ts::openAt), so an arbitrary
  // offset would be answering a different question -- and would pass or
  // fail depending on what time of day this script happened to run.
  const openDays = openDaysAhead(hoursRows, holidayRows, demoLocation.timezone, 2);
  if (openDays.length < 2) {
    throw new Error(
      "the demo location has fewer than two open days in the next fortnight -- " +
        "the reservation checks below have nowhere to book",
    );
  }
  // Quarter-hour offsets from opening, far enough apart that no two of
  // this run's own bookings compete for the same seats.
  const demoSlot = (dayIndex, minutesAfterOpen) =>
    instantAtLocal(
      openDays[dayIndex].date,
      openDays[dayIndex].opensAt + minutesAfterOpen,
      demoLocation.timezone,
    ).toISOString();

  const when = demoSlot(0, 15);
  const avail = await call("availability", { requested_at: when, party_size: 2 });
  const slot = demoLocation.reservation_slot_minutes;
  const whenDate = new Date(when);
  const windowStart = new Date(whenDate.getTime() - slot * 60_000).toISOString();
  const windowEnd = new Date(whenDate.getTime() + slot * 60_000).toISOString();
  const overlappingBookings = await mustOk(
    admin
      .from("bookings")
      .select("requested_at, party_size")
      .eq("location_id", DEMO_LOCATION_ID)
      .in("status", ["requested", "confirmed", "seated"])
      .gte("requested_at", windowStart)
      .lte("requested_at", windowEnd),
    "read overlapping bookings for independent availability check",
  );
  const expectedTaken = seatsTakenJS(overlappingBookings, whenDate, slot);
  const expectedAvailable = expectedTaken + 2 <= demoLocation.seats;
  check(
    "availability answers, matching real booking occupancy computed independently of the route",
    avail.body?.available === expectedAvailable,
    `expected ${expectedAvailable} (${expectedTaken}+2 seats taken of ${demoLocation.seats}), got ${avail.body?.available}`,
  );

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

  // ── Opening hours, and alternatives that were actually checked ──────
  //
  // Against a throwaway location open 9 to 5 with exactly two seats, so
  // every expectation here is a fixed string rather than something
  // recomputed from whatever the demo location is doing tonight. Nothing
  // on the reservation path used to read the hours at all -- a 3 AM table
  // was counted against the seats, written, and confirmed -- and the
  // alternatives were arithmetic: requested_at ± 30 minutes, offered as
  // "the nearest open times" with no capacity query, no hours check and
  // no past-time check behind them.
  const countBookingsAtLocation = async (locationId) => {
    const rows = await mustOk(
      admin.from("bookings").select("id").eq("location_id", locationId),
      `count bookings at ${locationId}`,
    );
    return rows.length;
  };

  const hoursCanaryDay = addDays(localDateOf(new Date(), HOURS_CANARY_TZ), 1);
  const hoursCanaryAt = (minutesOfDay) =>
    instantAtLocal(hoursCanaryDay, minutesOfDay, HOURS_CANARY_TZ).toISOString();

  const beforeOpen = await call(
    "availability",
    { requested_at: hoursCanaryAt(8 * 60), party_size: 2 },
    canaries.hoursSecret,
  );
  check(
    "availability refuses a time the restaurant is shut, and says what that day's hours are",
    beforeOpen.body?.available === false &&
      beforeOpen.body?.reason === "closed" &&
      beforeOpen.body?.hours_that_day === "9:00 AM to 5:00 PM",
    JSON.stringify(beforeOpen.body),
  );
  // 8:00 AM ± 30 and ± 60 are 7:30, 8:30 and 7:00 -- all before opening
  // -- so the only offsets that survive the hours filter are +60 (9:00)
  // and +90 (9:30). The old arithmetic answered "7:30 AM" and "8:30 AM"
  // here, at a restaurant that does not open until nine.
  check(
    "the alternatives offered for a closed time are the nearest times the restaurant is really open",
    JSON.stringify(beforeOpen.body?.alternatives) === JSON.stringify(["9:00 AM", "9:30 AM"]),
    JSON.stringify(beforeOpen.body?.alternatives),
  );

  const middleOfNight = await call(
    "reservation",
    {
      requested_at: hoursCanaryAt(3 * 60),
      party_size: 2,
      customer_name: "Task16 Closed Hours Caller",
      customer_phone: "+15105551020",
    },
    canaries.hoursSecret,
  );
  const bookingsAfterNightAttempt = await countBookingsAtLocation(canaries.hoursLocationId);
  check(
    "a 3 AM booking is refused with that day's hours, and nothing is written to the book",
    middleOfNight.status === 200 &&
      middleOfNight.body?.booked === false &&
      middleOfNight.body?.reason === "closed" &&
      middleOfNight.body?.hours_that_day === "9:00 AM to 5:00 PM" &&
      bookingsAfterNightAttempt === 0,
    `${JSON.stringify(middleOfNight.body)}, ${bookingsAfterNightAttempt} row(s) in bookings`,
  );

  const nineAm = await call(
    "reservation",
    {
      requested_at: hoursCanaryAt(9 * 60),
      party_size: 2,
      customer_name: "Task16 Opening Hours Caller",
      customer_phone: "+15105551021",
    },
    canaries.hoursSecret,
  );
  check(
    "the same booking inside opening hours goes through",
    nineAm.body?.booked === true,
    JSON.stringify(nineAm.body),
  );

  // Two seats, both now held for the 90-minute slot starting at 9:00. So
  // +30 and +60 (9:30 and 10:00) overlap a full room, -30/-60/-90 are
  // before opening, and the only offerable time left is +90: 10:30, when
  // the table has turned. An alternatives list that ignored capacity
  // would say "9:30 AM" here.
  const fullSlot = await call(
    "availability",
    { requested_at: hoursCanaryAt(9 * 60), party_size: 2 },
    canaries.hoursSecret,
  );
  check(
    "a full slot offers only a time that is both open and has seats",
    fullSlot.body?.available === false &&
      JSON.stringify(fullSlot.body?.alternatives) === JSON.stringify(["10:30 AM"]),
    JSON.stringify(fullSlot.body),
  );

  // The point of the whole exercise: an alternative the agent reads out
  // has to be one the next tool call will actually accept. Offering a
  // time and then refusing it is the agent contradicting itself out loud.
  const tookTheAlternative = await call(
    "reservation",
    {
      requested_at: hoursCanaryAt(10 * 60 + 30),
      party_size: 2,
      customer_name: "Task16 Alternative Taker",
      customer_phone: "+15105551022",
    },
    canaries.hoursSecret,
  );
  check(
    "the alternative the agent was told to offer can actually be booked",
    tookTheAlternative.body?.booked === true,
    JSON.stringify(tookTheAlternative.body),
  );

  // ── Reservation ─────────────────────────────────────────────────────

  const reservationWhen = demoSlot(0, 105);
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

  // The confirmation read back "Friday at 7:00 PM", which is the same
  // sentence for this Friday and for a table seventeen days out -- so a
  // booking on the wrong week sounded exactly like the right one. The
  // date is what lets a caller catch that, and it has to be rendered in
  // the restaurant's timezone, not the server's.
  const spokenMonthDay = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: demoLocation.timezone,
  }).format(new Date(reservationWhen));
  const expectedSpokenWhen = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: demoLocation.timezone,
  }).format(new Date(reservationWhen));
  check(
    "the confirmation names the date, not just the weekday, in the location's timezone",
    typeof booking.body?.when === "string" &&
      booking.body.when.includes(spokenMonthDay) &&
      booking.body.when === expectedSpokenWhen,
    `expected ${expectedSpokenWhen}, got ${JSON.stringify(booking.body?.when)}`,
  );

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

  // An over-max party used to get the same generic 400 a garbled party
  // size gets ("I didn't catch how many people"), while check_availability
  // -- asked about the same party a moment earlier -- already answered
  // `large_party`. The two endpoints now agree: this is an ordinary
  // answer with a speakable reason, not a failure to hear, so the agent
  // can say "that's a big party, let me put you through" instead of
  // asking again and hearing the same number again.
  const oversizedReservation = await call("reservation", {
    requested_at: reservationWhen,
    party_size: 99,
    customer_name: "Task14 QA Caller",
    customer_phone: "+15105551014",
  });
  check(
    "reservation for an over-max party is refused with the same large_party reason check_availability gives",
    oversizedReservation.status === 200 &&
      oversizedReservation.body?.booked === false &&
      oversizedReservation.body?.reason === "large_party",
    JSON.stringify(oversizedReservation.body),
  );

  // Idempotency. public.book_table now fingerprints provider_call_id +
  // requested_at + party_size + customer name + phone
  // (supabase/migrations/20260812000500_book_table_idempotency.sql), so a
  // retried tool call inside one phone call returns the booking that
  // already exists instead of holding a second table for the same party.
  // Checked at the HTTP boundary the agent actually sees -- two identical
  // tool calls, same booking_id back both times -- AND against the table,
  // because equal ids prove the route said the same thing while a row
  // count proves the book really only has one table in it.
  //
  // Every booking below carries a name unique to this run, so the counts
  // are of this run's own rows and nothing else, and each uses its own
  // slot so none of them competes with another for seats.
  const stamp = Date.now();
  const trackBooking = (res) => {
    if (res.body?.booked && res.body?.booking_id) created.bookings.push(res.body.booking_id);
    return res;
  };
  const countBookingsNamed = async (name) => {
    const rows = await mustOk(
      admin
        .from("bookings")
        .select("id")
        .eq("location_id", DEMO_LOCATION_ID)
        .eq("customer_name", name),
      `count bookings named ${name}`,
    );
    return rows.length;
  };

  const retryName = `Task15 Retry Canary ${stamp}`;
  const retryWhen = demoSlot(0, 195);
  const retryCallId = `task15-reservation-idem-${stamp}`;
  const retryBody = {
    requested_at: retryWhen,
    party_size: 2,
    customer_name: retryName,
    customer_phone: "+15105551015",
    provider_call_id: retryCallId,
  };
  const retryFirst = trackBooking(await call("reservation", retryBody));
  const retrySecond = trackBooking(await call("reservation", retryBody));
  const retryRowCount = await countBookingsNamed(retryName);
  check(
    "a retried identical reservation inside one call returns the same booking and does not hold a second table",
    retryFirst.body?.booked === true &&
      retrySecond.body?.booked === true &&
      retryFirst.body?.booking_id != null &&
      retryFirst.body?.booking_id === retrySecond.body?.booking_id &&
      retrySecond.body?.when === retryFirst.body?.when &&
      retryRowCount === 1,
    `first ${retryFirst.body?.booking_id}, second ${retrySecond.body?.booking_id}, ${retryRowCount} row(s) in bookings`,
  );

  // The other half of the guarantee, and the one a too-eager key would
  // break: two DIFFERENT phone calls asking for the same slot, the same
  // party size, even the same name and number, are two bookings. A key
  // built from the request alone -- without provider_call_id in it --
  // would collapse them and quietly lose a real reservation.
  const distinctName = `Task15 Distinct Calls ${stamp}`;
  const distinctBody = {
    requested_at: demoSlot(1, 15),
    party_size: 2,
    customer_name: distinctName,
    customer_phone: "+15105551016",
  };
  const callOne = trackBooking(
    await call("reservation", { ...distinctBody, provider_call_id: `${retryCallId}-a` }),
  );
  const callTwo = trackBooking(
    await call("reservation", { ...distinctBody, provider_call_id: `${retryCallId}-b` }),
  );
  const distinctRowCount = await countBookingsNamed(distinctName);
  check(
    "two different calls booking the identical slot still create two bookings",
    callOne.body?.booked === true &&
      callTwo.body?.booked === true &&
      callOne.body?.booking_id != null &&
      callTwo.body?.booking_id != null &&
      callOne.body?.booking_id !== callTwo.body?.booking_id &&
      distinctRowCount === 2,
    `${callOne.body?.booking_id} vs ${callTwo.body?.booking_id}, ${distinctRowCount} row(s) in bookings`,
  );

  // And the documented limit of the protection, pinned rather than left
  // to be discovered: with no provider_call_id there is no fingerprint,
  // so book_table cannot tell a retry from a second request and every
  // call books another table. This is what docs/vapi-setup.md means by
  // "pass provider_call_id on every create_reservation call" -- the
  // failure it warns about is proven here, not asserted.
  const noIdName = `Task15 No Provider Id ${stamp}`;
  const noIdBody = {
    requested_at: demoSlot(1, 105),
    party_size: 2,
    customer_name: noIdName,
    customer_phone: "+15105551017",
  };
  const noIdFirst = trackBooking(await call("reservation", noIdBody));
  const noIdSecond = trackBooking(await call("reservation", noIdBody));
  const noIdRowCount = await countBookingsNamed(noIdName);
  check(
    "without a provider_call_id there is no fingerprint, so an identical reservation is NOT deduplicated",
    noIdFirst.body?.booked === true &&
      noIdSecond.body?.booked === true &&
      noIdFirst.body?.booking_id !== noIdSecond.body?.booking_id &&
      noIdRowCount === 2,
    `${noIdFirst.body?.booking_id} vs ${noIdSecond.body?.booking_id}, ${noIdRowCount} row(s) in bookings`,
  );

  // ── Order ───────────────────────────────────────────────────────────

  const order = await call("order", {
    items: [{ name: "Cacio e Pepe", quantity: 2 }],
    type: "pickup",
    customer_name: "Task14 QA Caller",
    customer_phone: "+15105551014",
  });
  // Whether the demo restaurant is open right now is not this script's to
  // choose, and place_order refuses an order when the kitchen is shut
  // (app/api/agent/order/route.ts). So the assertion is against the
  // truth either way: the route must agree with this location's own hours
  // rows, computed here independently a few checks above. Every refusal
  // check below is unaffected -- the hours gate sits after the route has
  // understood the request, so "we're out of that" and "I didn't catch
  // how many" still come first.
  const demoOpenNow = expectedHoursState.open_now;
  check(
    demoOpenNow
      ? "order is placed while the demo location is open"
      : "order is refused as closed, matching the demo location's real hours right now",
    demoOpenNow
      ? order.body?.placed === true
      : order.body?.placed === false &&
          order.body?.reason === "closed" &&
          typeof order.body?.hours_that_day === "string",
    `open_now=${demoOpenNow} ${JSON.stringify(order.body)}`,
  );
  if (order.body?.placed && order.body?.order_number) {
    created.orders.push(order.body.order_number);
  }

  // The number a restaurant checks first. place_order
  // (supabase/migrations/20260812000400_place_order.sql) prices every
  // line from menu_items and applies locations.tax_rate_bps server-side
  // -- the route never sends a price. Computed here from the same two
  // sources, independently, in integer cents throughout (no float ever
  // holds money, matching lib/agent/orders.ts::priceOrder and the
  // function's own `round(subtotal * bps / 10000)`), then formatted the
  // same way the route formats its response for an exact string compare.
  const expectedSubtotalCents = cacioPepe.price_cents * 2;
  const expectedTaxCents = Math.round((expectedSubtotalCents * demoLocation.tax_rate_bps) / 10_000);
  const expectedTotalCents = expectedSubtotalCents + expectedTaxCents;
  const expectedTotal = `$${(expectedTotalCents / 100).toFixed(2)}`;
  check(
    demoOpenNow
      ? "order total matches menu price × quantity plus tax, computed independently from menu_items and locations.tax_rate_bps"
      : "a closed kitchen quotes no total and no order number at all",
    demoOpenNow
      ? order.body?.total === expectedTotal
      : order.body?.total === undefined && order.body?.order_number === undefined,
    demoOpenNow
      ? `expected ${expectedTotal} (subtotal ${expectedSubtotalCents}c + tax ${expectedTaxCents}c), got ${order.body?.total}`
      : JSON.stringify(order.body),
  );

  // The check above never exercises place_order's tax arithmetic at all
  // -- the demo location's tax_rate_bps is 0 -- so it would pass unchanged
  // through a wrong divisor, truncation instead of rounding, or tax
  // applied to the wrong base. The isolated canary carries this run's
  // only nonzero rate (TAX_CANARY_RATE_BPS) and its own item
  // (TAX_CANARY_ITEM_PRICE_CENTS), priced so two quantities land the
  // pre-rounding tax on opposite sides of a half cent -- see the constant
  // definitions above provisionCanaries for the full case-by-case math.
  // The route's HTTP response only carries a formatted total string, so
  // subtotal_cents/tax_cents/total_cents are read back from the orders
  // row itself, the same way this run already looks up orders for
  // cleanup.
  for (const quantity of [5, 10]) {
    const expectedSubtotal = TAX_CANARY_ITEM_PRICE_CENTS * quantity;
    const expectedTax = Math.round((expectedSubtotal * TAX_CANARY_RATE_BPS) / 10_000);
    const expectedRowTotal = expectedSubtotal + expectedTax;
    const expectedHttpTotal = `$${(expectedRowTotal / 100).toFixed(2)}`;

    const taxOrder = await call(
      "order",
      {
        items: [{ name: TAX_CANARY_ITEM_NAME, quantity }],
        type: "pickup",
        customer_name: "Task14 Tax Canary",
        customer_phone: "+15105559998",
      },
      canaries.isolatedSecret,
    );
    const row =
      taxOrder.body?.placed === true && taxOrder.body?.order_number != null
        ? await mustOk(
            admin
              .from("orders")
              .select("subtotal_cents, tax_cents, total_cents")
              .eq("location_id", canaries.isolatedLocationId)
              .eq("order_number", taxOrder.body.order_number)
              .single(),
            `read back tax canary order (qty ${quantity})`,
          )
        : null;
    check(
      `tax canary order (qty ${quantity}, subtotal ${expectedSubtotal}c, raw tax ${(expectedSubtotal * TAX_CANARY_RATE_BPS) / 10_000}c) prices subtotal/tax/total exactly, pinning place_order's rounding`,
      taxOrder.body?.placed === true &&
        taxOrder.body?.total === expectedHttpTotal &&
        row?.subtotal_cents === expectedSubtotal &&
        row?.tax_cents === expectedTax &&
        row?.total_cents === expectedRowTotal,
      `expected subtotal=${expectedSubtotal} tax=${expectedTax} total=${expectedRowTotal} (${expectedHttpTotal}), got http_total=${taxOrder.body?.total} row=${JSON.stringify(row)}`,
    );
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
  // customer + address + sorted lines (each line's note included), and a
  // retry inside the same call returns the order that already exists
  // instead of writing a second one -- checked at the HTTP boundary the
  // agent actually sees: two identical tool calls, same order_number back
  // both times.
  //
  // Placed against the isolated canary rather than the demo location: the
  // canary has no hours rows, which openAt reports as "unknown" and the
  // route lets through, so this proves the retry behaviour at any hour of
  // the day instead of only while the demo restaurant happens to be open.
  const providerCallId = `task14-idem-${Date.now()}`;
  const idemBody = {
    items: [{ name: "Zzyzx Canary Special", quantity: 1 }],
    type: "pickup",
    customer_name: "Task14 QA Caller",
    customer_phone: "+15105551014",
    provider_call_id: providerCallId,
  };
  const idemFirst = await call("order", idemBody, canaries.isolatedSecret);
  const idemSecond = await call("order", idemBody, canaries.isolatedSecret);
  check(
    "a retried identical order does not create a second order",
    idemFirst.body?.placed === true &&
      idemSecond.body?.placed === true &&
      idemFirst.body?.order_number != null &&
      idemFirst.body?.order_number === idemSecond.body?.order_number,
    `first #${idemFirst.body?.order_number}, second #${idemSecond.body?.order_number}`,
  );

  // And the same order with a change on the line is NOT that retry. A
  // caller who says "one special" and then, correcting themselves in the
  // same breath, "one special, no onions" is asking for a different plate
  // of food; a fingerprint blind to the note would swallow the correction
  // and cook the first one.
  const correctedOrder = await call(
    "order",
    { ...idemBody, items: [{ name: "Zzyzx Canary Special", quantity: 1, note: "no onions" }] },
    canaries.isolatedSecret,
  );
  check(
    "the same order with a change on it is a new order, not a swallowed retry",
    correctedOrder.body?.placed === true &&
      correctedOrder.body?.order_number != null &&
      correctedOrder.body?.order_number !== idemFirst.body?.order_number,
    `retry #${idemFirst.body?.order_number}, corrected #${correctedOrder.body?.order_number}`,
  );

  // ── Per-item changes ────────────────────────────────────────────────
  //
  // The agent confirms "got it, no onions" out loud and place_order had
  // nowhere to put it, so the ticket at the pass said `1x Margherita`.
  // The note now rides on the line it belongs to, in the column that has
  // been sitting on order_items since the first schema migration. Read
  // back from the row rather than the response, because the row is what
  // the kitchen ticket and the dashboard are built from.
  const readBackItems = async (locationId, orderNumber) => {
    const orderRow = await mustOk(
      admin
        .from("orders")
        .select("id, staff_notified, staff_notified_at")
        .eq("location_id", locationId)
        .eq("order_number", orderNumber)
        .single(),
      `read back order #${orderNumber}`,
    );
    const items = await mustOk(
      admin
        .from("order_items")
        .select("name_snapshot, quantity, modifiers")
        .eq("order_id", orderRow.id),
      `read back order_items for #${orderNumber}`,
    );
    return { order: orderRow, items };
  };

  const notedOrder = await call(
    "order",
    {
      items: [
        { name: "Zzyzx Canary Special", quantity: 1, note: "  no onions,\n extra crispy " },
        { name: TAX_CANARY_ITEM_NAME, quantity: 1 },
      ],
      type: "pickup",
      customer_name: "Task16 Modified Order",
      customer_phone: "+15105559997",
    },
    canaries.isolatedSecret,
  );
  const noted =
    notedOrder.body?.placed === true
      ? await readBackItems(canaries.isolatedLocationId, notedOrder.body.order_number)
      : null;
  const notedLine = noted?.items.find((i) => i.name_snapshot === "Zzyzx Canary Special");
  const plainLine = noted?.items.find((i) => i.name_snapshot === TAX_CANARY_ITEM_NAME);
  check(
    "a per-item change is stored on the line it belongs to, and only that line",
    JSON.stringify(notedLine?.modifiers) === JSON.stringify(["no onions, extra crispy"]) &&
      JSON.stringify(plainLine?.modifiers) === JSON.stringify([]),
    JSON.stringify(noted?.items),
  );

  // A caller who reads a card number into a free-text field has it stored
  // and then texted out to the staff phone. This is the one new write
  // path this change adds, so it is redacted before either happens.
  const cardNoteOrder = await call(
    "order",
    {
      items: [{ name: "Zzyzx Canary Special", quantity: 1, note: "put it on 4111 1111 1111 1111" }],
      type: "pickup",
      customer_name: "Task16 Card Note",
      customer_phone: "+15105559996",
    },
    canaries.isolatedSecret,
  );
  const cardNoted =
    cardNoteOrder.body?.placed === true
      ? await readBackItems(canaries.isolatedLocationId, cardNoteOrder.body.order_number)
      : null;
  check(
    "a card number spoken into a change is redacted before it is stored",
    JSON.stringify(cardNoted?.items[0]?.modifiers) === JSON.stringify(["put it on [redacted]"]),
    JSON.stringify(cardNoted?.items),
  );

  const runawayNote = await call(
    "order",
    {
      items: [{ name: "Zzyzx Canary Special", quantity: 1, note: "x".repeat(201) }],
      type: "pickup",
      customer_name: "Task16 Runaway Note",
      customer_phone: "+15105559995",
    },
    canaries.isolatedSecret,
  );
  check(
    "a change longer than a spoken one could be is refused as a sentence, not written",
    runawayNote.status === 400 &&
      runawayNote.body?.ok === false &&
      typeof runawayNote.body?.error === "string",
    JSON.stringify(runawayNote.body),
  );

  // ── Did anybody actually find out? ──────────────────────────────────
  //
  // The staff SMS is the only path from a phone order to a human -- the
  // orders dashboard is still a stub -- and it fails silently when
  // order_sms_to or twilio_number is unset, which is exactly the state
  // this canary is in. The caller used to be told "you're all set"
  // regardless. Now the response says otherwise and the row records it,
  // and the agent is told to hand the caller to a person.
  check(
    "an order nobody could be texted about reports staff_notified: false, and the row agrees",
    notedOrder.body?.placed === true &&
      notedOrder.body?.staff_notified === false &&
      noted?.order.staff_notified === false &&
      noted?.order.staff_notified_at === null,
    `response=${JSON.stringify(notedOrder.body?.staff_notified)} row=${JSON.stringify({
      staff_notified: noted?.order.staff_notified,
      staff_notified_at: noted?.order.staff_notified_at,
    })}`,
  );

  // ── A closed kitchen ────────────────────────────────────────────────
  //
  // Nothing on the order path read the hours either: a 3 AM order was
  // priced, written, promised a ready time and confirmed. Proven against
  // a location that is shut every day of the week, so this is a fixed
  // answer rather than one that depends on when the script runs.
  const closedKitchen = await call(
    "order",
    {
      items: [{ name: "Zzyzx Closed Kitchen Special", quantity: 1 }],
      type: "pickup",
      customer_name: "Task16 Closed Kitchen",
      customer_phone: "+15105559994",
    },
    canaries.closedSecret,
  );
  const closedKitchenOrders = await mustOk(
    admin.from("orders").select("id").eq("location_id", canaries.closedLocationId),
    "count orders at the closed canary",
  );
  check(
    "an order at a closed kitchen is refused with that day's hours, and no order is written",
    closedKitchen.status === 200 &&
      closedKitchen.body?.placed === false &&
      closedKitchen.body?.reason === "closed" &&
      closedKitchen.body?.hours_that_day === "closed" &&
      closedKitchenOrders.length === 0,
    `${JSON.stringify(closedKitchen.body)}, ${closedKitchenOrders.length} order row(s)`,
  );

  // ── Transfer ────────────────────────────────────────────────────────

  const transfer = await call("transfer", { reason: "Allergy question" });
  check(
    "transfer returns the location's actual fallback number, not just some string",
    typeof transfer.body?.number === "string" &&
      transfer.body.number.length > 0 &&
      transfer.body.number === demoLocation.fallback_human_number,
    `expected ${demoLocation.fallback_human_number}, got ${JSON.stringify(transfer.body?.number)}`,
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

  const prompt = assistant.body?.system_prompt;
  // {{[a-z_]+}} only matched a lowercase-and-underscore placeholder name
  // -- it would silently pass a leftover {{Upper}} or {{item-name}} (a
  // hyphen, or a capital letter, is all it takes to escape the old
  // pattern) as if it were ordinary prompt text a caller should hear
  // read aloud. Any {{...}} at all is a bug: every real placeholder is
  // always substituted by lib/agent/prompt.ts::buildSystemPrompt before
  // this route returns.
  const hasUnfilledPlaceholder = /\{\{[^{}]+\}\}/.test(prompt ?? "");
  // A prompt this short could not possibly contain the safety rules
  // below -- an empty string, or a stub, passed the old length-blind
  // regex check vacuously. 3000 is comfortably below the real prompt's
  // length (~5700 characters after substitution) and comfortably above
  // anything that could plausibly be a stand-in.
  const isSubstantial = typeof prompt === "string" && prompt.length > 3000;
  // Two verbatim, load-bearing lines from lib/agent/prompt.ts's
  // SYSTEM_PROMPT_TEMPLATE that never get substituted -- proving this is
  // actually the restaurant's real prompt (with its payment and allergy
  // hard rules intact), not merely "some non-empty string with no curly
  // braces in it".
  const hasPaymentRule =
    typeof prompt === "string" &&
    prompt.includes("Never take a card number. Never take any payment details.");
  const hasAllergyRule =
    typeof prompt === "string" &&
    prompt.includes(
      "If anyone mentions an allergy, an intolerance, celiac, or asks what is in a dish for a health reason, stop.",
    );
  check(
    "prompt is substantial, contains load-bearing spec lines, and has no unfilled placeholders",
    isSubstantial && hasPaymentRule && hasAllergyRule && !hasUnfilledPlaceholder,
    `length=${typeof prompt === "string" ? prompt.length : "n/a"} payment_rule=${hasPaymentRule} allergy_rule=${hasAllergyRule} unfilled={{...}}=${hasUnfilledPlaceholder}`,
  );

  // Fail-closed. The brief did not know this route could refuse at all --
  // it assumed every location always gets a usable prompt. It now fails
  // closed on two independent conditions, each proven against its own
  // throwaway location so the demo location's live switch is never
  // touched by this run.
  const killSwitchAssistant = await call("assistant", {}, canaries.killSwitchSecret);
  check(
    "assistant fails closed when the kill switch is on",
    killSwitchAssistant.body?.assistant_enabled === false &&
      killSwitchAssistant.body?.disabled_reason === "kill_switch" &&
      killSwitchAssistant.body?.system_prompt === null &&
      killSwitchAssistant.body?.greeting === null,
    JSON.stringify(killSwitchAssistant.body),
  );

  const notLiveAssistant = await call("assistant", {}, canaries.notLiveSecret);
  check(
    "assistant fails closed when the location is not live",
    notLiveAssistant.body?.assistant_enabled === false &&
      notLiveAssistant.body?.disabled_reason === "not_live" &&
      notLiveAssistant.body?.system_prompt === null &&
      notLiveAssistant.body?.greeting === null,
    JSON.stringify(notLiveAssistant.body),
  );
}

await main();
