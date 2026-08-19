import { beforeEach, describe, expect, it, vi } from "vitest";

/** The reads behind the restaurant's order history and behind one
 *  order's full record.
 *
 *  THE BOARD CAN BE BOUNDED BY COUNT AND THIS CANNOT. getOrdersBoard
 *  stops at fifty because a pass never has more than a night of service
 *  on it; a restaurant's history is every order it has ever taken, it
 *  grows every service, and an unbounded select on it is a page that gets
 *  slower every week until it times out -- first, and worst, for the
 *  busiest customer on the platform. So this file pins the two things
 *  that stop that: a WINDOW cut on the restaurant's own clock, and a page
 *  of fifty inside it, counted in Postgres rather than in the page.
 *
 *  It also pins the first read of `order_status_events` this product has
 *  ever had. That table is written on every status change and has been
 *  invisible since the schema's first migration; its SELECT policy for
 *  `authenticated` is scoped through the orders join
 *  (20260807000200_rls.sql: `order_status_events_read`), so an owner may
 *  read their own -- confirmed by reading that policy, not assumed.
 *
 *  The database is the same in-memory stand-in for PostgREST's builder
 *  that lib/orders/board.test.ts uses, grown the four verbs this feature
 *  needs and that one did not: `in`, `gte`, `range`, and a head request
 *  that answers with a count and no rows. It records every filter, so
 *  "scoped to one restaurant" and "asked the database to count" are
 *  asserted directly rather than inferred from the rows that came back.
 */

type Row = Record<string, unknown>;
type Result = { data: Row[] | Row | null; error: { message: string } | null; count?: number };

let db: {
  orders: Row[];
  order_items: Row[];
  order_status_events: Row[];
  memberships: Row[];
};
/** Every `table.column` a query filtered on, and every table a count was
 *  asked of. */
let filteredOn: string[];
let countedIn: string[];
let ranges: [number, number][];
let failWith: { message: string } | null;
let user: { id: string } | null;

type Query = {
  eq: (column: string, value: unknown) => Query;
  in: (column: string, values: unknown[]) => Query;
  gte: (column: string, value: unknown) => Query;
  order: (column: string, opts: { ascending: boolean }) => Query;
  range: (from: number, to: number) => Query;
  limit: (count: number) => Query;
  maybeSingle: () => Promise<Result>;
  then: Promise<Result>["then"];
};

function makeQuery(
  table: keyof typeof db,
  columns: string,
  options?: { count?: string; head?: boolean },
): Query {
  let matched = [...db[table]];
  let ordering: { column: string; ascending: boolean } | null = null;
  let window: [number, number] | null = null;
  let ceiling: number | null = null;
  let single = false;

  if (options?.count) countedIn.push(table);

  const settle = (): Result => {
    if (failWith) return { data: null, error: failWith };

    let out = [...matched];
    if (ordering) {
      const { column, ascending } = ordering;
      out.sort((a, b) => {
        const left = String(a[column]);
        const right = String(b[column]);
        return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
      });
    }

    const total = out.length;
    if (window) out = out.slice(window[0], window[1] + 1);
    if (ceiling !== null) out = out.slice(0, ceiling);

    // PostgREST returns an embedded table as an array on each parent row,
    // and only when the select string asked for it.
    const rows = out.map((row) =>
      columns.includes("order_items")
        ? {
            ...row,
            order_items: db.order_items.filter((i) => i.order_id === row.id),
          }
        : { ...row },
    );

    // A head request carries the count and no rows at all.
    if (options?.head) return { data: null, error: null, count: total };
    if (single) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null, count: options?.count ? total : undefined };
  };

  const query: Query = {
    eq(column, value) {
      filteredOn.push(`${table}.${column}`);
      matched = matched.filter((row) => row[column] === value);
      return query;
    },
    in(column, values) {
      filteredOn.push(`${table}.${column}`);
      matched = matched.filter((row) => values.includes(row[column]));
      return query;
    },
    gte(column, value) {
      filteredOn.push(`${table}.${column}`);
      matched = matched.filter((row) => String(row[column]) >= String(value));
      return query;
    },
    order(column, opts) {
      ordering = { column, ascending: opts.ascending };
      return query;
    },
    range(from, to) {
      ranges.push([from, to]);
      window = [from, to];
      return query;
    },
    limit(count) {
      ceiling = count;
      return query;
    },
    maybeSingle() {
      single = true;
      return Promise.resolve(settle());
    },
    then: (onFulfilled, onRejected) =>
      Promise.resolve(settle()).then(onFulfilled, onRejected),
  };

  return query;
}

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    from: (table: string) => ({
      select: (columns: string, options?: { count?: string; head?: boolean }) => {
        if (!(table in db)) throw new Error(`unexpected table ${table}`);
        return makeQuery(table as keyof typeof db, columns, options);
      },
    }),
    auth: { getUser: async () => ({ data: { user }, error: null }) },
  }),
}));

const {
  DEFAULT_ORDER_HISTORY_WINDOW,
  ORDERS_PER_HISTORY_PAGE,
  ORDER_HISTORY_STATUSES,
  ORDER_HISTORY_WINDOWS,
  getOrderHistoryPage,
  getOrderRecord,
  orderHistoryWindowStart,
} = await import("@/lib/data");

const LOCATION = "loc-nonna";
const OTHER_LOCATION = "loc-martys";
const ORG = "org-nonna";
const OTHER_ORG = "org-martys";
const TZ = "America/New_York";

const ME = "11111111-1111-1111-1111-111111111111";
const BOSS = "22222222-2222-2222-2222-222222222222";

/** 9:12 PM on Aug 17 in New York -- Aug 18 in UTC, which is the whole
 *  reason the window is cut on the restaurant's clock. */
const NOW = new Date("2026-08-18T01:12:00.000Z");

function order(over: Row = {}): Row {
  return {
    id: "ord-1001",
    location_id: LOCATION,
    call_id: "call-1",
    order_number: 1001,
    customer_name: "Phi",
    customer_phone: "(510) 555-0143",
    type: "pickup",
    status: "completed",
    total_cents: 2700,
    notes: null,
    placed_at: "2026-08-18T01:12:00.000Z",
    promised_at: "2026-08-18T01:37:00.000Z",
    ...over,
  };
}

function event(over: Row = {}): Row {
  return {
    id: "ev-1",
    order_id: "ord-1001",
    from_status: null,
    to_status: "new",
    changed_by: null,
    changed_at: "2026-08-18T01:12:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  db = { orders: [], order_items: [], order_status_events: [], memberships: [] };
  filteredOn = [];
  countedIn = [];
  ranges = [];
  failWith = null;
  user = { id: ME };
});

/* ── how far back ───────────────────────────────────────────────────── */

describe("how far back the history reaches", () => {
  /* A NEW YORK RESTAURANT SERVING UNTIL 10PM writes `placed_at` values
     that are already tomorrow in UTC. A window cut at UTC midnight drops
     the busiest two hours of last night out of "Today" while the staff
     who cooked it are still in the building. */
  it("starts Today at midnight where the restaurant is, not where the server is", () => {
    expect(orderHistoryWindowStart(TZ, "today", NOW)).toBe("2026-08-17T04:00:00.000Z");
  });

  it("counts a week and a month back in whole local days, today included", () => {
    // Seven days ending with Aug 17 starts on Aug 11; thirty on Jul 19.
    expect(orderHistoryWindowStart(TZ, "week", NOW)).toBe("2026-08-11T04:00:00.000Z");
    expect(orderHistoryWindowStart(TZ, "month", NOW)).toBe("2026-07-19T04:00:00.000Z");
  });

  it("is the same instant however deep into the local day it is asked", () => {
    const morning = orderHistoryWindowStart(TZ, "week", new Date("2026-08-17T13:00:00.000Z"));
    expect(morning).toBe(orderHistoryWindowStart(TZ, "week", NOW));
  });

  /* The one window with no floor. It is not an unbounded READ -- the page
     it feeds is still fifty rows -- it is the absence of a date filter,
     which is what an owner hunting one old order needs and what
     everything else here is arranged to avoid paying for by default. */
  it("gives Everything no lower bound at all", () => {
    expect(orderHistoryWindowStart(TZ, "all", NOW)).toBeNull();
  });

  it("defaults to a week, which is a service a reader can recognise", () => {
    expect(DEFAULT_ORDER_HISTORY_WINDOW).toBe("week");
    expect(ORDER_HISTORY_WINDOWS.map((w) => w.key)).toEqual([
      "today",
      "week",
      "month",
      "all",
    ]);
  });
});

/* ── the list ───────────────────────────────────────────────────────── */

describe("the orders the history shows", () => {
  it("is exactly the two statuses the board has no column for", async () => {
    db.orders = [
      order({ id: "a", order_number: 1001, status: "completed" }),
      order({ id: "b", order_number: 1002, status: "cancelled" }),
      order({ id: "c", order_number: 1003, status: "ready" }),
      order({ id: "d", order_number: 1004, status: "new" }),
      order({ id: "e", order_number: 1005, status: "preparing" }),
    ];

    const { orders } = await getOrderHistoryPage(LOCATION, {
      timezone: TZ,
      window: "all",
      now: NOW,
    });

    expect(orders.map((o) => o.orderNumber).sort()).toEqual([1001, 1002]);
    expect([...ORDER_HISTORY_STATUSES].sort()).toEqual(["cancelled", "completed"]);
    expect(filteredOn).toContain("orders.status");
  });

  it("is this restaurant's and nobody else's, newest first", async () => {
    db.orders = [
      order({ id: "a", order_number: 1001, placed_at: "2026-08-17T20:00:00.000Z" }),
      order({ id: "b", order_number: 1002, placed_at: "2026-08-17T22:00:00.000Z" }),
      order({ id: "c", order_number: 999, location_id: OTHER_LOCATION }),
    ];

    const { orders } = await getOrderHistoryPage(LOCATION, {
      timezone: TZ,
      window: "all",
      now: NOW,
    });

    expect(orders.map((o) => o.orderNumber)).toEqual([1002, 1001]);
    expect(filteredOn).toContain("orders.location_id");
  });

  /* THE WINDOW IS A DATABASE FILTER, not a slice taken after the rows
     arrive. Reading a decade of orders and then throwing most of them
     away is the page this whole decision exists to avoid. */
  it("asks Postgres for the window rather than filtering what came back", async () => {
    db.orders = [
      // Yesterday evening in New York, which is TODAY in UTC.
      order({ id: "a", order_number: 1001, placed_at: "2026-08-18T01:00:00.000Z" }),
      // Six weeks ago.
      order({ id: "b", order_number: 900, placed_at: "2026-07-04T18:00:00.000Z" }),
    ];

    const { orders, since } = await getOrderHistoryPage(LOCATION, {
      timezone: TZ,
      window: "today",
      now: NOW,
    });

    expect(filteredOn).toContain("orders.placed_at");
    expect(since).toBe("2026-08-17T04:00:00.000Z");
    expect(orders.map((o) => o.orderNumber)).toEqual([1001]);
  });

  it("puts no floor under Everything", async () => {
    db.orders = [order({ id: "b", order_number: 900, placed_at: "2019-07-04T18:00:00.000Z" })];

    const { orders, since } = await getOrderHistoryPage(LOCATION, {
      timezone: TZ,
      window: "all",
      now: NOW,
    });

    expect(since).toBeNull();
    expect(filteredOn).not.toContain("orders.placed_at");
    expect(orders).toHaveLength(1);
  });
});

/* ── the scale ──────────────────────────────────────────────────────── */

describe("a restaurant with more history than a page", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      order({
        id: `ord-${i}`,
        order_number: 1000 + i,
        placed_at: new Date(NOW.getTime() - i * 60_000).toISOString(),
      }),
    );

  it("reads one page of fifty and counts the rest in the database", async () => {
    db.orders = many(120);

    const { orders, total, pageCount } = await getOrderHistoryPage(LOCATION, {
      timezone: TZ,
      window: "all",
      now: NOW,
    });

    expect(orders).toHaveLength(ORDERS_PER_HISTORY_PAGE);
    expect(total).toBe(120);
    expect(pageCount).toBe(3);
    // Counted by Postgres in a head request, not by measuring an array
    // that had to cross the wire first.
    expect(countedIn).toContain("orders");
    expect(ranges).toEqual([[0, 49]]);
  });

  it("walks back through the pages without ever widening the read", async () => {
    db.orders = many(120);

    const second = await getOrderHistoryPage(LOCATION, {
      timezone: TZ,
      window: "all",
      page: 2,
      now: NOW,
    });

    expect(ranges).toEqual([[50, 99]]);
    expect(second.orders).toHaveLength(50);
    expect(second.page).toBe(2);
    expect(second.orders[0].orderNumber).toBe(1050);
  });

  /* PostgREST answers a range whose offset is past the end of the result
     set with PGRST103 rather than an empty page, so a stale bookmark or a
     hand-edited URL is enough to 500 this screen. Same guard, and the
     same reason, as getCallsPage and getMessagesPage. */
  it("clamps a page number past the end rather than asking for a range that errors", async () => {
    db.orders = many(60);

    const asked = await getOrderHistoryPage(LOCATION, {
      timezone: TZ,
      window: "all",
      page: 99,
      now: NOW,
    });

    expect(asked.page).toBe(2);
    expect(ranges).toEqual([[50, 99]]);
  });

  it("clamps a page number below the first one too", async () => {
    db.orders = many(10);

    const asked = await getOrderHistoryPage(LOCATION, {
      timezone: TZ,
      window: "all",
      page: -4,
      now: NOW,
    });

    expect(asked.page).toBe(1);
    expect(ranges).toEqual([[0, 49]]);
  });

  it("still answers with a page when the restaurant has no history at all", async () => {
    const empty = await getOrderHistoryPage(LOCATION, {
      timezone: TZ,
      window: "week",
      now: NOW,
    });

    expect(empty.orders).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.pageCount).toBe(1);
    expect(empty.page).toBe(1);
  });
});

/* ── what must never reach a screen ─────────────────────────────────── */

describe("what the history hands the screen", () => {
  it("never hands a card number to the screen in a customer's name", async () => {
    db.orders = [order({ customer_name: "Phi 4111 1111 1111 1111" })];

    const { orders } = await getOrderHistoryPage(LOCATION, {
      timezone: TZ,
      window: "all",
      now: NOW,
    });

    expect(orders[0].customerName).toBe("Phi [redacted]");
  });

  it("throws rather than showing an empty history", async () => {
    // An empty history and a failed read look identical on screen, and
    // one of them means "you have taken no orders" while the other means
    // "we cannot tell you".
    db.orders = [order()];
    failWith = { message: "connection to server lost" };

    await expect(
      getOrderHistoryPage(LOCATION, { timezone: TZ, window: "all", now: NOW }),
    ).rejects.toBeTruthy();
  });
});

/* ── one order in full ──────────────────────────────────────────────── */

describe("one order's whole record", () => {
  beforeEach(() => {
    db.orders = [order()];
    db.order_items = [
      {
        id: "item-1",
        order_id: "ord-1001",
        name_snapshot: "Margherita",
        price_cents_snapshot: 1800,
        quantity: 1,
        modifiers: ["no onions"],
      },
    ];
    db.memberships = [
      { user_id: ME, org_id: ORG, role: "manager" },
      { user_id: BOSS, org_id: ORG, role: "owner" },
    ];
  });

  it("carries what was ordered, the money, the caller and the times", async () => {
    const record = await getOrderRecord(LOCATION, ORG, "ord-1001");

    expect(record).not.toBeNull();
    expect(record!.order.orderNumber).toBe(1001);
    expect(record!.order.totalCents).toBe(2700);
    expect(record!.order.customerName).toBe("Phi");
    expect(record!.order.customerPhone).toBe("(510) 555-0143");
    expect(record!.order.placedAt).toBe("2026-08-18T01:12:00.000Z");
    expect(record!.order.promisedAt).toBe("2026-08-18T01:37:00.000Z");
    expect(record!.order.callId).toBe("call-1");
    // The same shape, through the same redaction, as the board's ticket.
    expect(record!.order.lines).toEqual([
      { id: "item-1", name: "Margherita", quantity: 1, totalCents: 1800, note: "no onions" },
    ]);
  });

  /* THE FIRST READ OF order_status_events THIS PRODUCT HAS EVER HAD.
     Oldest first, because a timeline is read forwards. */
  it("brings the whole status log with it, oldest first", async () => {
    db.order_status_events = [
      event({ id: "ev-3", from_status: "preparing", to_status: "ready", changed_by: BOSS, changed_at: "2026-08-18T01:31:00.000Z" }),
      event({ id: "ev-1", from_status: null, to_status: "new", changed_by: null, changed_at: "2026-08-18T01:12:00.000Z" }),
      event({ id: "ev-2", from_status: "new", to_status: "preparing", changed_by: ME, changed_at: "2026-08-18T01:15:00.000Z" }),
    ];

    const record = await getOrderRecord(LOCATION, ORG, "ord-1001");

    expect(record!.events).toEqual([
      { id: "ev-1", from: null, to: "new", changedBy: null, changedAt: "2026-08-18T01:12:00.000Z" },
      { id: "ev-2", from: "new", to: "preparing", changedBy: ME, changedAt: "2026-08-18T01:15:00.000Z" },
      { id: "ev-3", from: "preparing", to: "ready", changedBy: BOSS, changedAt: "2026-08-18T01:31:00.000Z" },
    ]);
    expect(filteredOn).toContain("order_status_events.order_id");
  });

  /* Only this order's log. The table is not scoped by location at all --
     its RLS policy joins through `orders` -- so the filter is what keeps
     one order's page from being every order's log. */
  it("reads only this order's log", async () => {
    db.order_status_events = [
      event({ id: "mine" }),
      event({ id: "somebody-elses", order_id: "ord-9999" }),
    ];

    const record = await getOrderRecord(LOCATION, ORG, "ord-1001");

    expect(record!.events.map((e) => e.id)).toEqual(["mine"]);
  });

  /* The roles are the whole of what the timeline can say about a
     colleague, and they come from the organization's own memberships --
     readable on the owner's session under RLS's membership_read_own. */
  it("brings the organization's roles, so the log can name a colleague by theirs", async () => {
    const record = await getOrderRecord(LOCATION, ORG, "ord-1001");

    expect(record!.actors).toEqual({ [ME]: "manager", [BOSS]: "owner" });
    expect(record!.viewerId).toBe(ME);
    expect(filteredOn).toContain("memberships.org_id");
  });

  it("does not bring another organization's roles", async () => {
    db.memberships.push({ user_id: "someone", org_id: OTHER_ORG, role: "owner" });

    const record = await getOrderRecord(LOCATION, ORG, "ord-1001");

    expect(Object.keys(record!.actors).sort()).toEqual([ME, BOSS].sort());
  });

  /* An order with no log at all is a real row: `orders` predates nothing
     here, but a restore, a direct INSERT that rolled the trigger back
     before 20260819000100, or a hand-written fixture all leave one. The
     screen has to be able to say so, which means the read may not
     mistake it for an order that does not exist. */
  it("is still a record when the log is empty", async () => {
    const record = await getOrderRecord(LOCATION, ORG, "ord-1001");

    expect(record!.events).toEqual([]);
    expect(record!.order.orderNumber).toBe(1001);
  });

  it("is null for an order this restaurant cannot see", async () => {
    db.orders = [order({ id: "ord-rival", location_id: OTHER_LOCATION })];

    expect(await getOrderRecord(LOCATION, ORG, "ord-rival")).toBeNull();
    expect(filteredOn).toContain("orders.location_id");
  });

  it("is null for an order that does not exist", async () => {
    expect(await getOrderRecord(LOCATION, ORG, "ord-nothing")).toBeNull();
  });

  it("never hands a card number to the screen, in a name, a note or an address", async () => {
    db.orders = [
      order({
        customer_name: "Phi 4111 1111 1111 1111",
        type: "delivery",
        notes: "leave with the card 4111-1111-1111-1111",
      }),
    ];
    db.order_items = [
      {
        id: "item-1",
        order_id: "ord-1001",
        name_snapshot: "Margherita",
        price_cents_snapshot: 1800,
        quantity: 1,
        modifiers: ["ring 4111 1111 1111 1111 back"],
      },
    ];

    const record = await getOrderRecord(LOCATION, ORG, "ord-1001");

    expect(record!.order.customerName).toBe("Phi [redacted]");
    expect(record!.order.address).toBe("leave with the card [redacted]");
    expect(record!.order.lines[0].note).toBe("ring [redacted] back");
  });

  it("throws rather than showing an order with a timeline it could not read", async () => {
    failWith = { message: "connection to server lost" };

    await expect(getOrderRecord(LOCATION, ORG, "ord-1001")).rejects.toBeTruthy();
  });

  it("still renders for a session whose user could not be resolved", async () => {
    // Signed out is not a state this screen loads in -- the middleware
    // sees to that -- but the timeline must not become "you" for
    // everybody, or nobody, because one auth round trip came back empty.
    user = null;

    const record = await getOrderRecord(LOCATION, ORG, "ord-1001");

    expect(record!.viewerId).toBeNull();
  });
});
