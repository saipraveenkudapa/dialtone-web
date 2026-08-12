import { beforeEach, describe, expect, it, vi } from "vitest";

/** What happens to a taken message after `take_message` writes it --
 *  `lib/data.ts`'s side of the same row `messages.ts` and
 *  `message-route.test.ts` build and store.
 *
 *  It is tested here, beside the tool, because the two halves only mean
 *  something together. The route deliberately writes `call_id: null`
 *  when the telephony webhook has not created the call row yet, and the
 *  foreign key is ON DELETE SET NULL so the message outlives the call --
 *  both so that a person waiting for a callback is never lost. For a
 *  while the only reader in the product was `getCall`, which asks
 *  `.eq("call_id", callId)`, so exactly the rows those two decisions
 *  were meant to protect were the rows nobody could see: stored,
 *  counted by `messages_open_idx`, on no screen. The tool's promise is
 *  kept by the reader, or it is not kept at all.
 *
 *  The database is a small in-memory stand-in for PostgREST's builder --
 *  enough of `eq`/`in`/`order`/`range`/`head` to run the real query
 *  code. It also records which columns each query filtered on, so
 *  "never scoped by call" can be asserted directly rather than inferred
 *  from the rows that came back. */

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; count: number | null; error: null };

type Query = {
  eq: (column: string, value: unknown) => Query;
  is: (column: string, value: unknown) => Query;
  in: (column: string, values: unknown[]) => Query;
  order: (column: string, opts: { ascending: boolean }) => Query;
  range: (from: number, to: number) => Query;
  then: Promise<Result>["then"];
};

/** Every table the code under test reads, and every column it filtered
 *  on while reading -- reset before each test. */
let db: Record<string, Row[]>;
let filteredOn: Record<string, string[]>;

function makeQuery(rows: Row[], head: boolean, columns: string[]): Query {
  let matched = rows;
  let ordering: { column: string; ascending: boolean } | null = null;
  let window: { from: number; to: number } | null = null;

  const settle = (): Result => {
    let out = [...matched];
    if (ordering) {
      const { column, ascending } = ordering;
      out.sort((a, b) => {
        const left = String(a[column]);
        const right = String(b[column]);
        return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
      });
    }
    const count = out.length;
    if (window) out = out.slice(window.from, window.to + 1);
    return { data: head ? null : out, count, error: null };
  };

  const query: Query = {
    eq(column, value) {
      columns.push(column);
      matched = matched.filter((row) => row[column] === value);
      return query;
    },
    is(column, value) {
      columns.push(column);
      matched = matched.filter((row) => (row[column] ?? null) === value);
      return query;
    },
    in(column, values) {
      columns.push(column);
      matched = matched.filter((row) => values.includes(row[column]));
      return query;
    },
    order(column, opts) {
      ordering = { column, ascending: opts.ascending };
      return query;
    },
    range(from, to) {
      window = { from, to };
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
      select: (_columns: string, options?: { count?: string; head?: boolean }) =>
        makeQuery(
          db[table] ?? [],
          options?.head === true,
          (filteredOn[table] ??= []),
        ),
    }),
  }),
}));

const { getCallsPage, getMessagesPage } = await import("@/lib/data");

const LOCATION = "loc-nonna";
const OTHER_LOCATION = "loc-martys";

/** A message the way the route writes one. */
const message = (over: Row = {}): Row => ({
  id: "msg-1",
  location_id: LOCATION,
  call_id: "call-1",
  caller_name: "Dana Whitlock",
  callback_phone: "011 44 20 7946 0958",
  body: "Unhappy about Friday's order, wants the manager to ring back.",
  taken_at: "2026-08-12T18:00:00.000Z",
  handled: false,
  handled_at: null,
  ...over,
});

beforeEach(() => {
  db = { messages: [], calls: [], orders: [], bookings: [] };
  filteredOn = {};
});

describe("the message book", () => {
  it("shows a message taken before the call row existed", async () => {
    // The one the product used to lose: no call to open, so no way in.
    db.messages = [message({ id: "orphan", call_id: null })];

    const { messages, total, openTotal } = await getMessagesPage(LOCATION);

    expect(messages.map((m) => m.id)).toEqual(["orphan"]);
    expect(total).toBe(1);
    expect(openTotal).toBe(1);
  });

  it("shows a message whose call was deleted out from under it", async () => {
    // ON DELETE SET NULL, which is the schema saying the message must
    // outlive the call. It only does if something reads it.
    db.messages = [
      message({ id: "kept", call_id: null }),
      message({ id: "still-attached", call_id: "call-1" }),
    ];

    const { messages } = await getMessagesPage(LOCATION);

    expect(messages.map((m) => m.id).sort()).toEqual(["kept", "still-attached"]);
  });

  it("is scoped by the restaurant and never by a call", async () => {
    db.messages = [message({ id: "orphan", call_id: null })];

    await getMessagesPage(LOCATION);

    expect(filteredOn.messages).toContain("location_id");
    expect(filteredOn.messages).not.toContain("call_id");
    expect(filteredOn.messages).not.toContain("id");
  });

  it("does not show another restaurant's messages", async () => {
    db.messages = [
      message({ id: "ours" }),
      message({ id: "theirs", location_id: OTHER_LOCATION, call_id: null }),
    ];

    const { messages, total } = await getMessagesPage(LOCATION);

    expect(messages.map((m) => m.id)).toEqual(["ours"]);
    expect(total).toBe(1);
  });

  it("opens on what is still waiting, not on everything ever taken", async () => {
    db.messages = [
      message({ id: "open", call_id: null }),
      message({
        id: "done",
        handled: true,
        handled_at: "2026-08-12T18:30:00.000Z",
      }),
    ];

    const open = await getMessagesPage(LOCATION, { filter: "open" });
    expect(open.messages.map((m) => m.id)).toEqual(["open"]);
    expect(open.total).toBe(1);

    const all = await getMessagesPage(LOCATION, { filter: "all" });
    expect(all.messages.map((m) => m.id).sort()).toEqual(["done", "open"]);
    expect(all.total).toBe(2);
    // The count that matters is the same number under either filter.
    expect(all.openTotal).toBe(1);
    expect(open.openTotal).toBe(1);
  });

  it("puts the newest message first", async () => {
    db.messages = [
      message({ id: "older", taken_at: "2026-08-12T17:00:00.000Z" }),
      message({ id: "newest", taken_at: "2026-08-12T19:00:00.000Z", call_id: null }),
      message({ id: "middle", taken_at: "2026-08-12T18:00:00.000Z" }),
    ];

    const { messages } = await getMessagesPage(LOCATION, { filter: "all" });

    expect(messages.map((m) => m.id)).toEqual(["newest", "middle", "older"]);
  });

  it("clamps a page past the end instead of asking PostgREST for one", async () => {
    // PGRST103 is a 500, and a stale bookmark is enough to reach it.
    db.messages = [message()];

    const { messages, page, pageCount } = await getMessagesPage(LOCATION, { page: 9 });

    expect(page).toBe(1);
    expect(pageCount).toBe(1);
    expect(messages).toHaveLength(1);
  });

  it("says nothing is waiting when nothing is", async () => {
    const { messages, total, openTotal, pageCount } = await getMessagesPage(LOCATION);

    expect(messages).toEqual([]);
    expect(total).toBe(0);
    expect(openTotal).toBe(0);
    expect(pageCount).toBe(1);
  });
});

describe("the marker on the call log", () => {
  const call = (over: Row = {}): Row => ({
    id: "call-1",
    location_id: LOCATION,
    started_at: "2026-08-12T18:00:00.000Z",
    outcome: "question",
    transferred_to_human: false,
    is_spam: false,
    answered_at: "2026-08-12T18:00:05.000Z",
    ...over,
  });

  it("marks a call that left somebody waiting for a callback", async () => {
    db.calls = [call()];
    db.messages = [message()];

    const { messageByCall } = await getCallsPage(LOCATION);

    expect(messageByCall.get("call-1")).toEqual({ total: 1, open: 1 });
  });

  it("counts both copies when a retried tool call left two", async () => {
    db.calls = [call()];
    db.messages = [
      message({ id: "msg-1" }),
      message({ id: "msg-2", handled: true, handled_at: "2026-08-12T18:30:00.000Z" }),
    ];

    const { messageByCall } = await getCallsPage(LOCATION);

    expect(messageByCall.get("call-1")).toEqual({ total: 2, open: 1 });
  });

  it("leaves a call that produced nothing unmarked", async () => {
    db.calls = [call({ id: "call-2" })];
    db.messages = [message({ call_id: null })];

    const { messageByCall } = await getCallsPage(LOCATION);

    expect(messageByCall.size).toBe(0);
  });
});
