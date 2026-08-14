import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

/** Exercises `app/api/agent/order/route.ts` directly -- calling its
 *  exported `POST` with a real `Request`, no HTTP server involved -- for
 *  the one thing unit tests on `buildOrderLines` cannot show: what a
 *  caller's spoken word actually turns into on the wire.
 *
 *  The failure this pins down was proven live at a burger restaurant.
 *  "Fries" matches Hand Cut Fries and Cheese Fries, `matchItem` returned
 *  null for that exactly as it does for a word nothing on the menu
 *  answers to, and the route reported both as `unknown_item` -- so the
 *  agent apologised for not selling fries and handed the call to a human,
 *  on most calls at a burger shop. `lib/agent/orders.test.ts` covers the
 *  matcher; this covers the answer: `ambiguous_item`, 200, with every
 *  name the words could have meant, so the agent can ask which one.
 *
 *  Only the reads the ambiguity path reaches are mocked in detail -- the
 *  menu, the hours, and the secret lookup. Nothing here writes. */

const SECRET = "swordfish";
const SECRET_HASH = crypto.createHash("sha256").update(SECRET, "utf-8").digest("hex");

const LOCATION = {
  id: "loc-fries",
  agent_secret_hash: SECRET_HASH,
  timezone: "America/Los_Angeles",
  order_types: "pickup",
  tax_rate_bps: 0,
  pickup_promise_minutes: 20,
  delivery_promise_minutes: 45,
};

/** The menu that started this: two things a caller means by "fries". */
const MENU = [
  { id: "f1", name: "Hand Cut Fries", price_cents: 500, sold_out_until: null },
  { id: "f2", name: "Cheese Fries", price_cents: 700, sold_out_until: null },
  { id: "f3", name: "Double Cheeseburger", price_cents: 1300, sold_out_until: null },
];

/** Location ids every query was scoped by. Tool endpoints run as the
 *  service role and bypass RLS, so "scoped to the location the secret
 *  resolved to" is a property of this code and nothing else -- asserted
 *  here rather than assumed. */
let scopedTo: string[];
let placeOrderArgs: Record<string, unknown> | null;

const rpcResult = {
  placed: true,
  duplicate: false,
  order_id: "order-1",
  order_number: 1042,
  subtotal_cents: 700,
  tax_cents: 0,
  total_cents: 700,
  reason: null,
  item: null,
};

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "locations") {
        return {
          select: () => ({
            not: () => ({
              eq: (_col: string, hash: string) => ({
                maybeSingle: async () => ({
                  data: hash === SECRET_HASH ? LOCATION : null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      const rows = table === "menu_items" ? MENU : [];
      // `.eq()` is where the location scope is applied; `.order()` is
      // optional on the chain, so both shapes have to resolve.
      const resolved = Promise.resolve({ data: rows, error: null });
      return {
        select: () => ({
          eq: (_col: string, value: string) => {
            scopedTo.push(value);
            return Object.assign(resolved, { order: () => resolved });
          },
        }),
        update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
      };
    },
    rpc: (_fn: string, args: Record<string, unknown>) => {
      placeOrderArgs = args;
      return { single: async () => ({ data: rpcResult, error: null }) };
    },
  }),
}));

vi.mock("@/lib/agent/context", () => ({
  callIdForProvider: async () => null,
}));

vi.mock("@/lib/agent/notify", () => ({
  orderMessage: () => "ticket",
  sendOrderSms: async () => true,
}));

const { POST } = await import("@/app/api/agent/order/route");

/** Vapi's envelope, unwrapped: `{results:[{toolCallId, result|error}]}`.
 *  The wrapper's own shape is asserted on the way past, so every test
 *  that reads a payload also pins the always-200 status, the results
 *  ARRAY and its single entry. */
async function toolResult(res: Response) {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.results)).toBe(true);
  expect(body.results).toHaveLength(1);
  return body.results[0] as { toolCallId: string | null; result?: string; error?: string };
}

/** The success payload, parsed back out of its single-line string --
 *  Vapi requires `result` to be a STRING, not an object. */
async function okResult(res: Response) {
  const entry = await toolResult(res);
  expect(entry.error).toBeUndefined();
  expect(typeof entry.result).toBe("string");
  return JSON.parse(entry.result as string);
}


const order = async (items: unknown) =>
  POST(
    new Request("https://example.test/api/agent/order", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dialtone-secret": SECRET },
      body: JSON.stringify({
        items,
        type: "pickup",
        customer_name: "QA Caller",
        customer_phone: "+15105550123",
      }),
    }),
  );

beforeEach(() => {
  scopedTo = [];
  placeOrderArgs = null;
});

describe("place_order, when a spoken word could mean more than one item", () => {
  it("asks which one, carrying both names, instead of reporting unknown_item", async () => {
    const response = await order([{ name: "fries", quantity: 2 }]);
    // A `result`, not an `error`: "hand cut or cheese?" is an ordinary
    // thing a host says, not a request that could not be understood.
    expect(await okResult(response)).toEqual({
      placed: false,
      reason: "ambiguous_item",
      item: "fries",
      options: ["Hand Cut Fries", "Cheese Fries"],
    });
    // Nothing was written on the way to asking a question.
    expect(placeOrderArgs).toBeNull();
  });

  it("still reports unknown_item, with no options, for something the menu does not have", async () => {
    const response = await order([{ name: "onion rings" }]);
    expect(await okResult(response)).toEqual({
      placed: false,
      reason: "unknown_item",
      item: "onion rings",
    });
  });

  it("places the order when the caller names one of them outright", async () => {
    const response = await order([{ name: "cheese fries", quantity: 1 }]);
    const body = await okResult(response);
    expect(body.placed).toBe(true);
    expect(body.order_number).toBe(1042);
    // The item that reached the write is the one they named -- the
    // ambiguity answer must not have turned into a guess anywhere.
    expect(placeOrderArgs?.p_item_ids).toEqual(["f2"]);
    // ...and no price came from the request body.
    expect(Object.keys(placeOrderArgs ?? {})).not.toContain("p_price_cents");
  });

  it("resolves a single partial match without asking anything", async () => {
    const response = await order([{ name: "double" }]);
    expect((await okResult(response)).placed).toBe(true);
    expect(placeOrderArgs?.p_item_ids).toEqual(["f3"]);
  });

  it("carries Vapi's own call id into the order, so a retry is recognisable as one", async () => {
    // `p_provider_call_id` is the fingerprint place_order dedupes a
    // retried tool call on. It has been null on every order ever placed:
    // the id was declared through Vapi's staticParameters mechanism,
    // which attaches nothing the route can read, and the route looked for
    // it at the top level of a body Vapi never sends. Both halves are
    // fixed by reading `message.call.id`.
    const response = await POST(
      new Request("https://example.test/api/agent/order", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dialtone-secret": SECRET },
        body: JSON.stringify({
          message: {
            type: "tool-calls",
            toolCalls: [
              {
                id: "call_9w3zzVmqKj04ah0kW95p5BjI",
                type: "function",
                function: {
                  name: "place_order",
                  arguments: JSON.stringify({
                    items: [{ name: "cheese fries", quantity: 1 }],
                    type: "pickup",
                    customer_name: "QA Caller",
                    customer_phone: "+15105550123",
                  }),
                },
              },
            ],
            call: { id: "01a000a0-430a-766c-ad61-b9ac47a0552b" },
          },
        }),
      }),
    );

    expect((await okResult(response)).placed).toBe(true);
    // The arguments were read out of the tool call, not the top level.
    expect(placeOrderArgs?.p_item_ids).toEqual(["f2"]);
    expect(placeOrderArgs?.p_provider_call_id).toBe("01a000a0-430a-766c-ad61-b9ac47a0552b");
  });

  it("reads the menu scoped to the location the secret resolved to, never a body value", async () => {
    await order([{ name: "fries" }]);
    expect(scopedTo.length).toBeGreaterThan(0);
    expect(new Set(scopedTo)).toEqual(new Set([LOCATION.id]));
  });

  it("refuses a request with no secret at all -- a flat body is not a tool call", async () => {
    const response = await POST(
      new Request("https://example.test/api/agent/order", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [{ name: "fries" }] }),
      }),
    );
    expect(response.status).toBe(401);
  });
});

/** `Array.isArray(args.items)` guards the WRAPPER and nothing inside it.
 *  The route's own comment above that check argues the case for
 *  validating up front -- "an unwrapped throw in a route becomes a
 *  framework 500 -- which Vapi discards entirely, so the caller hears
 *  nothing at all" -- and then stopped at the array itself.
 *
 *  `items` comes out of a `JSON.parse` of a model-authored `arguments`
 *  string, so `RequestedItem`'s `name?: string` is a claim about the type
 *  and not a guarantee about the bytes; `as RequestedItem[]` is exactly
 *  what kept tsc quiet. Two element shapes escaped the handler:
 *
 *    items: [null]         -> "Cannot read properties of null (reading
 *                             'name')" in buildOrderLines
 *    items: [{"name": 7}]  -> "value.trim is not a function" in
 *                             matchItem's `normalise`
 *
 *  Both became a framework 500, which Vapi discards, so a caller in the
 *  middle of ordering heard silence rather than "I didn't catch that".
 *  `items: ["wings"]` did NOT throw -- property access on a string just
 *  yields undefined -- which is why this survived the migration's tests. */
describe("place_order, when an item entry is not the shape it is declared to be", () => {
  it.each([
    ["null", [null]],
    ["a null among good entries", [{ name: "cheese fries" }, null]],
    ["a numeric name", [{ name: 7, quantity: 1 }]],
    ["an object name", [{ name: { first: "cheese" } }]],
    ["a bare string", ["wings"]],
    ["a number", [42]],
    ["a nested array", [["cheese fries"]]],
  ])("answers %s with a spoken sentence, not a framework 500", async (_label, items) => {
    const response = await order(items);
    const entry = await toolResult(response);
    expect(entry.error).toBe("I didn't catch what you'd like to order.");
    expect(entry.result).toBeUndefined();
    // Nothing was written on the way to asking again.
    expect(placeOrderArgs).toBeNull();
  });

  it("still takes an order whose entries are the shape they claim", async () => {
    // The guard must not have closed the door on the ordinary payload:
    // `name` present as text, and `name` absent entirely (which
    // buildOrderLines already answers as unknown_item).
    expect((await okResult(await order([{ name: "cheese fries", quantity: 1 }]))).placed).toBe(true);
    expect(await okResult(await order([{ quantity: 1 }]))).toEqual({
      placed: false,
      reason: "unknown_item",
      item: undefined,
    });
  });
});
