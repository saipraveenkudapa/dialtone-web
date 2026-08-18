import { beforeEach, describe, expect, it, vi } from "vitest";

/** The read behind the restaurant's own Orders screen.
 *
 *  A caller placed a real order on the phone -- #1001, two lines, linked
 *  to its call -- and the restaurant went to look at it and found a stub.
 *  Everything that read `orders` before this belonged to somebody else:
 *  the operator console's tab (components/admin/OrdersTab.tsx), the
 *  Today counters, the one order hanging off a call. The kitchen had no
 *  reader of its own.
 *
 *  So what this file pins is what a kitchen has to be able to trust:
 *  that the board is this restaurant's orders and nobody else's, newest
 *  first, bounded, with the LINES on them -- including the note on a
 *  line, which is the difference between a right and a wrong plate --
 *  and with nothing on it that a screen must never render.
 *
 *  The database is the same small in-memory stand-in for PostgREST's
 *  builder that lib/agent/message-inbox.test.ts uses, extended with the
 *  one thing this read needs and that one did not: an embedded child
 *  table (`order_items(*)`). It records the columns each query filtered
 *  on, so "scoped to one location" is asserted directly rather than
 *  inferred from the rows that came back.
 */

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: { message: string } | null };

type Query = {
  eq: (column: string, value: unknown) => Query;
  order: (column: string, opts: { ascending: boolean }) => Query;
  limit: (count: number) => Query;
  then: Promise<Result>["then"];
};

let db: { orders: Row[]; order_items: Row[] };
let filteredOn: string[];
let selected: string;
let failWith: { message: string } | null;

function makeQuery(columns: string, embedded: Row[]): Query {
  selected = columns;

  let matched = db.orders;
  let ordering: { column: string; ascending: boolean } | null = null;
  let ceiling: number | null = null;

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
    if (ceiling !== null) out = out.slice(0, ceiling);

    // PostgREST returns an embedded table as an array on each parent row,
    // and only when the select string asked for it.
    return {
      data: out.map((order) =>
        columns.includes("order_items")
          ? { ...order, order_items: embedded.filter((i) => i.order_id === order.id) }
          : { ...order },
      ),
      error: null,
    };
  };

  const query: Query = {
    eq(column, value) {
      filteredOn.push(column);
      matched = matched.filter((row) => row[column] === value);
      return query;
    },
    order(column, opts) {
      ordering = { column, ascending: opts.ascending };
      return query;
    },
    limit(count) {
      ceiling = count;
      return query;
    },
    then: (onFulfilled, onRejected) =>
      Promise.resolve(settle()).then(onFulfilled, onRejected),
  };

  return query;
}

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    from: (table: string) => ({
      select: (columns: string) => {
        if (table !== "orders") throw new Error(`unexpected table ${table}`);
        return makeQuery(columns, db.order_items);
      },
    }),
  }),
}));

const { ORDERS_ON_THE_BOARD, getOrdersBoard } = await import("@/lib/data");

const LOCATION = "loc-nonna";
const OTHER_LOCATION = "loc-martys";

/** An order the way place_order writes one: `notes` is the delivery
 *  address and nothing else, `promised_at` is when it was said to be
 *  ready, and a pickup order carries no address at all. */
function order(over: Row = {}): Row {
  return {
    id: "ord-1001",
    location_id: LOCATION,
    call_id: "call-1",
    order_number: 1001,
    customer_name: "Phi",
    customer_phone: "(510) 555-0143",
    type: "pickup",
    status: "new",
    total_cents: 2700,
    notes: null,
    placed_at: "2026-08-18T01:12:00.000Z",
    promised_at: "2026-08-18T01:37:00.000Z",
    ...over,
  };
}

/** A line the way place_order writes one: the name and the price are
 *  snapshots, and a spoken change to the line is a one-element array of
 *  strings in `modifiers`. */
function line(over: Row = {}): Row {
  return {
    id: "item-1",
    order_id: "ord-1001",
    name_snapshot: "Margherita",
    price_cents_snapshot: 1800,
    quantity: 1,
    modifiers: [],
    ...over,
  };
}

beforeEach(() => {
  db = { orders: [], order_items: [] };
  filteredOn = [];
  selected = "";
  failWith = null;
});

describe("the orders a kitchen is shown", () => {
  it("is scoped to this restaurant, newest first, and no longer than the board", async () => {
    db.orders = [
      order({ id: "a", order_number: 1001, placed_at: "2026-08-18T01:00:00.000Z" }),
      order({ id: "b", order_number: 1002, placed_at: "2026-08-18T02:00:00.000Z" }),
      order({ id: "c", order_number: 999, location_id: OTHER_LOCATION }),
    ];

    const board = await getOrdersBoard(LOCATION);

    expect(board.map((o) => o.orderNumber)).toEqual([1002, 1001]);
    expect(filteredOn).toContain("location_id");
  });

  it("stops at the board's limit rather than reading a restaurant's whole history", async () => {
    // One more order than the board carries, so a limit that is missing
    // or off by one shows up as a row that should not be here.
    db.orders = Array.from({ length: ORDERS_ON_THE_BOARD + 1 }, (_, i) =>
      order({
        id: `ord-${i}`,
        order_number: 1000 + i,
        placed_at: `2026-08-${String(10 + Math.floor(i / 24)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      }),
    );

    const board = await getOrdersBoard(LOCATION);

    expect(board).toHaveLength(ORDERS_ON_THE_BOARD);
  });

  it("brings each order's lines with it, priced for the whole line", async () => {
    db.orders = [order()];
    db.order_items = [
      line({ id: "item-1", name_snapshot: "Margherita", price_cents_snapshot: 1800, quantity: 1 }),
      line({ id: "item-2", name_snapshot: "Garlic bread", price_cents_snapshot: 450, quantity: 2 }),
    ];

    const [placed] = await getOrdersBoard(LOCATION);

    expect(selected).toContain("order_items");
    expect(placed.lines).toEqual([
      { id: "item-1", name: "Margherita", quantity: 1, totalCents: 1800, note: null },
      { id: "item-2", name: "Garlic bread", quantity: 2, totalCents: 900, note: null },
    ]);
  });

  /* WHY THIS IS THE MOST IMPORTANT ASSERTION IN THE FILE. "No onions" is
     said out loud, confirmed back to the caller, and written to the line
     it belongs to (20260812000650_place_order_item_notes.sql). A board
     that drops it hands the pass a ticket that reads `1x Margherita`,
     which is the exact defect that migration exists to close, one screen
     further along. */
  it("carries the note on the line it was said about", async () => {
    db.orders = [order()];
    db.order_items = [line({ modifiers: ["no onions"] })];

    const [placed] = await getOrdersBoard(LOCATION);

    expect(placed.lines[0].note).toBe("no onions");
  });

  it("has no note when nothing was asked for, and ignores anything that is not text", async () => {
    db.orders = [order()];
    db.order_items = [
      line({ id: "item-1", modifiers: [] }),
      line({ id: "item-2", modifiers: null }),
      // The column's other documented future: priced modifier objects
      // alongside the free-text note. An object is not a sentence a cook
      // can read, so it is not rendered as one.
      line({ id: "item-3", modifiers: [{ name: "Large", price_delta_cents: 300 }] }),
    ];

    const board = await getOrdersBoard(LOCATION);

    expect(board[0].lines.map((l) => l.note)).toEqual([null, null, null]);
  });

  /* No column, payload, log line or screen in this product may hold a
     card number. Notes are scrubbed on the way in by
     lib/agent/redact.ts -- but `order_items.modifiers` is writable by
     any authenticated member of the organization under RLS's
     `order_items_rw`, so the write path is not the only way text reaches
     this column, and the read is the last place to keep the promise. */
  it("never hands a card number to the screen", async () => {
    db.orders = [order()];
    db.order_items = [line({ modifiers: ["ring 4111 1111 1111 1111 back"] })];

    const [placed] = await getOrdersBoard(LOCATION);

    expect(placed.lines[0].note).toBe("ring [redacted] back");
  });
});

describe("where the food is going", () => {
  it("gives a delivery its address", async () => {
    db.orders = [order({ type: "delivery", notes: "742 Evergreen Terrace, apt 2" })];

    const [placed] = await getOrdersBoard(LOCATION);

    expect(placed.type).toBe("delivery");
    expect(placed.address).toBe("742 Evergreen Terrace, apt 2");
  });

  it("gives a pickup none", async () => {
    db.orders = [order({ type: "pickup" })];

    const [placed] = await getOrdersBoard(LOCATION);

    expect(placed.address).toBeNull();
  });

  /* The address is the ONE free-text field a caller speaks that
     `place_order` stores exactly as it arrives -- there is no
     redactCardNumbers between the tool call and the column, the way
     there is for an item note and a message body. So the read scrubs it
     too, rather than trusting a write path that does not promise this. */
  it("never hands a card number to the screen in an address either", async () => {
    db.orders = [
      order({ type: "delivery", notes: "leave with the card 4111-1111-1111-1111" }),
    ];

    const [placed] = await getOrdersBoard(LOCATION);

    expect(placed.address).toBe("leave with the card [redacted]");
  });
});

describe("when the read itself goes wrong", () => {
  it("throws rather than showing an empty kitchen", async () => {
    // An empty board and a failed read look identical on screen, and one
    // of them means "you have no orders" while the other means "we
    // cannot tell you". Throwing keeps them apart.
    db.orders = [order()];
    failWith = { message: "connection to server lost" };

    await expect(getOrdersBoard(LOCATION)).rejects.toBeTruthy();
  });
});
