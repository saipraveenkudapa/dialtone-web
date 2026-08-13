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
   not live, one that is shut every day of the week, one open 9 to 5
   with exactly two seats, and one more of those for the cancel/change
   checks) is created here, used here, and deleted here,
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
   order_items, bookings, calls, order_status_events, menu_items and
   messages before and after and asserting they are identical. The other
   real tenant (Marty's, ba110000-0000-0000-0000-00000000000c) is
   snapshotted the same way even though nothing here has its secret or
   ever names it in a request: everything this script writes goes through
   the service role, which bypasses RLS, so the tenant nothing is
   supposed to touch is the one worth watching. */
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

/** The other real tenant. Nothing in this script ever writes to it or
 *  holds its secret -- it is here purely so the before/after audit at
 *  the bottom covers it too. "The demo location is untouched" was only
 *  ever half the promise: this script provisions tenants, places orders
 *  and now writes messages under the service role, which bypasses RLS,
 *  so a query that lost its location scope would land in whichever
 *  tenant Postgres happened to hand back -- and the only tenant that
 *  could catch that is the one nothing here is supposed to know about. */
const MARTYS_LOCATION_ID = "ba110000-0000-0000-0000-00000000000c";

/** Both real tenants, snapshotted before and after this run. */
const SEEDED_LOCATIONS = [
  { id: DEMO_LOCATION_ID, name: "Nonna Rosa" },
  { id: MARTYS_LOCATION_ID, name: "Marty's" },
];

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
// Six throwaway locations this run owns start to finish, replacing
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

// What a described dish looks like on the wire. get_menu returns an
// item's ingredients where a person wrote them into the description --
// the one field on a menu row that only a human ever fills, whether
// typed in the editor or moved there item by item out of a confirmed
// import. The demo location's fourteen items all have an empty
// description today, so the described case cannot be observed on it
// without writing to a live restaurant's menu; this canary carries it
// instead, and carries an allergen note beside it precisely so the
// check that the note never leaves the database has something real to
// fail against. The note names a real allergen in plain words: a
// substring search for it is only meaningful if a leak would actually
// spell something.
const INGREDIENT_CANARY_DESCRIPTION = "Black pepper, pecorino, guanciale";
const INGREDIENT_CANARY_ALLERGEN_NOTE = "Contains gluten and dairy; fryer is shared";

// The canary the hours checks run against: a window narrow enough that
// times either side of it are unambiguously shut, and exactly two seats,
// so one booking for two fills it and the alternatives the route offers
// have to be filtered by capacity as well as by the clock. Both numbers
// are picked so every expectation below is a fixed string, not something
// recomputed from whatever the demo location happens to be doing.
// A second location on exactly the hours canary's terms -- open 9 to 5,
// two seats, 90-minute slots -- kept separate from it so the cancel and
// change checks can fill, empty and move tables without disturbing the
// fixed strings the alternatives checks assert against. Two seats is
// what makes "a change that would exceed capacity" a one-line fixture
// rather than a dozen bookings.
const RES_CANARY_TZ = "America/Los_Angeles";
const RES_CANARY_SEATS = 2;
const RES_CANARY_SLOT_MINUTES = 90;

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
      // The described item. Its sibling below (the tax canary) is left
      // with no description on purpose, so one menu answers both halves
      // of the question: what a described item looks like, and that an
      // item nobody described costs nothing on the wire.
      description: INGREDIENT_CANARY_DESCRIPTION,
      // Reference text for staff, never for a caller. Written here so
      // "it never reaches the agent" is a check against a row that
      // really has one, not an assertion about an empty column.
      allergen_note: INGREDIENT_CANARY_ALLERGEN_NOTE,
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

  // The book the cancel/change checks rewrite. Same shape as the hours
  // canary and deliberately not the same location: those checks assert
  // fixed alternative strings that depend on exactly which of its two
  // seats are held at 9:00, and cancelling a table is precisely the
  // thing that would move them.
  const reservations = await createCanaryLocation(orgId, {
    name: "Task17 Canary Reservations (exercise-tools, ephemeral)",
    is_live: true,
    kill_switch_on: false,
    timezone: RES_CANARY_TZ,
    seats: RES_CANARY_SEATS,
    reservation_slot_minutes: RES_CANARY_SLOT_MINUTES,
  });
  await giveCanaryHours(reservations.id, {
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
    reservationsLocationId: reservations.id,
    reservationsSecret: reservations.secret,
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

async function snapshotLocation(locationId) {
  const orders = await snapshotTable("orders", (q) =>
    q.eq("location_id", locationId).order("id"),
  );
  const orderIds = orders.map((o) => o.id);
  const orderItems = orderIds.length
    ? await snapshotTable("order_items", (q) => q.in("order_id", orderIds).order("id"))
    : [];
  const orderStatusEvents = orderIds.length
    ? await snapshotTable("order_status_events", (q) => q.in("order_id", orderIds).order("id"))
    : [];
  const bookings = await snapshotTable("bookings", (q) =>
    q.eq("location_id", locationId).order("id"),
  );
  const calls = await snapshotTable("calls", (q) => q.eq("location_id", locationId).order("id"));
  const menuItems = await snapshotTable("menu_items", (q) =>
    q.eq("location_id", locationId).order("id"),
  );
  // messages is in here for the same reason menu_items is: this run now
  // writes to that table (against its own throwaway tenants), so "no
  // message of ours landed on a real restaurant's book" has to be
  // something the audit can see, not something the checks assert about
  // themselves.
  const messages = await snapshotTable("messages", (q) =>
    q.eq("location_id", locationId).order("id"),
  );
  return {
    orders,
    order_items: orderItems,
    bookings,
    calls,
    order_status_events: orderStatusEvents,
    menu_items: menuItems,
    messages,
  };
}

/** Both real tenants at once, keyed by name so the report says which one
 *  moved rather than just that something did. */
async function snapshotSeededTenants() {
  const snapshots = {};
  for (const tenant of SEEDED_LOCATIONS) {
    snapshots[tenant.name] = await snapshotLocation(tenant.id);
  }
  return snapshots;
}

const tableCounts = (snapshot) =>
  Object.fromEntries(Object.entries(snapshot).map(([table, rows]) => [table, rows.length]));

const tenantCounts = (snapshots) =>
  Object.fromEntries(Object.entries(snapshots).map(([name, snap]) => [name, tableCounts(snap)]));

// ── main ─────────────────────────────────────────────────────────────

async function main() {
  const before = await snapshotSeededTenants();
  console.log("before (seeded tenant row counts):", JSON.stringify(tenantCounts(before)));

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

  const after = await snapshotSeededTenants();
  for (const tenant of SEEDED_LOCATIONS) {
    const wasUnchanged =
      JSON.stringify(before[tenant.name]) === JSON.stringify(after[tenant.name]);
    check(
      `${tenant.name}: orders, order_items, bookings, calls, order_status_events, menu_items and messages are byte-for-byte unchanged`,
      wasUnchanged,
      wasUnchanged
        ? JSON.stringify(tableCounts(after[tenant.name]))
        : `before ${JSON.stringify(tableCounts(before[tenant.name]))}, after ${JSON.stringify(tableCounts(after[tenant.name]))}`,
    );
  }

  // ── report ────────────────────────────────────────────────────────

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  console.log(`\nafter (seeded tenant row counts):`, JSON.stringify(tenantCounts(after)));

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

  // The two newest write endpoints get the same pair. These two are the
  // only tools in the product that can destroy something a caller
  // already has, so "the shared auth gate is tested elsewhere" is not
  // good enough for either.
  const noAuthCancel = await call("cancel-reservation", {}, null);
  check("unauthenticated cancel is rejected", noAuthCancel.status === 401);
  const badAuthCancel = await call("cancel-reservation", {}, "wrong-secret");
  check("wrong secret is rejected on cancel", badAuthCancel.status === 401);

  const noAuthChange = await call("change-reservation", {}, null);
  check("unauthenticated change is rejected", noAuthChange.status === 401);
  const badAuthChange = await call("change-reservation", {}, "wrong-secret");
  check("wrong secret is rejected on change", badAuthChange.status === 401);

  // take_message is the newest write endpoint and the one every call
  // that used to reach a human now ends at, so it carries a caller's
  // name, their number and what they said -- the most personal payload
  // any tool takes. It gets the same pair, and it needs them more than
  // the rest: it is also the only write path with no Postgres function
  // under it, so `locationForSecret` returning null IS the entire
  // difference between a message and an anonymous row in somebody
  // else's book.
  const noAuthMessage = await call("message", {}, null);
  check("unauthenticated message is rejected", noAuthMessage.status === 401);
  const badAuthMessage = await call("message", {}, "wrong-secret");
  check("wrong secret is rejected on message", badAuthMessage.status === 401);

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

  // ── What a dish comes with ────────────────────────────────────────
  //
  // The agent can now describe a dish, and everything about whether that
  // is safe is decided by these bytes. Four things have to be true of the
  // payload, and none of them can be read off the demo menu alone, whose
  // descriptions are all empty: the canary provisioned above carries a
  // described item, an undescribed one, and an allergen note beside the
  // description, so all four are observable without writing a single
  // character to a live restaurant's menu.
  const canaryItems = (canaryMenu.body?.categories ?? []).flatMap((c) => c.items);
  const described = canaryItems.find((i) => i.name === "Zzyzx Canary Special");
  const undescribed = canaryItems.find((i) => i.name === TAX_CANARY_ITEM_NAME);

  // One. What a person wrote is what the agent is handed -- not a
  // summary of it, not a reordering of it. The agent reads this aloud;
  // anything but the exact words is the restaurant being quoted saying
  // something nobody at the restaurant wrote.
  check(
    "get_menu hands over the ingredients a person wrote, exactly as written",
    described?.ingredients === INGREDIENT_CANARY_DESCRIPTION,
    JSON.stringify(described),
  );

  // Two. An item nobody described costs nothing. Not `null`, not `""` --
  // no key. This is fetched on every call that mentions food and sits in
  // the latency budget, and today every one of Nonna Rosa's items would
  // be paying for an empty field.
  check(
    "an item nobody described carries no ingredients field at all",
    undescribed !== undefined && !("ingredients" in undescribed),
    JSON.stringify(undescribed),
  );

  // Three. The one that comes out of the restaurant's pocket. The
  // allergen note sits in the column next to the description on the very
  // row this payload is built from, and it is staff reference text: a
  // laminated card cannot know the fryer is shared. If it ever reached
  // the model's context, "never answer an allergy question" would be the
  // only thing between that text and a caller with coeliac disease. It
  // must not be in the bytes -- neither the note, nor the word, nor the
  // allergen it names.
  const canaryWire = JSON.stringify(canaryMenu.body ?? {});
  const demoWire = JSON.stringify(demoMenu.body ?? {});
  check(
    "the allergen note never leaves the database, on either menu",
    !canaryWire.includes(INGREDIENT_CANARY_ALLERGEN_NOTE) &&
      !canaryWire.includes("allergen") &&
      !canaryWire.includes("gluten") &&
      !demoWire.includes("allergen"),
    `canary ${canaryWire.length} bytes, demo ${demoWire.length} bytes`,
  );

  // Four. The invariant that stays true whatever anybody types into the
  // editor tomorrow: an ingredients field is either absent or it is real
  // words. A blank one read aloud is an agent saying a dish comes with
  // nothing.
  const everyItem = [...canaryItems, ...(demoMenu.body?.categories ?? []).flatMap((c) => c.items)];
  const emptyIngredients = everyItem.filter(
    (i) => "ingredients" in i && (typeof i.ingredients !== "string" || i.ingredients.trim() === ""),
  );
  check(
    "no menu ever sends an empty, blank or null ingredients field",
    emptyIngredients.length === 0,
    `${everyItem.length} items checked, ${emptyIngredients.length} empty`,
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

  // A word that answers to more than one item is a QUESTION, not a
  // refusal. This canary's two items both begin "Zzyzx", which is the
  // same shape as the failure this check exists for: at a burger shop
  // "fries" matches Hand Cut Fries and Cheese Fries, and the whole order
  // used to come back `unknown_item` -- so the agent apologised for not
  // selling fries and handed the call to a human, on most calls. The
  // names have to come back with it or the agent cannot ask which one.
  // Asserted as a set, not a list: the route reads the menu in
  // sort_order and these two canary rows do not set one.
  const ambiguousOrder = await call(
    "order",
    {
      items: [{ name: "Zzyzx", quantity: 1 }],
      type: "pickup",
      customer_name: "Task14 Canary Probe",
      customer_phone: "+15105559999",
    },
    canaries.isolatedSecret,
  );
  check(
    "a spoken word matching two items asks which one, with both names, instead of refusing as unknown",
    ambiguousOrder.status === 200 &&
      ambiguousOrder.body?.placed === false &&
      ambiguousOrder.body?.reason === "ambiguous_item" &&
      Array.isArray(ambiguousOrder.body?.options) &&
      ambiguousOrder.body.options.length === 2 &&
      ambiguousOrder.body.options.includes("Zzyzx Canary Special") &&
      ambiguousOrder.body.options.includes(TAX_CANARY_ITEM_NAME),
    JSON.stringify(ambiguousOrder.body),
  );

  // ...and the distinction is only worth anything if the other side of
  // it still holds: a word that matches nothing is still unknown_item,
  // and one that matches exactly one item still just gets ordered (the
  // orders further down this file, all of which name one item, are that
  // second half).
  const stillUnknown = await call(
    "order",
    {
      items: [{ name: "Xyzzy Nothingburger", quantity: 1 }],
      type: "pickup",
      customer_name: "Task14 Canary Probe",
      customer_phone: "+15105559999",
    },
    canaries.isolatedSecret,
  );
  check(
    "a word that matches nothing on the menu is still unknown_item, not ambiguity",
    stillUnknown.body?.placed === false &&
      stillUnknown.body?.reason === "unknown_item" &&
      stillUnknown.body?.options === undefined,
    JSON.stringify(stillUnknown.body),
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

  // ── Cancelling and changing a booking ───────────────────────────────
  //
  // Everything here runs against the reservations canary: open 9 to 5,
  // two seats, 90-minute slots, its own book to wreck. The demo
  // location is never asked to cancel or change anything -- its one
  // seeded booking is real data this run must leave byte-for-byte
  // alone, and the audit at the end proves it did.
  //
  // What is being proven is not "the happy path works". It is the list
  // of things the matching rule REFUSES, because those are what stand
  // between a phone number -- which is not a secret -- and a stranger's
  // table.

  const resDay = addDays(localDateOf(new Date(), RES_CANARY_TZ), 1);
  const resAt = (minutesOfDay) =>
    instantAtLocal(resDay, minutesOfDay, RES_CANARY_TZ).toISOString();

  /** The booking rows at the reservations canary under one first name.
   *  Read straight from the table, because a response saying "cancelled"
   *  and a row still marked confirmed is exactly the failure worth
   *  catching -- and, for every refusal below, the row is the only
   *  evidence that nothing was written. */
  const resBookings = async (name) => {
    const rows = await mustOk(
      admin
        .from("bookings")
        .select("id, customer_name, requested_at, party_size, status")
        .eq("location_id", canaries.reservationsLocationId)
        .ilike("customer_name", `${name}%`),
      `read bookings named ${name} at the reservations canary`,
    );
    return rows;
  };

  const bookAtRes = (body) => call("reservation", body, canaries.reservationsSecret);

  // ── it works at all, and it works on what a person actually says ────
  //
  // Booked with "+1 (415) 555-0101" and a full name; cancelled with
  // "4155550101", the bare first name, and a time twenty minutes off the
  // real one. That is the shape of a real call: nobody reads their
  // booking back in the format it was stored in, and a matcher that
  // demanded it would refuse every genuine caller.
  const cancelBooking = await bookAtRes({
    requested_at: resAt(9 * 60),
    party_size: 2,
    customer_name: "Cancelbee Nightingale",
    customer_phone: "+1 (415) 555-0101",
  });

  const seatsHeldBefore = await call(
    "availability",
    { requested_at: resAt(9 * 60), party_size: 2 },
    canaries.reservationsSecret,
  );

  const cancelHint = {
    customer_name: "cancelbee",
    customer_phone: "4155550101",
    booking_time: resAt(9 * 60 + 20),
  };
  const cancelled = await call("cancel-reservation", cancelHint, canaries.reservationsSecret);
  const cancelledRows = await resBookings("Cancelbee");
  check(
    "a booking is cancelled from the first name, the number as spoken, and roughly when it is",
    cancelBooking.body?.booked === true &&
      cancelled.status === 200 &&
      cancelled.body?.cancelled === true &&
      typeof cancelled.body?.when === "string" &&
      cancelledRows.length === 1 &&
      cancelledRows[0].status === "cancelled",
    `${JSON.stringify(cancelled.body)}, row status ${cancelledRows[0]?.status}`,
  );

  // A timeout is what makes an LLM call a tool twice, and the second
  // call must not tell a caller "I can't find that booking" two seconds
  // after cancelling it. public.cancel_booking answers a retry with the
  // cancellation that already exists; the route says the same sentence
  // either way, so the two responses have to be identical.
  const cancelledAgain = await call("cancel-reservation", cancelHint, canaries.reservationsSecret);
  check(
    "a retried cancel says exactly the same thing and writes nothing new",
    cancelledAgain.body?.cancelled === true &&
      cancelledAgain.body?.booking_id === cancelled.body?.booking_id &&
      cancelledAgain.body?.when === cancelled.body?.when &&
      (await resBookings("Cancelbee")).length === 1,
    `${JSON.stringify(cancelledAgain.body)}`,
  );

  // Cancelling has to give the seats back, or it is only a status
  // column. Two seats, one party of two: the slot goes from full to open
  // and the tool that decides that is the same occupancy sweep
  // create_reservation uses.
  const seatsHeldAfter = await call(
    "availability",
    { requested_at: resAt(9 * 60), party_size: 2 },
    canaries.reservationsSecret,
  );
  check(
    "cancelling actually frees the seats, not just the row's status",
    seatsHeldBefore.body?.available === false && seatsHeldAfter.body?.available === true,
    `before ${seatsHeldBefore.body?.available}, after ${seatsHeldAfter.body?.available}`,
  );

  // ── the abuse case this was designed against ────────────────────────
  //
  // A phone number is not a secret. It is on a business card, in a group
  // chat, on a delivery receipt, and in the caller ID of everyone this
  // person has ever rung. If the number plus a rough time were the key,
  // anyone holding one could empty a stranger's table -- silently, with
  // the restaurant believing the guest cancelled. So the number alone
  // must find nobody.
  const victim = await bookAtRes({
    requested_at: resAt(10 * 60 + 30),
    party_size: 2,
    customer_name: "Sofia Marchetti",
    customer_phone: "+14155550202",
  });
  const wrongName = await call(
    "cancel-reservation",
    {
      customer_name: "Marcus",
      customer_phone: "4155550202",
      booking_time: resAt(10 * 60 + 30),
    },
    canaries.reservationsSecret,
  );
  const victimAfterWrongName = await resBookings("Sofia");
  check(
    "knowing the number is not enough: the wrong name finds nobody and the table is untouched",
    victim.body?.booked === true &&
      wrongName.status === 200 &&
      wrongName.body?.cancelled === false &&
      wrongName.body?.reason === "not_found" &&
      victimAfterWrongName.length === 1 &&
      victimAfterWrongName[0].status === "confirmed",
    `${JSON.stringify(wrongName.body)}, row status ${victimAfterWrongName[0]?.status}`,
  );

  // The other half of the same abuse: everything right -- name, number,
  // time -- but dialled at a different restaurant. The location comes
  // only from the secret (lib/agent/auth.ts::locationForSecret), never
  // from anything the caller said, so a booking at another tenant is not
  // merely refused, it is invisible.
  const wrongTenant = await call(
    "cancel-reservation",
    {
      customer_name: "Sofia",
      customer_phone: "+14155550202",
      booking_time: resAt(10 * 60 + 30),
    },
    canaries.isolatedSecret,
  );
  const victimAfterWrongTenant = await resBookings("Sofia");
  check(
    "another restaurant's secret cannot cancel this restaurant's booking, however well described",
    wrongTenant.status === 200 &&
      wrongTenant.body?.cancelled === false &&
      wrongTenant.body?.reason === "not_found" &&
      victimAfterWrongTenant.length === 1 &&
      victimAfterWrongTenant[0].status === "confirmed",
    `${JSON.stringify(wrongTenant.body)}, row status ${victimAfterWrongTenant[0]?.status}`,
  );

  // ── two bookings that could both be the one meant ───────────────────
  //
  // The whole design of this agent is that it hands the call to a person
  // rather than picking. Here picking would cancel a table belonging to
  // someone who is not on the phone, so the answer is a reason the agent
  // can transfer on, and NOTHING is written.
  const ambigOne = await bookAtRes({
    requested_at: resAt(12 * 60),
    party_size: 1,
    customer_name: "Ambrose Kelly",
    customer_phone: "+14155550303",
  });
  const ambigTwo = await bookAtRes({
    requested_at: resAt(12 * 60 + 30),
    party_size: 1,
    customer_name: "Ambrose Kelly",
    customer_phone: "+14155550303",
  });
  const ambiguous = await call(
    "cancel-reservation",
    {
      customer_name: "Ambrose",
      customer_phone: "4155550303",
      booking_time: resAt(12 * 60),
    },
    canaries.reservationsSecret,
  );
  const ambigRows = await resBookings("Ambrose");
  check(
    "when two bookings could both be theirs, nothing is cancelled and the agent is told to hand over",
    ambigOne.body?.booked === true &&
      ambigTwo.body?.booked === true &&
      ambiguous.status === 200 &&
      ambiguous.body?.cancelled === false &&
      ambiguous.body?.reason === "ambiguous" &&
      ambigRows.length === 2 &&
      ambigRows.every((r) => r.status === "confirmed"),
    `${JSON.stringify(ambiguous.body)}, rows ${JSON.stringify(ambigRows.map((r) => r.status))}`,
  );

  // ── a booking that has already happened ─────────────────────────────
  //
  // Written directly, because no endpoint here will take a booking in
  // the past -- which is the point. The seats were either used or lost;
  // rewriting the night afterwards only corrupts the restaurant's own
  // record of it.
  //
  // The hint given is half an hour into the FUTURE, so the route's
  // past-time gate lets it through and the question actually reaches the
  // matcher. The booking is thirty minutes old and well inside the
  // 90-minute window either side of that hint, so the only thing keeping
  // it out of reach is `requested_at > now()` inside
  // app.matching_bookings.
  await mustOk(
    admin.from("bookings").insert({
      location_id: canaries.reservationsLocationId,
      customer_name: "Pastor Gone",
      customer_phone: "+14155550404",
      party_size: 1,
      requested_at: new Date(Date.now() - 30 * 60_000).toISOString(),
      status: "confirmed",
    }),
    "insert a past booking at the reservations canary",
  );
  const pastBooking = await call(
    "cancel-reservation",
    {
      customer_name: "Pastor",
      customer_phone: "4155550404",
      booking_time: new Date(Date.now() + 30 * 60_000).toISOString(),
    },
    canaries.reservationsSecret,
  );
  const pastRows = await resBookings("Pastor");
  check(
    "a booking that has already happened is invisible to cancel, and stays exactly as it was",
    pastBooking.status === 200 &&
      pastBooking.body?.cancelled === false &&
      pastBooking.body?.reason === "not_found" &&
      pastRows.length === 1 &&
      pastRows[0].status === "confirmed",
    `${JSON.stringify(pastBooking.body)}, row status ${pastRows[0]?.status}`,
  );

  // And the front door: a caller who names a time already gone hears
  // "that one's already past", not "I can't find it". Two different
  // sentences, because they lead to two different next questions.
  const pastHint = await call(
    "cancel-reservation",
    {
      customer_name: "Pastor",
      customer_phone: "4155550404",
      booking_time: new Date(Date.now() - 30 * 60_000).toISOString(),
    },
    canaries.reservationsSecret,
  );
  check(
    "a cancel for a time already gone is refused as a sentence, before any lookup",
    pastHint.status === 400 &&
      pastHint.body?.ok === false &&
      typeof pastHint.body?.error === "string",
    JSON.stringify(pastHint.body),
  );

  // ── changing a booking ──────────────────────────────────────────────

  // 2:00 PM, not earlier: the ambiguity pair above sits at 12:00 and
  // 12:30 and each holds a seat for a full 90-minute slot, so this
  // location's two seats are not both free again until 2:00. A fixture
  // that ignored that was refused as full, and every change check after
  // it was then asserting against a booking that did not exist.
  const mover = await bookAtRes({
    requested_at: resAt(14 * 60),
    party_size: 2,
    customer_name: "Mover Quintana",
    customer_phone: "+14155550505",
  });
  const moved = await call(
    "change-reservation",
    {
      customer_name: "Mover",
      customer_phone: "4155550505",
      booking_time: resAt(14 * 60),
      new_requested_at: resAt(15 * 60 + 30),
      new_party_size: 2,
    },
    canaries.reservationsSecret,
  );
  const movedRows = await resBookings("Mover");
  check(
    "a change moves the one booking rather than writing a second one",
    mover.body?.booked === true &&
      moved.status === 200 &&
      moved.body?.changed === true &&
      moved.body?.party_size === 2 &&
      movedRows.length === 1 &&
      movedRows[0].status === "confirmed" &&
      new Date(movedRows[0].requested_at).toISOString() === resAt(15 * 60 + 30),
    `${JSON.stringify(moved.body)}, row at ${movedRows[0]?.requested_at}`,
  );

  // The confirmation has to name the date in the restaurant's timezone,
  // like every other time this system reads a booking back: "Friday at
  // 3:30 PM" is the same sentence for this Friday and one seventeen days
  // out, and a caller can only catch a move to the wrong week if the
  // month and day are in it.
  const expectedMovedWhen = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: RES_CANARY_TZ,
  }).format(new Date(resAt(15 * 60 + 30)));
  check(
    "the change is read back with the date, in the restaurant's timezone",
    moved.body?.when === expectedMovedWhen,
    `expected ${expectedMovedWhen}, got ${JSON.stringify(moved.body?.when)}`,
  );

  // ── a change is a capacity question, not an edit ────────────────────
  //
  // Two seats, and the party of two that just moved to 3:30 is holding
  // both of them. A naive UPDATE would write the new time onto this row
  // and the book would now promise four seats in a two-seat room. The
  // booking must come back from this exactly where it started.
  const blocked = await bookAtRes({
    requested_at: resAt(9 * 60),
    party_size: 2,
    customer_name: "Blocker Rossi",
    customer_phone: "+14155550606",
  });
  const intoFullSlot = await call(
    "change-reservation",
    {
      customer_name: "Blocker",
      customer_phone: "4155550606",
      booking_time: resAt(9 * 60),
      new_requested_at: resAt(15 * 60 + 30),
      new_party_size: 2,
    },
    canaries.reservationsSecret,
  );
  const blockedAfterFull = await resBookings("Blocker");
  check(
    "a change into a slot with no seats is refused, and the booking stays exactly where it was",
    blocked.body?.booked === true &&
      intoFullSlot.status === 200 &&
      intoFullSlot.body?.changed === false &&
      intoFullSlot.body?.reason === "full" &&
      blockedAfterFull.length === 1 &&
      new Date(blockedAfterFull[0].requested_at).toISOString() === resAt(9 * 60),
    `${JSON.stringify(intoFullSlot.body)}, row at ${blockedAfterFull[0]?.requested_at}`,
  );

  // The same three gates create_reservation applies to a new booking,
  // applied to a moved one: the restaurant has to be open then, the time
  // has to be in the future, and the party has to fit the house's own
  // limit. Each leaves the booking untouched.
  const intoClosedHours = await call(
    "change-reservation",
    {
      customer_name: "Blocker",
      customer_phone: "4155550606",
      booking_time: resAt(9 * 60),
      new_requested_at: resAt(3 * 60),
    },
    canaries.reservationsSecret,
  );
  check(
    "a change to a time the restaurant is shut is refused with that day's real hours",
    intoClosedHours.status === 200 &&
      intoClosedHours.body?.changed === false &&
      intoClosedHours.body?.reason === "closed" &&
      intoClosedHours.body?.hours_that_day === "9:00 AM to 5:00 PM",
    JSON.stringify(intoClosedHours.body),
  );

  const intoPast = await call(
    "change-reservation",
    {
      customer_name: "Blocker",
      customer_phone: "4155550606",
      booking_time: resAt(9 * 60),
      new_requested_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    },
    canaries.reservationsSecret,
  );
  check(
    "a change to a time already gone is refused as a sentence",
    intoPast.status === 400 && intoPast.body?.ok === false,
    JSON.stringify(intoPast.body),
  );

  const intoBigParty = await call(
    "change-reservation",
    {
      customer_name: "Blocker",
      customer_phone: "4155550606",
      booking_time: resAt(9 * 60),
      new_requested_at: resAt(10 * 60 + 30),
      new_party_size: 99,
    },
    canaries.reservationsSecret,
  );
  check(
    "a change to a party over the house limit gets the same large_party reason booking does",
    intoBigParty.status === 200 &&
      intoBigParty.body?.changed === false &&
      intoBigParty.body?.reason === "large_party",
    JSON.stringify(intoBigParty.body),
  );

  // The abuse case again, on the endpoint that moves tables rather than
  // destroying them -- a stranger who could move somebody's table to
  // 3:00 has taken it away just as effectively.
  const changeWrongName = await call(
    "change-reservation",
    {
      customer_name: "Marcus",
      customer_phone: "4155550606",
      booking_time: resAt(9 * 60),
      new_requested_at: resAt(10 * 60 + 30),
    },
    canaries.reservationsSecret,
  );
  const changeWrongTenant = await call(
    "change-reservation",
    {
      customer_name: "Blocker",
      customer_phone: "+14155550606",
      booking_time: resAt(9 * 60),
      new_requested_at: resAt(10 * 60 + 30),
    },
    canaries.isolatedSecret,
  );
  const blockerFinal = await resBookings("Blocker");
  check(
    "neither the wrong name nor another restaurant's secret can move this booking, and it has not moved",
    changeWrongName.body?.changed === false &&
      changeWrongName.body?.reason === "not_found" &&
      changeWrongTenant.body?.changed === false &&
      changeWrongTenant.body?.reason === "not_found" &&
      blockerFinal.length === 1 &&
      new Date(blockerFinal[0].requested_at).toISOString() === resAt(9 * 60),
    `${JSON.stringify(changeWrongName.body)} / ${JSON.stringify(changeWrongTenant.body)}, row at ${blockerFinal[0]?.requested_at}`,
  );

  // ── a misheard caller gets asked again, not a 500 ──────────────────
  //
  // app.caller_name_key and app.caller_phone_key
  // (supabase/migrations/20260812000800_cancel_change_reservation.sql)
  // reduce a name to its letters and a phone number to its digits, and
  // return NULL -- which cancel_booking/change_booking then answer with
  // `missing_details` -- when nothing usable survives: a name
  // transcribed as "22", a phone heard as five digits. Before this check
  // existed, both routes only guarded `!body.customer_name ||
  // !body.customer_phone`, which a non-empty garbled string sails past;
  // the request then reached the database, came back `missing_details`,
  // and fell through to the log-and-500 branch -- a caller who was just
  // misheard hearing "I can't get to the book right now" instead of
  // being asked again. lib/agent/caller.ts::hasUsableCallerName /
  // hasUsableCallerPhone now catch this in the route, before the call,
  // and answer it the way every other unheard field is answered.
  //
  // "Blocker" is reused deliberately: its booking is still sitting at
  // 9:00 from the change checks just above, so this also proves an
  // unusable-detail attempt never reaches far enough to touch it.
  const unusableNameCancel = await call(
    "cancel-reservation",
    { customer_name: "22", customer_phone: "4155550606", booking_time: resAt(9 * 60) },
    canaries.reservationsSecret,
  );
  check(
    "cancel-reservation asks again, not a 500, when the name transcribed to nothing usable",
    unusableNameCancel.status === 400 &&
      unusableNameCancel.body?.ok === false &&
      typeof unusableNameCancel.body?.error === "string",
    JSON.stringify(unusableNameCancel.body),
  );

  const unusablePhoneCancel = await call(
    "cancel-reservation",
    { customer_name: "Blocker", customer_phone: "55511", booking_time: resAt(9 * 60) },
    canaries.reservationsSecret,
  );
  check(
    "cancel-reservation asks again, not a 500, when the phone was heard as fewer than seven digits",
    unusablePhoneCancel.status === 400 &&
      unusablePhoneCancel.body?.ok === false &&
      typeof unusablePhoneCancel.body?.error === "string",
    JSON.stringify(unusablePhoneCancel.body),
  );

  const unusableNameChange = await call(
    "change-reservation",
    {
      customer_name: "###",
      customer_phone: "4155550606",
      booking_time: resAt(9 * 60),
      new_requested_at: resAt(10 * 60 + 30),
    },
    canaries.reservationsSecret,
  );
  check(
    "change-reservation asks again, not a 500, when the name transcribed to nothing usable",
    unusableNameChange.status === 400 &&
      unusableNameChange.body?.ok === false &&
      typeof unusableNameChange.body?.error === "string",
    JSON.stringify(unusableNameChange.body),
  );

  const unusablePhoneChange = await call(
    "change-reservation",
    {
      customer_name: "Blocker",
      customer_phone: "12345",
      booking_time: resAt(9 * 60),
      new_requested_at: resAt(10 * 60 + 30),
    },
    canaries.reservationsSecret,
  );
  check(
    "change-reservation asks again, not a 500, when the phone was heard as fewer than seven digits",
    unusablePhoneChange.status === 400 &&
      unusablePhoneChange.body?.ok === false &&
      typeof unusablePhoneChange.body?.error === "string",
    JSON.stringify(unusablePhoneChange.body),
  );

  const blockerAfterUnusableAttempts = await resBookings("Blocker");
  check(
    "none of the unusable-detail attempts above wrote or moved anything",
    blockerAfterUnusableAttempts.length === 1 &&
      blockerAfterUnusableAttempts[0].status === "confirmed" &&
      new Date(blockerAfterUnusableAttempts[0].requested_at).toISOString() === resAt(9 * 60),
    `row ${JSON.stringify(blockerAfterUnusableAttempts[0])}`,
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

  // ── Messages ────────────────────────────────────────────────────────
  //
  // The counterweight to the transfer above. transfer_to_human is now
  // only for catering and allergies, so every other call that used to
  // reach a person -- an upset caller, "put me through to a manager", a
  // complaint about last Friday's order, speech the agent still cannot
  // make out after two tries -- ends at take_message instead. If this
  // route quietly writes nothing, the caller is told somebody will ring
  // them back and nobody ever does, which is worse than the transfer it
  // replaces. So these checks read the row back from the database, not
  // the response: the response says `{taken: true}` and nothing else, on
  // purpose.
  //
  // All of them run against throwaway canary tenants. A message written
  // to a real restaurant's book is a person the staff would try to ring.

  // A message nobody can return is not a message. Missing details are
  // the same kind of failure as a misheard name anywhere else -- a
  // question the caller can answer -- so this is agentFail, not a
  // business decision the agent reads out, and nothing is written.
  const messageNoNumber = await call(
    "message",
    {
      caller_name: "Task18 Message Nobody",
      message: "Somebody should call me about last Friday.",
    },
    canaries.isolatedSecret,
  );
  const afterNoNumber = await mustOk(
    admin.from("messages").select("id").eq("location_id", canaries.isolatedLocationId),
    "count messages after the incomplete one",
  );
  check(
    "a message with no callback number is asked about again, and nothing is written",
    messageNoNumber.status === 400 &&
      messageNoNumber.body?.ok === false &&
      typeof messageNoNumber.body?.error === "string" &&
      afterNoNumber.length === 0,
    `${JSON.stringify(messageNoNumber.body)}, ${afterNoNumber.length} row(s)`,
  );

  // A calls row at the tenant the message is taken for, so the stored
  // message can be checked for hanging off the right call -- and so the
  // cross-tenant check below is not vacuously passing against a route
  // that never attaches a call to anything.
  const messageCallSuffix = Date.now();
  const ownProviderCallId = `task18-own-${messageCallSuffix}`;
  const ownCall = await mustOk(
    admin
      .from("calls")
      .insert({
        location_id: canaries.isolatedLocationId,
        twilio_call_sid: `task18-own-sid-${messageCallSuffix}`,
        provider_call_id: ownProviderCallId,
      })
      .select("id")
      .single(),
    "insert canary call for the message checks",
  );

  const takenName = "Task18 Message Caller";
  const takenBody = "The order last Friday was cold and nobody called me back.";
  const taken = await call(
    "message",
    {
      caller_name: takenName,
      callback_number: "+1 510 555 0143",
      message: takenBody,
      provider_call_id: ownProviderCallId,
    },
    canaries.isolatedSecret,
  );
  const takenRows = await mustOk(
    admin.from("messages").select("*").eq("location_id", canaries.isolatedLocationId),
    "read back the message just taken",
  );
  const takenRow = takenRows.find((m) => m.caller_name === takenName);
  check(
    "take_message stores the message against the location its secret resolved to, on that location's own call",
    taken.status === 200 &&
      taken.body?.ok === true &&
      taken.body?.taken === true &&
      takenRows.length === 1 &&
      takenRow?.location_id === canaries.isolatedLocationId &&
      takenRow?.call_id === ownCall.id &&
      takenRow?.callback_phone === "+1 510 555 0143" &&
      takenRow?.body === takenBody &&
      takenRow?.handled === false &&
      takenRow?.handled_at === null,
    `${JSON.stringify(taken.body)}, row ${JSON.stringify(takenRow)}`,
  );

  // provider_call_id arrives in a request body, and this route runs
  // under the service role with RLS bypassed, so the only thing stopping
  // a body value from hanging a caller's name, number and complaint off
  // another restaurant's call is that the lookup is scoped by the
  // location the secret resolved to (lib/agent/context.ts). Proven from
  // the outside: a real calls row at a DIFFERENT canary tenant, named in
  // a request authenticated as this one.
  //
  // The message must still be written -- a caller is on the phone and
  // has been promised a callback, and whose call row it belongs to is
  // not their problem -- but it must land at this tenant with no call
  // attached, and it must not appear in the other tenant's book at all.
  const otherProviderCallId = `task18-other-${messageCallSuffix}`;
  const otherCall = await mustOk(
    admin
      .from("calls")
      .insert({
        location_id: canaries.reservationsLocationId,
        twilio_call_sid: `task18-other-sid-${messageCallSuffix}`,
        provider_call_id: otherProviderCallId,
      })
      .select("id")
      .single(),
    "insert another tenant's call for the cross-tenant message check",
  );

  const crossTenantName = "Task18 Cross Tenant";
  const crossTenant = await call(
    "message",
    {
      caller_name: crossTenantName,
      callback_number: "+15105550144",
      message: "Hang this off somebody else's call.",
      // Not this tenant's call. Also, deliberately, a location_id in the
      // body -- which nothing anywhere is allowed to trust.
      provider_call_id: otherProviderCallId,
      location_id: canaries.reservationsLocationId,
    },
    canaries.isolatedSecret,
  );
  const crossRows = await mustOk(
    admin.from("messages").select("*").eq("location_id", canaries.isolatedLocationId),
    "read back messages after the cross-tenant attempt",
  );
  const crossRow = crossRows.find((m) => m.caller_name === crossTenantName);
  const otherTenantMessages = await mustOk(
    admin.from("messages").select("id, call_id").eq("location_id", canaries.reservationsLocationId),
    "count messages at the other canary tenant",
  );
  check(
    "a message naming another restaurant's call is written to its own tenant with no call attached, never to theirs",
    crossTenant.status === 200 &&
      crossTenant.body?.taken === true &&
      crossRow?.location_id === canaries.isolatedLocationId &&
      crossRow?.call_id === null &&
      otherTenantMessages.length === 0 &&
      !crossRows.some((m) => m.call_id === otherCall.id),
    `${JSON.stringify(crossTenant.body)}, row ${JSON.stringify(crossRow)}, other tenant has ${otherTenantMessages.length} message(s)`,
  );

  // No card numbers in any column, payload or log line. A complaint
  // about a charge is the likeliest way one ever reaches this database
  // -- the caller reads the number off the card while explaining -- and
  // this is the newest free-text write path for words a caller actually
  // said, so it is scrubbed before it is anywhere near a column.
  const cardName = "Task18 Card Complaint";
  const cardMessage = await call(
    "message",
    {
      caller_name: cardName,
      callback_number: "+15105550145",
      message: "You charged 4111 1111 1111 1111 twice on Friday.",
      provider_call_id: ownProviderCallId,
    },
    canaries.isolatedSecret,
  );
  const cardRows = await mustOk(
    admin.from("messages").select("*").eq("location_id", canaries.isolatedLocationId),
    "read back the redacted message",
  );
  const cardRow = cardRows.find((m) => m.caller_name === cardName);
  check(
    "a card number read into a message is redacted before it is stored, and never echoed back",
    cardMessage.status === 200 &&
      cardMessage.body?.taken === true &&
      cardRow?.body === "You charged [redacted] twice on Friday." &&
      !JSON.stringify(cardRow).includes("4111") &&
      !JSON.stringify(cardMessage.body ?? {}).includes("4111"),
    `${JSON.stringify(cardMessage.body)}, row body ${JSON.stringify(cardRow?.body)}`,
  );

  // ...and the other side of that rule, which is the trap the redactor
  // fell into once already: an overseas callback number reaches thirteen
  // digits the moment the dial-out prefix is spoken, so scrubbing the
  // phone field the way the body is scrubbed turned every overseas
  // caller's number into "[redacted]" -- which has no digits, so the
  // agent asked for it again, and again. The number keeps its digits;
  // only a run that is actually a card is refused.
  const overseasName = "Task18 Overseas Caller";
  const overseasNumber = "011 44 20 7946 0958";
  const overseasMessage = await call(
    "message",
    {
      caller_name: overseasName,
      callback_number: overseasNumber,
      message: "Calling from London about a large booking next month.",
    },
    canaries.isolatedSecret,
  );
  const overseasRows = await mustOk(
    admin.from("messages").select("*").eq("location_id", canaries.isolatedLocationId),
    "read back the overseas message",
  );
  const overseasRow = overseasRows.find((m) => m.caller_name === overseasName);
  check(
    "an overseas callback number is stored as said, not redacted into a number nobody can ring",
    overseasMessage.status === 200 &&
      overseasMessage.body?.taken === true &&
      overseasRow?.callback_phone === overseasNumber,
    `${JSON.stringify(overseasMessage.body)}, stored ${JSON.stringify(overseasRow?.callback_phone)}`,
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
