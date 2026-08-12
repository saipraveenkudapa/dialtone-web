# Voice Agent Tools & Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Vapi voice agent the six tools and the per-restaurant system prompt it needs to answer a real call, so that every menu fact it speaks comes live from our database and never from the model.

**Architecture:** Vapi holds the call (STT, turn-taking, barge-in, TTS) and calls HTTPS tool endpoints in this Next.js app. Each endpoint authenticates with a per-location shared secret, resolves the location and the in-flight call row, does one focused database operation with the service role, and returns a small JSON result shaped for speech. Nothing about the menu is ever baked into the prompt.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Supabase Postgres (service role, server-side only), Vitest for unit tests, Twilio REST for order notifications, Vapi as the voice runtime.

## Global Constraints

- Money is integer cents everywhere. Never a float. Format for speech as dollars only at the edge.
- Timestamps are `timestamptz` in UTC. Every value spoken or compared is rendered in the location's own `timezone`.
- No column, payload, log line, or transcript may hold a card number. Payment is an SMS link. This keeps the database out of PCI scope.
- Tool endpoints use the service role and therefore bypass RLS. Every one of them MUST scope its query by the `location_id` resolved from the authenticated secret. Never trust a `location_id` supplied in the request body.
- The agent may only name items and prices returned by `get_menu` in that same call. No caching into the prompt, no cross-call reuse.
- Allergy questions are never answered. They transfer. There are no exceptions.
- Inbound only. No endpoint in this plan may originate a call or text a customer. Order notifications go to the restaurant's own staff number only.
- `transfer_to_human` must succeed even when every other part of the system is failing. It has no database dependency on its happy path.
- Existing design rules in `AGENTS.md` still apply to any UI touched here.

## File Structure

| File | Responsibility |
|---|---|
| `vitest.config.ts` | Test runner config, node environment |
| `lib/agent/auth.ts` | Verify the per-location shared secret, timing-safe; resolve the location |
| `lib/agent/context.ts` | Turn a tool request into `{location, call}`; find the in-flight call row |
| `lib/agent/respond.ts` | Uniform JSON success/error envelope shaped for speech |
| `lib/agent/menu.ts` | Read the live menu, split available vs sold out, suggest alternatives |
| `lib/agent/hours.ts` | Today's hours including holiday overrides, open-now, next open time |
| `lib/agent/availability.ts` | Reservation capacity maths for a slot |
| `lib/agent/orders.ts` | Resolve spoken item names to menu rows, price an order, write it |
| `lib/agent/notify.ts` | Send the order to the restaurant's staff number via Twilio SMS |
| `lib/agent/prompt.ts` | Fill the system prompt template from a location row |
| `app/api/agent/menu/route.ts` | `get_menu` |
| `app/api/agent/hours/route.ts` | `get_hours` |
| `app/api/agent/availability/route.ts` | `check_availability` |
| `app/api/agent/reservation/route.ts` | `create_reservation` |
| `app/api/agent/order/route.ts` | `place_order` |
| `app/api/agent/transfer/route.ts` | `transfer_to_human` |
| `app/api/agent/assistant/route.ts` | Returns prompt + greeting + tool config for a location |
| `scripts/provision-vapi.mjs` | Create/update the Vapi assistant for a location |
| `docs/vapi-setup.md` | How to wire a number, and the pre-launch call script |

---

### Task 1: Test harness

**Files:**
- Create: `vitest.config.ts`
- Create: `lib/agent/respond.ts`
- Create: `lib/agent/respond.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: nothing
- Produces: `agentOk(data: object): Response`, `agentFail(message: string, status?: number): Response`. Every tool route returns one of these. `agentOk` emits `{ok: true, ...data}`; `agentFail` emits `{ok: false, error: message}`.

- [ ] **Step 1: Install Vitest**

```bash
npm install --save-dev vitest
```

- [ ] **Step 2: Write the config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
```

- [ ] **Step 3: Add the test scripts**

In `package.json`, set `"scripts"` to:

```json
{
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 4: Write the failing test**

Create `lib/agent/respond.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { agentOk, agentFail } from "./respond";

describe("agent responses", () => {
  it("wraps data in an ok envelope", async () => {
    const res = agentOk({ items: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, items: [] });
  });

  it("reports failure with a spoken-friendly message", async () => {
    const res = agentFail("Something went wrong", 500);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "Something went wrong" });
  });

  it("defaults a failure to 400", () => {
    expect(agentFail("nope").status).toBe(400);
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "./respond"`

- [ ] **Step 6: Write the implementation**

Create `lib/agent/respond.ts`:

```ts
/** One envelope for every tool endpoint.
 *
 *  The agent reads these values out loud, so an error must be a sentence
 *  a person can hear, never a stack trace or a code. */
export function agentOk(data: Record<string, unknown>) {
  return Response.json({ ok: true, ...data });
}

export function agentFail(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status });
}
```

- [ ] **Step 7: Run it and watch it pass**

Run: `npm test`
Expected: PASS — 3 tests

- [ ] **Step 8: Commit**

```bash
git add vitest.config.ts package.json package-lock.json lib/agent/respond.ts lib/agent/respond.test.ts
git commit -m "test: add vitest and the agent response envelope"
```

---

### Task 2: Agent configuration columns

**Files:**
- Create: `supabase/migrations/20260812000100_agent_config.sql`
- Modify: `lib/supabase/types.ts` (extend `LocationRow`)

**Interfaces:**
- Consumes: existing `locations`, `calls`, `bookings` tables
- Produces: `locations.agent_secret_hash`, `locations.tax_rate_bps`, `locations.seats`, `locations.reservation_slot_minutes`, `locations.max_party_size`, `locations.order_types`; `calls.provider_call_id`; `bookings.party_size` unchanged. `LocationRow` gains the same fields with types `string | null`, `number`, `number`, `number`, `number`, `"pickup" | "delivery" | "both"`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260812000100_agent_config.sql`:

```sql
-- Everything the voice agent needs that the schema did not yet hold.

alter table locations
  -- Per-location shared secret for the tool endpoints, stored as a
  -- SHA-256 hash. A leaked database dump must not yield a working key,
  -- and one restaurant's secret must never open another's tools.
  add column agent_secret_hash text,
  -- Sales tax in basis points (875 = 8.75%), so totals stay integer.
  add column tax_rate_bps integer not null default 0
    check (tax_rate_bps between 0 and 2000),
  add column seats integer not null default 40 check (seats > 0),
  add column reservation_slot_minutes integer not null default 90
    check (reservation_slot_minutes between 30 and 240),
  add column max_party_size integer not null default 8
    check (max_party_size between 1 and 40),
  add column order_types text not null default 'pickup'
    check (order_types in ('pickup', 'delivery', 'both'));

-- Vapi's own call id, so a tool call can find the call row we created
-- from the Twilio webhook.
alter table calls
  add column provider_call_id text;

create unique index calls_provider_call_id_idx
  on calls (provider_call_id)
  where provider_call_id is not null;

-- The reservation capacity query reads by location and time window.
create index bookings_location_requested_idx
  on bookings (location_id, requested_at)
  where status in ('requested', 'confirmed', 'seated');
```

- [ ] **Step 2: Apply it**

Run:

```bash
npx supabase db push
```

If the Supabase CLI is not installed, apply the file's contents through the Supabase dashboard SQL editor instead. Expected: success, no error.

- [ ] **Step 3: Verify the columns exist**

Run this in the SQL editor:

```sql
select column_name from information_schema.columns
where table_name = 'locations'
  and column_name in ('agent_secret_hash','tax_rate_bps','seats',
                      'reservation_slot_minutes','max_party_size','order_types')
order by column_name;
```

Expected: 6 rows.

- [ ] **Step 4: Extend the row type**

In `lib/supabase/types.ts`, add these fields to `LocationRow`:

```ts
  agent_secret_hash: string | null;
  tax_rate_bps: number;
  seats: number;
  reservation_slot_minutes: number;
  max_party_size: number;
  order_types: "pickup" | "delivery" | "both";
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260812000100_agent_config.sql lib/supabase/types.ts
git commit -m "feat: add agent configuration columns to locations and calls"
```

---

### Task 3: Tool authentication

**Files:**
- Create: `lib/agent/auth.ts`
- Create: `lib/agent/auth.test.ts`

**Interfaces:**
- Consumes: `supabaseAdmin()` from `lib/supabase/admin.ts`; `locations.agent_secret_hash`
- Produces: `hashAgentSecret(secret: string): string` (hex SHA-256), `locationForSecret(secret: string | null): Promise<LocationRow | null>`, `agentSecretFromRequest(request: Request): string | null` (reads `x-dialtone-secret`)

- [ ] **Step 1: Write the failing test**

Create `lib/agent/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashAgentSecret, agentSecretFromRequest } from "./auth";

describe("agent auth", () => {
  it("hashes a secret to stable hex", () => {
    const a = hashAgentSecret("swordfish");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentSecret("swordfish")).toBe(a);
  });

  it("gives different secrets different hashes", () => {
    expect(hashAgentSecret("a")).not.toBe(hashAgentSecret("b"));
  });

  it("reads the secret header", () => {
    const req = new Request("https://x.test", {
      headers: { "x-dialtone-secret": "swordfish" },
    });
    expect(agentSecretFromRequest(req)).toBe("swordfish");
  });

  it("returns null when the header is missing", () => {
    expect(agentSecretFromRequest(new Request("https://x.test"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test lib/agent/auth.test.ts`
Expected: FAIL — cannot resolve `./auth`

- [ ] **Step 3: Write the implementation**

Create `lib/agent/auth.ts`:

```ts
import "server-only";

import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { LocationRow } from "@/lib/supabase/types";

const HEADER = "x-dialtone-secret";

/** Stored as a hash so a database dump does not yield working keys. */
export function hashAgentSecret(secret: string) {
  return crypto.createHash("sha256").update(secret, "utf-8").digest("hex");
}

export function agentSecretFromRequest(request: Request) {
  return request.headers.get(HEADER);
}

/** The location this secret belongs to, or null.
 *
 *  The secret is the ONLY thing that decides which restaurant a tool call
 *  can touch. A location_id in the request body is never trusted: the
 *  agent is one shared process serving every restaurant, so a body value
 *  would let a confused or hostile call reach another tenant's menu. */
export async function locationForSecret(secret: string | null) {
  if (!secret) return null;

  const { data, error } = await supabaseAdmin()
    .from("locations")
    .select("*")
    .eq("agent_secret_hash", hashAgentSecret(secret))
    .maybeSingle();

  if (error) {
    console.error("[agent] secret lookup failed", error);
    return null;
  }
  return (data as LocationRow) ?? null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test lib/agent/auth.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add lib/agent/auth.ts lib/agent/auth.test.ts
git commit -m "feat: authenticate agent tool calls with a per-location secret"
```

---

### Task 4: Menu tool

**Files:**
- Create: `lib/agent/menu.ts`
- Create: `lib/agent/menu.test.ts`
- Create: `app/api/agent/menu/route.ts`

**Interfaces:**
- Consumes: `agentOk`/`agentFail`, `locationForSecret`, `agentSecretFromRequest`
- Produces: `shapeMenu(categories: MenuCategoryWithItems[]): AgentMenu` where `AgentMenu = {categories: {name: string, items: {name: string, price: string, sold_out: boolean}[]}[], sold_out: string[]}`; `suggestAlternative(menu: AgentMenu, itemName: string): string | null`

- [ ] **Step 1: Write the failing test**

Create `lib/agent/menu.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shapeMenu, suggestAlternative } from "./menu";

import type { MenuCategoryWithItems } from "@/lib/data";

const category = (items: MenuCategoryWithItems["items"]) =>
  [
    {
      id: "c1",
      location_id: "l1",
      name: "Wings",
      sort_order: 1,
      created_at: "2026-08-12T00:00:00Z",
      items,
    },
  ] as MenuCategoryWithItems[];

const item = (
  id: string,
  name: string,
  price_cents: number,
  sold_out_until: "close" | "reopen" | null,
) =>
  ({
    id,
    category_id: "c1",
    location_id: "l1",
    name,
    description: null,
    price_cents,
    sold_out_until,
    allergen_note: null,
    sort_order: 1,
    updated_at: "2026-08-12T00:00:00Z",
  }) as MenuCategoryWithItems["items"][number];

const buffalo = item("i1", "Buffalo Wings", 1400, "close");
const boneless = item("i2", "Boneless Wings", 1200, null);
const categories = category([buffalo, boneless]);

describe("menu shaping", () => {
  it("speaks prices as dollars, not cents", () => {
    const menu = shapeMenu(categories);
    expect(menu.categories[0].items[1].price).toBe("$12.00");
  });

  it("marks sold out items and lists them", () => {
    const menu = shapeMenu(categories);
    expect(menu.categories[0].items[0].sold_out).toBe(true);
    expect(menu.sold_out).toEqual(["Buffalo Wings"]);
  });

  it("suggests the nearest available item in the same category", () => {
    const menu = shapeMenu(categories);
    expect(suggestAlternative(menu, "Buffalo Wings")).toBe("Boneless Wings");
  });

  it("suggests nothing when the whole category is out", () => {
    const allOut = shapeMenu(category([buffalo]));
    expect(suggestAlternative(allOut, "Buffalo Wings")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test lib/agent/menu.test.ts`
Expected: FAIL — cannot resolve `./menu`

- [ ] **Step 3: Write the implementation**

Create `lib/agent/menu.ts`:

```ts
import type { MenuCategoryWithItems } from "@/lib/data";

export type AgentMenuItem = { name: string; price: string; sold_out: boolean };
export type AgentMenu = {
  categories: { name: string; items: AgentMenuItem[] }[];
  sold_out: string[];
};

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The menu as the agent should hear it: names, spoken prices, and an
 *  explicit sold-out flag. Sold-out items are still included so the agent
 *  can say "we're out of that" instead of "we don't have that" -- the
 *  second sounds like the caller misremembered the restaurant. */
export function shapeMenu(categories: MenuCategoryWithItems[]): AgentMenu {
  const soldOut: string[] = [];

  const shaped = categories.map((category) => ({
    name: category.name,
    items: category.items.map((item) => {
      const isOut = item.sold_out_until !== null;
      if (isOut) soldOut.push(item.name);
      return {
        name: item.name,
        price: dollars(item.price_cents),
        sold_out: isOut,
      };
    }),
  }));

  return { categories: shaped, sold_out: soldOut };
}

/** The nearest available item in the same category, which is what saves
 *  the sale when something runs out. */
export function suggestAlternative(menu: AgentMenu, itemName: string) {
  const needle = itemName.trim().toLowerCase();

  for (const category of menu.categories) {
    const match = category.items.some((i) => i.name.toLowerCase() === needle);
    if (!match) continue;
    const available = category.items.find(
      (i) => !i.sold_out && i.name.toLowerCase() !== needle,
    );
    return available?.name ?? null;
  }
  return null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test lib/agent/menu.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Write the route**

Create `app/api/agent/menu/route.ts`:

```ts
import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { shapeMenu, suggestAlternative } from "@/lib/agent/menu";
import type { MenuCategoryRow, MenuItemRow } from "@/lib/supabase/types";

/** get_menu. Called live on every call that mentions food, never cached
 *  into the prompt. This endpoint is the only reason the agent cannot
 *  invent an item or a price. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const supabase = supabaseAdmin();
  const [categories, items] = await Promise.all([
    supabase
      .from("menu_categories")
      .select("*")
      .eq("location_id", location.id)
      .order("sort_order"),
    supabase
      .from("menu_items")
      .select("*")
      .eq("location_id", location.id)
      .order("sort_order"),
  ]);

  if (categories.error || items.error) {
    console.error("[agent] menu read failed", categories.error ?? items.error);
    return agentFail("I can't pull the menu up right now.", 500);
  }

  const byCategory = new Map<string, MenuItemRow[]>();
  for (const item of (items.data ?? []) as MenuItemRow[]) {
    const list = byCategory.get(item.category_id) ?? [];
    list.push(item);
    byCategory.set(item.category_id, list);
  }

  const menu = shapeMenu(
    ((categories.data ?? []) as MenuCategoryRow[]).map((c) => ({
      ...c,
      items: byCategory.get(c.id) ?? [],
    })),
  );

  const body = (await request.json().catch(() => ({}))) as { item?: string };
  const alternative = body.item ? suggestAlternative(menu, body.item) : null;

  return agentOk({ ...menu, alternative });
}
```

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/agent/menu.ts lib/agent/menu.test.ts app/api/agent/menu/route.ts
git commit -m "feat: get_menu tool reads the live menu on every call"
```

---

### Task 5: Hours tool

**Files:**
- Create: `lib/agent/hours.ts`
- Create: `lib/agent/hours.test.ts`
- Create: `app/api/agent/hours/route.ts`

**Interfaces:**
- Consumes: `agentOk`/`agentFail`, `locationForSecret`
- Produces: `openState(args: {now: Date, timezone: string, hours: HoursRow[], holidays: HolidayRow[]}): {open_now: boolean, today: string, next_open: string | null}` where `HoursRow = {day_of_week: number, open_time: string | null, close_time: string | null, is_closed: boolean}` and `HolidayRow = {date: string, is_closed: boolean, open_time: string | null, close_time: string | null}`

- [ ] **Step 1: Write the failing test**

Create `lib/agent/hours.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { openState } from "./hours";

const week = Array.from({ length: 7 }, (_, day) => ({
  day_of_week: day,
  open_time: "17:00:00",
  close_time: "22:30:00",
  is_closed: day === 1,
}));

const tz = "America/Los_Angeles";

describe("open state", () => {
  it("is open inside the window", () => {
    // 2026-08-12 is a Wednesday; 19:00 Los Angeles is 02:00 UTC next day.
    const state = openState({
      now: new Date("2026-08-13T02:00:00Z"),
      timezone: tz,
      hours: week,
      holidays: [],
    });
    expect(state.open_now).toBe(true);
    expect(state.today).toBe("5:00 PM to 10:30 PM");
  });

  it("is closed before opening and says when it opens", () => {
    const state = openState({
      now: new Date("2026-08-12T19:00:00Z"), // 12:00 PM Los Angeles
      timezone: tz,
      hours: week,
      holidays: [],
    });
    expect(state.open_now).toBe(false);
    expect(state.next_open).toBe("today at 5:00 PM");
  });

  it("honours a closed weekday", () => {
    const state = openState({
      now: new Date("2026-08-11T02:00:00Z"), // Monday 7pm Los Angeles
      timezone: tz,
      hours: week,
      holidays: [],
    });
    expect(state.open_now).toBe(false);
    expect(state.today).toBe("closed");
  });

  it("lets a holiday override the weekday", () => {
    const state = openState({
      now: new Date("2026-08-13T02:00:00Z"),
      timezone: tz,
      hours: week,
      holidays: [{ date: "2026-08-12", is_closed: true, open_time: null, close_time: null }],
    });
    expect(state.open_now).toBe(false);
    expect(state.today).toBe("closed");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test lib/agent/hours.test.ts`
Expected: FAIL — cannot resolve `./hours`

- [ ] **Step 3: Write the implementation**

Create `lib/agent/hours.ts`:

```ts
export type HoursRow = {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean;
};

export type HolidayRow = {
  date: string;
  is_closed: boolean;
  open_time: string | null;
  close_time: string | null;
};

/** Wall-clock parts of `now` in the location's timezone. Doing this with
 *  Intl rather than date maths keeps it correct across DST, which matters
 *  because "are you open" is asked most on the evenings that shift. */
function localParts(now: Date, timezone: string) {
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
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    dayOfWeek: days.indexOf(parts.weekday as string),
  };
}

const toMinutes = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

const spoken = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
};

export function openState({
  now,
  timezone,
  hours,
  holidays,
}: {
  now: Date;
  timezone: string;
  hours: HoursRow[];
  holidays: HolidayRow[];
}) {
  const local = localParts(now, timezone);

  const holiday = holidays.find((h) => h.date === local.date);
  const weekday = hours.find((h) => h.day_of_week === local.dayOfWeek);

  const today = holiday
    ? {
        is_closed: holiday.is_closed,
        open_time: holiday.open_time,
        close_time: holiday.close_time,
      }
    : {
        is_closed: weekday?.is_closed ?? true,
        open_time: weekday?.open_time ?? null,
        close_time: weekday?.close_time ?? null,
      };

  if (today.is_closed || !today.open_time || !today.close_time) {
    return { open_now: false, today: "closed", next_open: null as string | null };
  }

  const opens = toMinutes(today.open_time);
  const closes = toMinutes(today.close_time);
  const openNow = local.minutes >= opens && local.minutes < closes;

  return {
    open_now: openNow,
    today: `${spoken(today.open_time)} to ${spoken(today.close_time)}`,
    next_open:
      openNow || local.minutes >= closes
        ? null
        : `today at ${spoken(today.open_time)}`,
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test lib/agent/hours.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Write the route**

Create `app/api/agent/hours/route.ts`:

```ts
import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { openState, type HolidayRow, type HoursRow } from "@/lib/agent/hours";

/** get_hours. Asked whenever there is any question about being open. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const supabase = supabaseAdmin();
  const [hours, holidays] = await Promise.all([
    supabase.from("hours").select("*").eq("location_id", location.id),
    supabase.from("holiday_hours").select("*").eq("location_id", location.id),
  ]);

  if (hours.error || holidays.error) {
    console.error("[agent] hours read failed", hours.error ?? holidays.error);
    return agentFail("I can't check the hours right now.", 500);
  }

  return agentOk(
    openState({
      now: new Date(),
      timezone: location.timezone,
      hours: (hours.data ?? []) as HoursRow[],
      holidays: (holidays.data ?? []) as HolidayRow[],
    }),
  );
}
```

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/agent/hours.ts lib/agent/hours.test.ts app/api/agent/hours/route.ts
git commit -m "feat: get_hours tool with holiday overrides"
```

---

### Task 6: Availability tool

**Files:**
- Create: `lib/agent/availability.ts`
- Create: `lib/agent/availability.test.ts`
- Create: `app/api/agent/availability/route.ts`

**Interfaces:**
- Consumes: `agentOk`/`agentFail`, `locationForSecret`
- Produces: `seatsTaken(bookings: {requested_at: string, party_size: number}[], slotStart: Date, slotMinutes: number): number`; `nearestTimes(slotStart: Date, timezone: string, count?: number): string[]`

- [ ] **Step 1: Write the failing test**

Create `lib/agent/availability.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { seatsTaken, nearestTimes } from "./availability";

describe("availability", () => {
  const slot = new Date("2026-08-13T02:00:00Z"); // 7pm Los Angeles

  it("counts bookings overlapping the slot", () => {
    const taken = seatsTaken(
      [
        { requested_at: "2026-08-13T02:00:00Z", party_size: 4 },
        { requested_at: "2026-08-13T02:30:00Z", party_size: 2 },
      ],
      slot,
      90,
    );
    expect(taken).toBe(6);
  });

  it("ignores bookings that end before the slot starts", () => {
    const taken = seatsTaken(
      [{ requested_at: "2026-08-13T00:00:00Z", party_size: 4 }],
      slot,
      90,
    );
    expect(taken).toBe(0);
  });

  it("ignores bookings that start after the slot ends", () => {
    const taken = seatsTaken(
      [{ requested_at: "2026-08-13T04:00:00Z", party_size: 4 }],
      slot,
      90,
    );
    expect(taken).toBe(0);
  });

  it("offers nearby times in the location's timezone", () => {
    expect(nearestTimes(slot, "America/Los_Angeles", 2)).toEqual([
      "6:30 PM",
      "7:30 PM",
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test lib/agent/availability.test.ts`
Expected: FAIL — cannot resolve `./availability`

- [ ] **Step 3: Write the implementation**

Create `lib/agent/availability.ts`:

```ts
/** Seats already promised during a slot.
 *
 *  A table is held for the whole slot, so any booking whose own slot
 *  overlaps this one competes for the same seats. */
export function seatsTaken(
  bookings: { requested_at: string; party_size: number }[],
  slotStart: Date,
  slotMinutes: number,
) {
  const start = slotStart.getTime();
  const end = start + slotMinutes * 60_000;

  return bookings.reduce((total, booking) => {
    const bStart = new Date(booking.requested_at).getTime();
    const bEnd = bStart + slotMinutes * 60_000;
    const overlaps = bStart < end && bEnd > start;
    return overlaps ? total + booking.party_size : total;
  }, 0);
}

const spokenTime = (date: Date, timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(date);

/** Times to offer when the requested one is full: half an hour either
 *  side, nearest first, because that is what a host would say. */
export function nearestTimes(slotStart: Date, timezone: string, count = 2) {
  const offsets = [-30, 30, -60, 60, -90, 90];
  return offsets
    .slice(0, count)
    .map((minutes) => new Date(slotStart.getTime() + minutes * 60_000))
    .sort((a, b) => a.getTime() - b.getTime())
    .map((d) => spokenTime(d, timezone));
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test lib/agent/availability.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Write the route**

Create `app/api/agent/availability/route.ts`:

```ts
import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { nearestTimes, seatsTaken } from "@/lib/agent/availability";

/** check_availability. The agent must call this before promising a time.
 *  It answers from real bookings, never from a guess. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const body = (await request.json().catch(() => ({}))) as {
    requested_at?: string;
    party_size?: number;
  };

  const when = body.requested_at ? new Date(body.requested_at) : null;
  const party = Number(body.party_size ?? 0);

  if (!when || Number.isNaN(when.getTime())) {
    return agentFail("I didn't catch the date and time for that.");
  }
  if (!Number.isInteger(party) || party < 1) {
    return agentFail("I didn't catch how many people.");
  }
  if (party > location.max_party_size) {
    return agentOk({
      available: false,
      reason: "large_party",
      alternatives: [],
    });
  }

  const slot = location.reservation_slot_minutes;
  const windowStart = new Date(when.getTime() - slot * 60_000).toISOString();
  const windowEnd = new Date(when.getTime() + slot * 60_000).toISOString();

  const { data, error } = await supabaseAdmin()
    .from("bookings")
    .select("requested_at, party_size")
    .eq("location_id", location.id)
    .in("status", ["requested", "confirmed", "seated"])
    .gte("requested_at", windowStart)
    .lte("requested_at", windowEnd);

  if (error) {
    console.error("[agent] availability read failed", error);
    return agentFail("I can't check the book right now.", 500);
  }

  const taken = seatsTaken(data ?? [], when, slot);
  const available = taken + party <= location.seats;

  return agentOk({
    available,
    alternatives: available ? [] : nearestTimes(when, location.timezone, 2),
  });
}
```

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/agent/availability.ts lib/agent/availability.test.ts app/api/agent/availability/route.ts
git commit -m "feat: check_availability tool answers from real bookings"
```

---

### Task 7: Reservation tool

**Files:**
- Create: `app/api/agent/reservation/route.ts`
- Create: `lib/agent/context.ts`
- Create: `lib/agent/context.test.ts`

**Interfaces:**
- Consumes: `locationForSecret`, `seatsTaken`
- Produces: `callIdForProvider(locationId: string, providerCallId: string | undefined): Promise<string | null>` — links a tool call to the `calls` row so a booking can be attributed to the call that produced it.

- [ ] **Step 1: Write the failing test**

Create `lib/agent/context.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: "call-1" }, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

const { callIdForProvider } = await import("./context");

describe("call linkage", () => {
  it("returns null without a provider call id", async () => {
    expect(await callIdForProvider("loc-1", undefined)).toBeNull();
  });

  it("finds the call row for a provider call id", async () => {
    expect(await callIdForProvider("loc-1", "vapi-123")).toBe("call-1");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test lib/agent/context.test.ts`
Expected: FAIL — cannot resolve `./context`

- [ ] **Step 3: Write the implementation**

Create `lib/agent/context.ts`:

```ts
import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";

/** The call row this tool call belongs to, if we can tell.
 *
 *  Scoped by location as well as provider id: the provider id arrives in
 *  a request body, and a body value must never be able to attach a
 *  booking or an order to another restaurant's call. */
export async function callIdForProvider(
  locationId: string,
  providerCallId: string | undefined,
) {
  if (!providerCallId) return null;

  const { data, error } = await supabaseAdmin()
    .from("calls")
    .select("id")
    .eq("location_id", locationId)
    .eq("provider_call_id", providerCallId)
    .maybeSingle();

  if (error) {
    console.error("[agent] call lookup failed", error);
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test lib/agent/context.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Write the route**

Create `app/api/agent/reservation/route.ts`:

```ts
import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { callIdForProvider } from "@/lib/agent/context";
import { seatsTaken } from "@/lib/agent/availability";

/** create_reservation. Re-checks capacity at write time: the caller has
 *  been talking for a minute or two since check_availability, and two
 *  callers can be booking the same table at once. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const body = (await request.json().catch(() => ({}))) as {
    requested_at?: string;
    party_size?: number;
    customer_name?: string;
    customer_phone?: string;
    provider_call_id?: string;
  };

  const when = body.requested_at ? new Date(body.requested_at) : null;
  const party = Number(body.party_size ?? 0);

  if (!when || Number.isNaN(when.getTime())) {
    return agentFail("I didn't catch the date and time.");
  }
  if (!Number.isInteger(party) || party < 1 || party > location.max_party_size) {
    return agentFail("I didn't catch how many people.");
  }
  if (!body.customer_name || !body.customer_phone) {
    return agentFail("I still need a name and a number for the booking.");
  }

  const supabase = supabaseAdmin();
  const slot = location.reservation_slot_minutes;

  const { data: existing, error: readError } = await supabase
    .from("bookings")
    .select("requested_at, party_size")
    .eq("location_id", location.id)
    .in("status", ["requested", "confirmed", "seated"])
    .gte("requested_at", new Date(when.getTime() - slot * 60_000).toISOString())
    .lte("requested_at", new Date(when.getTime() + slot * 60_000).toISOString());

  if (readError) {
    console.error("[agent] reservation capacity check failed", readError);
    return agentFail("I can't get into the book right now.", 500);
  }

  if (seatsTaken(existing ?? [], when, slot) + party > location.seats) {
    return agentOk({ booked: false, reason: "full" });
  }

  const { data, error } = await supabase
    .from("bookings")
    .insert({
      location_id: location.id,
      call_id: await callIdForProvider(location.id, body.provider_call_id),
      customer_name: body.customer_name,
      customer_phone: body.customer_phone,
      party_size: party,
      requested_at: when.toISOString(),
      status: "confirmed",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[agent] reservation insert failed", error);
    return agentFail("I couldn't get that booking in.", 500);
  }

  return agentOk({
    booked: true,
    booking_id: data.id,
    when: new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      timeZone: location.timezone,
    }).format(when),
  });
}
```

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add lib/agent/context.ts lib/agent/context.test.ts app/api/agent/reservation/route.ts
git commit -m "feat: create_reservation tool re-checks capacity at write time"
```

---

### Task 8: Order pricing

**Files:**
- Create: `lib/agent/orders.ts`
- Create: `lib/agent/orders.test.ts`

**Interfaces:**
- Consumes: nothing outside this file
- Produces: `matchItem(items: PricedItem[], spoken: string): PricedItem | null`; `priceOrder(lines: {item: PricedItem, quantity: number}[], taxRateBps: number): {subtotal_cents: number, tax_cents: number, total_cents: number}`. `PricedItem = {id: string, name: string, price_cents: number, sold_out_until: string | null}`

- [ ] **Step 1: Write the failing test**

Create `lib/agent/orders.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchItem, priceOrder, type PricedItem } from "./orders";

const items: PricedItem[] = [
  { id: "i1", name: "Bucatini Amatriciana", price_cents: 2400, sold_out_until: null },
  { id: "i2", name: "Lasagne Verdi", price_cents: 2600, sold_out_until: null },
  { id: "i3", name: "Squid Ink Tonnarelli", price_cents: 2900, sold_out_until: "close" },
];

describe("matching spoken item names", () => {
  it("matches exactly, ignoring case and spacing", () => {
    expect(matchItem(items, "  lasagne verdi ")?.id).toBe("i2");
  });

  it("matches a partial name the way a caller would say it", () => {
    expect(matchItem(items, "bucatini")?.id).toBe("i1");
  });

  it("returns null rather than guessing between two matches", () => {
    const ambiguous: PricedItem[] = [
      { id: "a", name: "Cheese Pizza", price_cents: 1200, sold_out_until: null },
      { id: "b", name: "Cheese Bread", price_cents: 800, sold_out_until: null },
    ];
    expect(matchItem(ambiguous, "cheese")).toBeNull();
  });

  it("returns null for something not on the menu", () => {
    expect(matchItem(items, "chicken tikka")).toBeNull();
  });
});

describe("pricing", () => {
  it("adds tax in integer cents", () => {
    const totals = priceOrder(
      [
        { item: items[0], quantity: 2 },
        { item: items[1], quantity: 1 },
      ],
      875,
    );
    expect(totals.subtotal_cents).toBe(7400);
    expect(totals.tax_cents).toBe(648); // 7400 * 0.0875 = 647.5, rounded
    expect(totals.total_cents).toBe(8048);
  });

  it("handles a zero tax rate", () => {
    const totals = priceOrder([{ item: items[1], quantity: 1 }], 0);
    expect(totals).toEqual({
      subtotal_cents: 2600,
      tax_cents: 0,
      total_cents: 2600,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test lib/agent/orders.test.ts`
Expected: FAIL — cannot resolve `./orders`

- [ ] **Step 3: Write the implementation**

Create `lib/agent/orders.ts`:

```ts
export type PricedItem = {
  id: string;
  name: string;
  price_cents: number;
  sold_out_until: string | null;
};

const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/** Find the one item a caller meant.
 *
 *  Returns null when two items could match rather than picking one: a
 *  wrong item on the ticket is worse than one more question, and the
 *  agent is told to transfer when it cannot find something. */
export function matchItem(items: PricedItem[], spoken: string) {
  const needle = normalise(spoken);
  if (!needle) return null;

  const exact = items.filter((i) => normalise(i.name) === needle);
  if (exact.length === 1) return exact[0];

  const partial = items.filter((i) => normalise(i.name).includes(needle));
  return partial.length === 1 ? partial[0] : null;
}

/** Integer cents throughout. Tax is basis points so no float ever holds
 *  money. */
export function priceOrder(
  lines: { item: PricedItem; quantity: number }[],
  taxRateBps: number,
) {
  const subtotal = lines.reduce(
    (sum, line) => sum + line.item.price_cents * line.quantity,
    0,
  );
  const tax = Math.round((subtotal * taxRateBps) / 10_000);
  return {
    subtotal_cents: subtotal,
    tax_cents: tax,
    total_cents: subtotal + tax,
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test lib/agent/orders.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add lib/agent/orders.ts lib/agent/orders.test.ts
git commit -m "feat: order matching and integer-cent pricing"
```

---

### Task 9: Order notification

**Files:**
- Create: `lib/agent/notify.ts`
- Create: `lib/agent/notify.test.ts`

**Interfaces:**
- Consumes: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `locations.order_sms_to`, `locations.twilio_number`
- Produces: `orderMessage(args: {orderNumber: number, type: string, customerName: string, customerPhone: string, lines: {quantity: number, name: string}[], totalCents: number, promisedMinutes: number}): string`; `sendOrderSms(location: LocationRow, message: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `lib/agent/notify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { orderMessage } from "./notify";

describe("order message", () => {
  const message = orderMessage({
    orderNumber: 1043,
    type: "pickup",
    customerName: "Dana",
    customerPhone: "+15105550119",
    lines: [
      { quantity: 2, name: "Bucatini Amatriciana" },
      { quantity: 1, name: "Lasagne Verdi" },
    ],
    totalCents: 8048,
    promisedMinutes: 25,
  });

  it("leads with the order number and type", () => {
    expect(message.startsWith("#1043 PICKUP")).toBe(true);
  });

  it("lists each line with its quantity", () => {
    expect(message).toContain("2x Bucatini Amatriciana");
    expect(message).toContain("1x Lasagne Verdi");
  });

  it("shows the total in dollars", () => {
    expect(message).toContain("$80.48");
  });

  it("carries the callback number and the promise", () => {
    expect(message).toContain("+15105550119");
    expect(message).toContain("25 min");
  });

  it("never contains anything that looks like a card number", () => {
    expect(message).not.toMatch(/\b\d{13,19}\b/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test lib/agent/notify.test.ts`
Expected: FAIL — cannot resolve `./notify`

- [ ] **Step 3: Write the implementation**

Create `lib/agent/notify.ts`:

```ts
import "server-only";

import type { LocationRow } from "@/lib/supabase/types";

/** The ticket as it lands on the manager's phone. Terse on purpose: it is
 *  read at a pass during service, on a screen with flour on it. */
export function orderMessage({
  orderNumber,
  type,
  customerName,
  customerPhone,
  lines,
  totalCents,
  promisedMinutes,
}: {
  orderNumber: number;
  type: string;
  customerName: string;
  customerPhone: string;
  lines: { quantity: number; name: string }[];
  totalCents: number;
  promisedMinutes: number;
}) {
  const items = lines.map((l) => `${l.quantity}x ${l.name}`).join("\n");
  return [
    `#${orderNumber} ${type.toUpperCase()} - ${promisedMinutes} min`,
    items,
    `Total $${(totalCents / 100).toFixed(2)}`,
    `${customerName} ${customerPhone}`,
  ].join("\n");
}

/** Send the ticket to the restaurant's own staff number.
 *
 *  This is the only outbound message in the product, and it goes to the
 *  business that asked for it -- never to a customer. Texting callers
 *  would be a different legal problem entirely. */
export async function sendOrderSms(location: LocationRow, message: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const to = location.order_sms_to;
  const from = location.twilio_number;

  if (!sid || !token || !to || !from) {
    console.error("[agent] cannot send order sms: missing config");
    return false;
  }

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: message }),
    },
  );

  if (!res.ok) {
    console.error("[agent] order sms failed", res.status, await res.text());
    return false;
  }
  return true;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test lib/agent/notify.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add lib/agent/notify.ts lib/agent/notify.test.ts
git commit -m "feat: send the order ticket to the restaurant's staff number"
```

---

### Task 10: Order tool

**Files:**
- Create: `app/api/agent/order/route.ts`

**Interfaces:**
- Consumes: `matchItem`, `priceOrder`, `orderMessage`, `sendOrderSms`, `callIdForProvider`, `locationForSecret`
- Produces: HTTP `POST /api/agent/order` returning `{ok, placed, order_number, total, promised_minutes}` or `{ok, placed: false, reason: "sold_out" | "unknown_item", item}`

- [ ] **Step 1: Write the route**

Create `app/api/agent/order/route.ts`:

```ts
import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { callIdForProvider } from "@/lib/agent/context";
import { matchItem, priceOrder, type PricedItem } from "@/lib/agent/orders";
import { orderMessage, sendOrderSms } from "@/lib/agent/notify";

const PROMISED_MINUTES = 25;

/** place_order. Prices from the live menu, never from what the agent
 *  believes an item costs. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const body = (await request.json().catch(() => ({}))) as {
    items?: { name?: string; quantity?: number }[];
    type?: "pickup" | "delivery";
    customer_name?: string;
    customer_phone?: string;
    address?: string;
    provider_call_id?: string;
  };

  if (!body.items?.length) return agentFail("I don't have any items yet.");
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

  const items = (menu ?? []) as PricedItem[];
  const lines: { item: PricedItem; quantity: number }[] = [];

  for (const requested of body.items) {
    const match = matchItem(items, requested.name ?? "");
    if (!match) {
      return agentOk({ placed: false, reason: "unknown_item", item: requested.name });
    }
    // Checked here as well as in get_menu: the manager may have flagged
    // it out while this very call was in progress.
    if (match.sold_out_until !== null) {
      return agentOk({ placed: false, reason: "sold_out", item: match.name });
    }
    const quantity = Math.max(1, Math.round(Number(requested.quantity ?? 1)));
    lines.push({ item: match, quantity });
  }

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

  // Best effort: the order is already recorded and visible in the
  // dashboard, so a failed text must not tell the caller their food is
  // not coming.
  await sendOrderSms(
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

  return agentOk({
    placed: true,
    order_number: order.order_number,
    total: `$${(totals.total_cents / 100).toFixed(2)}`,
    promised_minutes: PROMISED_MINUTES,
  });
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/agent/order/route.ts
git commit -m "feat: place_order tool prices from the live menu"
```

---

### Task 11: Transfer tool

**Files:**
- Create: `app/api/agent/transfer/route.ts`

**Interfaces:**
- Consumes: `locationForSecret`, `callIdForProvider`
- Produces: HTTP `POST /api/agent/transfer` returning `{ok: true, number: string}`

- [ ] **Step 1: Write the route**

Create `app/api/agent/transfer/route.ts`:

```ts
import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { callIdForProvider } from "@/lib/agent/context";

/** transfer_to_human. This is the escape hatch for allergies, complaints,
 *  money and anything the agent cannot do, so it must work when the rest
 *  of the system does not: the number is returned first and the logging
 *  is best effort afterwards. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const number = location.fallback_human_number;
  if (!number) {
    console.error("[agent] no fallback number for location", location.id);
    return agentFail("No transfer number is set up.", 500);
  }

  const body = (await request.json().catch(() => ({}))) as {
    reason?: string;
    provider_call_id?: string;
  };

  try {
    const callId = await callIdForProvider(location.id, body.provider_call_id);
    if (callId) {
      await supabaseAdmin()
        .from("calls")
        .update({
          transferred_to_human: true,
          transfer_reason: (body.reason ?? "Agent handed off").slice(0, 200),
          outcome: "transferred",
        })
        .eq("id", callId);
    }
  } catch (err) {
    console.error("[agent] could not log transfer", err);
  }

  return agentOk({ number });
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/agent/transfer/route.ts
git commit -m "feat: transfer_to_human tool that works when nothing else does"
```

---

### Task 12: System prompt builder

**Files:**
- Create: `lib/agent/prompt.ts`
- Create: `lib/agent/prompt.test.ts`
- Create: `app/api/agent/assistant/route.ts`

**Interfaces:**
- Consumes: `LocationRow`, `openState`
- Produces: `SYSTEM_PROMPT_TEMPLATE: string`; `buildSystemPrompt(args: {location: LocationRow, hoursToday: string, now: Date}): string`; `buildGreeting(location: LocationRow): string`

- [ ] **Step 1: Write the failing test**

Create `lib/agent/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildGreeting, SYSTEM_PROMPT_TEMPLATE } from "./prompt";

const location = {
  id: "l1",
  name: "Nonna Rosa",
  address: "1412 Telegraph Ave, Oakland, CA",
  timezone: "America/Los_Angeles",
  order_types: "both",
  greeting_text: "Hi, thanks for calling Nonna Rosa! What can I get for you?",
} as never;

describe("system prompt", () => {
  const prompt = buildSystemPrompt({
    location,
    hoursToday: "5:00 PM to 10:30 PM",
    now: new Date("2026-08-13T02:00:00Z"),
  });

  it("fills every placeholder", () => {
    expect(prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  it("names the restaurant", () => {
    expect(prompt).toContain("Nonna Rosa");
  });

  it("carries today's hours", () => {
    expect(prompt).toContain("5:00 PM to 10:30 PM");
  });

  it("keeps the allergy rule verbatim", () => {
    expect(prompt).toContain("There are no exceptions to this.");
  });

  it("keeps the menu rule verbatim", () => {
    expect(prompt).toContain("You do not know the menu. You never know the menu.");
  });

  it("stays short enough to keep latency down", () => {
    // The spec's tuning note: keep the prompt this length or shorter.
    expect(prompt.length).toBeLessThan(6000);
  });
});

describe("greeting", () => {
  it("uses the location's own editable line", () => {
    expect(buildGreeting(location)).toBe(
      "Hi, thanks for calling Nonna Rosa! What can I get for you?",
    );
  });

  it("falls back to the restaurant name when the field is empty", () => {
    expect(buildGreeting({ ...location, greeting_text: "" } as never)).toBe(
      "Hi, thanks for calling Nonna Rosa! What can I get for you?",
    );
  });
});

describe("template", () => {
  it("has no stray placeholders beyond the known set", () => {
    const found = [...SYSTEM_PROMPT_TEMPLATE.matchAll(/\{\{([a-z_]+)\}\}/g)].map(
      (m) => m[1],
    );
    expect(new Set(found)).toEqual(
      new Set([
        "business_name",
        "address",
        "current_datetime",
        "hours_today",
        "takeout_delivery_settings",
      ]),
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test lib/agent/prompt.test.ts`
Expected: FAIL — cannot resolve `./prompt`

- [ ] **Step 3: Write the implementation**

Create `lib/agent/prompt.ts`. The template is the spec's prompt verbatim — do not paraphrase it, and do not add sections:

```ts
import type { LocationRow } from "@/lib/supabase/types";

export const SYSTEM_PROMPT_TEMPLATE = `You are answering the phone for {{business_name}}, a restaurant.

You are speaking out loud on a phone call. Everything you say gets read aloud, so write like a person talks, not like a person writes.

## How you sound

Warm, quick, and normal. Like a good employee who has done this a thousand times.

Keep every reply short. One or two sentences. This is a phone call, not an essay. If you talk for more than about ten seconds without stopping, you are talking too long.

Use plain words. Say "sure" not "certainly." Say "got it" not "understood." Contractions are good.

Never use bullet points, numbers, symbols, or emoji. It all gets spoken out loud.

Never mention that you are an AI, a bot, or a system unless the caller directly asks. If they ask, tell the truth plainly: "I'm the automated assistant here." Do not argue about it, do not apologize for it, just carry on helping.

Never say the words "tool," "database," "system," or "function." The caller does not care how you work.

## What you can do

1. Take a takeout or delivery order
2. Book, change, or cancel a table reservation
3. Answer questions about hours, address, parking, and the menu
4. Pass the call to a human

That is the whole list. If someone asks for anything else, pass them to a human.

## The menu - read this twice

You do not know the menu. You never know the menu.

Every single time a caller mentions food, you call get_menu and use only what comes back. Never guess an item. Never guess a price. Never guess what comes on something.

If an item is not in what get_menu returned, you do not have it. Say so.

If a caller asks for something that is marked sold out, do not just say no. Say it is out and offer the closest thing that is available. Example: "Ah, we're out of wings tonight, but the boneless are still going - want those instead?"

If a caller asks for something you cannot find at all, say "I'm not seeing that one - let me get someone who can help," and transfer.

Never invent a special, a deal, or a discount. If it is not in the menu data, it does not exist.

## Taking an order

Get these, in whatever order the conversation goes: every item with size and any changes, pickup or delivery, the caller's first name, a callback number, and the address if it is delivery.

Confirm each item as you add it. Short: "Got it, large pepperoni."

When they are done, read the whole order back, with the total, and ask if it is right. Do not place the order until they say yes.

Read phone numbers back digit by digit. Spell names back if they sound unusual. Getting these wrong is the most common way this goes bad.

When they confirm, call place_order.

If place_order fails, tell them honestly and transfer to a human. Never pretend an order went through.

## Taking a reservation

Get the date, the time, how many people, a first name, and a phone number.

Call check_availability before you promise anything. Never say a time is open until the tool says it is. If the time is taken, offer the nearest open times.

Read the whole booking back before you confirm it, then call create_reservation.

## Money

Never take a card number. Never take any payment details. If they want to pay now, say payment is handled at pickup or delivery, or that you can text them a payment link. If they push, transfer to a human.

## Allergies - hard rule

If anyone mentions an allergy, an intolerance, celiac, or asks what is in a dish for a health reason, stop.

Do not answer. Do not guess. Do not read ingredients.

Say: "I want to make sure you get that exactly right - let me put you through to someone."

Then transfer immediately. There are no exceptions to this.

## When to transfer to a human

Transfer when anyone mentions an allergy or a dietary health need; someone asks for a manager or a person; someone is upset, complaining, or reporting a problem with an order; a large or catering order comes up; anything about payment, refunds, or money owed; you have tried twice to understand and still cannot; or anything at all outside the four things you can do.

Say something short and warm: "Let me get someone for you, one moment." Then call transfer_to_human. Do not explain why. Do not keep talking.

Transferring is not failing. A clean transfer is a good call.

## When you cannot hear them

Phone lines are bad and kitchens are loud. If you did not catch it, ask once, plainly: "Sorry, I missed that - say that again?" If you still cannot get it after a second try, transfer to a human. Do not make them repeat themselves three times.

If you hear nothing at all for a while, ask "Are you still there?" once. If still nothing, say goodbye politely and end the call.

## Closed hours

Call get_hours if there is any question about whether they are open. If they are closed now, say so and say when they open next. You can still take a reservation for a future time. Never promise food will be ready at a time the kitchen is closed.

## Things you never do

Never make up an item, a price, a time, or a policy. Never promise a delivery time unless the tool gave you one. Never take payment details. Never answer an allergy question. Never argue with a caller. Never keep going in circles - transfer instead. Never say anything bad about the restaurant. Never discuss anything unrelated to this restaurant.

## Ending the call

When the order or booking is done, confirm it in one line, say thanks, and end. Example: "You're all set - should be about twenty minutes. Thanks, see you soon." Do not add extra chat at the end. People want to hang up.

## Restaurant details

Name: {{business_name}}
Address: {{address}}
Today's date and time: {{current_datetime}}
Hours today: {{hours_today}}
Order type available: {{takeout_delivery_settings}}`;

const ORDER_TYPE_WORDS: Record<string, string> = {
  pickup: "pickup only",
  delivery: "delivery only",
  both: "pickup and delivery",
};

export function buildSystemPrompt({
  location,
  hoursToday,
  now,
}: {
  location: LocationRow;
  hoursToday: string;
  now: Date;
}) {
  const when = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: location.timezone,
  }).format(now);

  return SYSTEM_PROMPT_TEMPLATE.replaceAll("{{business_name}}", location.name)
    .replaceAll("{{address}}", location.address ?? "not on file")
    .replaceAll("{{current_datetime}}", when)
    .replaceAll("{{hours_today}}", hoursToday)
    .replaceAll(
      "{{takeout_delivery_settings}}",
      ORDER_TYPE_WORDS[location.order_types] ?? "pickup only",
    );
}

/** The greeting is pre-recorded audio, not model output, so it starts
 *  instantly. This is the text of record for that audio, and it is one
 *  editable field: when the FCC disclosure rule lands, this changes and
 *  no code does. */
export function buildGreeting(location: LocationRow) {
  return (
    location.greeting_text?.trim() ||
    `Hi, thanks for calling ${location.name}! What can I get for you?`
  );
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test lib/agent/prompt.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Write the assistant config route**

Create `app/api/agent/assistant/route.ts`:

```ts
import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { openState, type HolidayRow, type HoursRow } from "@/lib/agent/hours";
import { buildGreeting, buildSystemPrompt } from "@/lib/agent/prompt";

/** The assistant's configuration for this restaurant, assembled fresh so
 *  the date, the hours and the greeting are never stale. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const supabase = supabaseAdmin();
  const [hours, holidays] = await Promise.all([
    supabase.from("hours").select("*").eq("location_id", location.id),
    supabase.from("holiday_hours").select("*").eq("location_id", location.id),
  ]);

  const state = openState({
    now: new Date(),
    timezone: location.timezone,
    hours: (hours.data ?? []) as HoursRow[],
    holidays: (holidays.data ?? []) as HolidayRow[],
  });

  return agentOk({
    system_prompt: buildSystemPrompt({
      location,
      hoursToday: state.today,
      now: new Date(),
    }),
    greeting: buildGreeting(location),
    fallback_number: location.fallback_human_number,
    kill_switch_on: location.kill_switch_on,
  });
}
```

- [ ] **Step 6: Typecheck, lint, full test run**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add lib/agent/prompt.ts lib/agent/prompt.test.ts app/api/agent/assistant/route.ts
git commit -m "feat: per-restaurant system prompt and assistant config"
```

---

### Task 13: Secret provisioning

**Files:**
- Create: `scripts/set-agent-secret.mjs`

**Interfaces:**
- Consumes: `hashAgentSecret` logic (reimplemented inline; the script runs outside the Next build)
- Produces: prints a generated secret once and stores only its hash

- [ ] **Step 1: Write the script**

Create `scripts/set-agent-secret.mjs`:

```js
#!/usr/bin/env node
/* Generate a tool secret for one location and store only its hash.
   The plaintext is printed once, here, and never persisted by us.

   node scripts/set-agent-secret.mjs <location-id>
*/
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const locationId = process.argv[2];
if (!locationId) {
  console.error("usage: node scripts/set-agent-secret.mjs <location-id>");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const secret = crypto.randomBytes(32).toString("base64url");
const hash = crypto.createHash("sha256").update(secret, "utf-8").digest("hex");

const { error } = await supabase
  .from("locations")
  .update({ agent_secret_hash: hash })
  .eq("id", locationId);

if (error) {
  console.error("failed:", error.message);
  process.exit(1);
}

console.log("Secret for location", locationId);
console.log(secret);
console.log("\nPut this in the Vapi tool headers as x-dialtone-secret.");
console.log("It is not stored anywhere else. Losing it means generating a new one.");
```

- [ ] **Step 2: Run it against the demo location**

Run:

```bash
set -a && . ./.env.local && set +a && node scripts/set-agent-secret.mjs a10c0000-0000-0000-0000-00000000000a
```

Expected: prints a secret. Copy it somewhere safe for the next task.

- [ ] **Step 3: Verify the hash landed and the plaintext did not**

Run in the SQL editor:

```sql
select agent_secret_hash from locations
where id = 'a10c0000-0000-0000-0000-00000000000a';
```

Expected: a 64-character hex string that is not the secret you were shown.

- [ ] **Step 4: Commit**

```bash
git add scripts/set-agent-secret.mjs
git commit -m "feat: script to provision a per-location agent secret"
```

---

### Task 14: End-to-end tool verification

**Files:**
- Create: `scripts/exercise-tools.mjs`

**Interfaces:**
- Consumes: every `/api/agent/*` route
- Produces: a pass/fail report across all six tools

- [ ] **Step 1: Write the script**

Create `scripts/exercise-tools.mjs`:

```js
#!/usr/bin/env node
/* Drive every tool endpoint the way the agent will.

   AGENT_SECRET=... node scripts/exercise-tools.mjs [base-url]
*/
const base = process.argv[2] ?? "http://localhost:3000";
const secret = process.env.AGENT_SECRET;

if (!secret) {
  console.error("set AGENT_SECRET to the value from set-agent-secret.mjs");
  process.exit(1);
}

const call = async (path, body, useSecret = true) => {
  const res = await fetch(`${base}/api/agent/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(useSecret ? { "x-dialtone-secret": secret } : {}),
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

// Auth
const noAuth = await call("menu", {}, false);
check("unauthenticated menu is rejected", noAuth.status === 401);

const badAuth = await fetch(`${base}/api/agent/menu`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-dialtone-secret": "wrong" },
  body: "{}",
});
check("wrong secret is rejected", badAuth.status === 401);

// Menu
const menu = await call("menu", { item: "Squid Ink Tonnarelli" });
check("menu returns categories", Array.isArray(menu.body?.categories));
check("menu marks sold out items", (menu.body?.sold_out ?? []).length > 0,
  JSON.stringify(menu.body?.sold_out));
check("menu suggests an alternative", typeof menu.body?.alternative === "string",
  String(menu.body?.alternative));

// Hours
const hours = await call("hours", {});
check("hours answers open_now", typeof hours.body?.open_now === "boolean",
  `today: ${hours.body?.today}`);

// Availability
const when = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const avail = await call("availability", { requested_at: when, party_size: 2 });
check("availability answers", typeof avail.body?.available === "boolean");

const huge = await call("availability", { requested_at: when, party_size: 99 });
check("oversized party is refused", huge.body?.available === false,
  huge.body?.reason);

// Reservation
const booking = await call("reservation", {
  requested_at: when,
  party_size: 2,
  customer_name: "Test Caller",
  customer_phone: "+15105550000",
});
check("reservation books", booking.body?.booked === true, booking.body?.when);

// Order
const order = await call("order", {
  items: [{ name: "Cacio e Pepe", quantity: 2 }],
  type: "pickup",
  customer_name: "Test Caller",
  customer_phone: "+15105550000",
});
check("order is placed", order.body?.placed === true,
  `#${order.body?.order_number} ${order.body?.total}`);

const soldOut = await call("order", {
  items: [{ name: "Squid Ink Tonnarelli", quantity: 1 }],
  type: "pickup",
  customer_name: "Test Caller",
  customer_phone: "+15105550000",
});
check("sold out item is refused", soldOut.body?.reason === "sold_out");

const unknown = await call("order", {
  items: [{ name: "Chicken Tikka Masala", quantity: 1 }],
  type: "pickup",
  customer_name: "Test Caller",
  customer_phone: "+15105550000",
});
check("unknown item is refused", unknown.body?.reason === "unknown_item");

// Transfer
const transfer = await call("transfer", { reason: "Allergy question" });
check("transfer returns a number", typeof transfer.body?.number === "string",
  transfer.body?.number);

// Assistant config
const assistant = await call("assistant", {});
check("prompt has no unfilled placeholders",
  typeof assistant.body?.system_prompt === "string" &&
  !/\{\{[a-z_]+\}\}/.test(assistant.body.system_prompt));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
```

- [ ] **Step 2: Start the dev server**

Run: `npm run dev`
Wait for: `Ready in`

- [ ] **Step 3: Run the script**

Run:

```bash
AGENT_SECRET='<the secret from Task 13>' node scripts/exercise-tools.mjs
```

Expected: every line PASS, exit code 0. If `order is placed` fails with a 500, check `tax_rate_bps` and `order_types` on the demo location.

- [ ] **Step 4: Clean up the rows the script created**

Run in the SQL editor:

```sql
delete from bookings where customer_name = 'Test Caller';
delete from order_items where order_id in (
  select id from orders where customer_name = 'Test Caller'
);
delete from orders where customer_name = 'Test Caller';
```

Expected: success.

- [ ] **Step 5: Commit**

```bash
git add scripts/exercise-tools.mjs
git commit -m "test: end-to-end exercise of every agent tool"
```

---

### Task 15: Vapi wiring

**Files:**
- Create: `docs/vapi-setup.md`
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: all six endpoints, `scripts/set-agent-secret.mjs`
- Produces: documentation only

- [ ] **Step 1: Add the environment placeholders**

Append to `.env.example`:

```
# ── Vapi ─────────────────────────────────────────────────────────────
# Server-side only. Used by the provisioning script, never by the browser.
VAPI_PRIVATE_KEY=
VAPI_ASSISTANT_ID=
```

- [ ] **Step 2: Write the setup guide**

Create `docs/vapi-setup.md`:

````markdown
# Wiring a restaurant to Vapi

Inbound only. Nothing here originates a call.

## 1. Give the location a tool secret

```bash
set -a && . ./.env.local && set +a
node scripts/set-agent-secret.mjs <location-id>
```

Copy the printed secret. It is shown once; we store only its hash.

## 2. Create the six tools in Vapi

Each is a Custom Tool with `POST` to your public base URL and the header
`x-dialtone-secret: <the secret>`.

| Tool name | URL | Body the model fills |
|---|---|---|
| `get_menu` | `/api/agent/menu` | `{item?}` — the item they asked about, if any |
| `get_hours` | `/api/agent/hours` | `{}` |
| `check_availability` | `/api/agent/availability` | `{requested_at, party_size}` |
| `create_reservation` | `/api/agent/reservation` | `{requested_at, party_size, customer_name, customer_phone}` |
| `place_order` | `/api/agent/order` | `{items:[{name, quantity}], type, customer_name, customer_phone, address?}` |
| `transfer_to_human` | `/api/agent/transfer` | `{reason}` |

`requested_at` must be a full ISO 8601 timestamp. Tell the model the
current date and time is in its system prompt and it should resolve
"tomorrow at seven" itself.

## 3. Set the assistant up

- **System prompt:** the `system_prompt` from `POST /api/agent/assistant`.
- **First message:** the `greeting` from the same response, as a
  pre-recorded audio file. Do not let the model generate it — a generated
  greeting costs a second of silence at the top of every call.
- **Temperature:** 0.3. Boring and consistent, not creative.
- **Transfer destination:** `fallback_number` from the same response.

## 4. Point the number at it

Twilio number → Vapi phone number import → assign the assistant.

Keep our `/api/twilio/voice` webhook for numbers that are not on Vapi
yet; the two paths do not conflict.

## Before you go live with a real restaurant

Work through this list. Every line is a way these break in the field.

- [ ] Call it yourself twenty times. Order weird things. Interrupt it. Mumble.
- [ ] Ask for something sold out. It must offer the nearest available item, not just say no.
- [ ] Have someone with an accent call it. This is where these break.
- [ ] Test with the kitchen loud in the background.
- [ ] Mention an allergy. It must transfer immediately without answering.
- [ ] Offer a card number. It must refuse and never repeat it back.
- [ ] Confirm the transfer works with the app stopped — kill `npm run dev` and call.
- [ ] Toggle an item sold out mid-call on the manager screen, then call again and confirm the next call knows.
- [ ] Try to make it quote a wrong price. If you can, so can a customer.
- [ ] Ask it something outside the four things it does. It must transfer.
````

- [ ] **Step 3: Link it from the README**

In `README.md`, after the "## Twilio webhooks" section, add:

```markdown
## Voice agent

Vapi holds the call and calls our tool endpoints. See
[docs/vapi-setup.md](docs/vapi-setup.md) for wiring a restaurant, and
`lib/agent/prompt.ts` for the system prompt of record.

Tools authenticate with a per-location secret in `x-dialtone-secret`,
stored as a SHA-256 hash. A tool call can only ever touch the location
its secret belongs to — a `location_id` in a request body is never
trusted.
```

- [ ] **Step 4: Commit**

```bash
git add docs/vapi-setup.md .env.example README.md
git commit -m "docs: wiring a restaurant to Vapi and the pre-launch checklist"
```

---

## Self-Review Notes

**Spec coverage:** every prompt section is carried verbatim in Task 12's template. All six tools have a task (4, 5, 6, 7, 10, 11). The greeting requirement is Task 12 (`buildGreeting`, plus the "do not let the model generate it" instruction in Task 15). The pre-launch checklist is Task 15. Tuning notes are honoured: prompt length is asserted under 6000 characters in Task 12's test, and temperature 0.3 is specified in Task 15.

**Known gaps, deliberately out of scope for this plan:**
- Modifiers and sizes are in the schema but neither `get_menu` nor `place_order` expose them yet. A caller ordering "large" gets the base price. Worth its own plan before a pizza place.
- Change and cancel a reservation is listed in the prompt's capabilities but has no tool. The agent will transfer, which is safe but not what the prompt promises.
- Recording retention is still not enforced, and transcripts are not scanned for card-like digit runs.
