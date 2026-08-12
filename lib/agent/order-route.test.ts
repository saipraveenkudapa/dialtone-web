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
    // 200, not 400: "hand cut or cheese?" is an ordinary thing a host
    // says, not a request that could not be understood.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
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
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      placed: false,
      reason: "unknown_item",
      item: "onion rings",
    });
  });

  it("places the order when the caller names one of them outright", async () => {
    const response = await order([{ name: "cheese fries", quantity: 1 }]);
    const body = await response.json();
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
    expect((await response.json()).placed).toBe(true);
    expect(placeOrderArgs?.p_item_ids).toEqual(["f3"]);
  });

  it("reads the menu scoped to the location the secret resolved to, never a body value", async () => {
    await order([{ name: "fries" }]);
    expect(scopedTo.length).toBeGreaterThan(0);
    expect(new Set(scopedTo)).toEqual(new Set([LOCATION.id]));
  });

  it("refuses a request with no secret at all", async () => {
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
