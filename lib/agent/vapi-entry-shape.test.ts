import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { parseToolCall } from "./vapi";

/** The regression test for the orders that were never written.
 *
 *  On 2026-08-18 two callers confirmed a total and heard "Looks like
 *  something went wrong placing the order." The `orders` table was
 *  empty. Vapi's own call log shows the model had sent a perfectly
 *  formed payload --
 *
 *    {"type":"pickup","items":[{"name":"Meatballs al Forno","quantity":1},
 *                              {"name":"Lasagne Verdi","quantity":1}],
 *     "customer_name":"Mike","customer_phone":"4093337727"}
 *
 *  -- and got back "I don't have any items yet.", which is
 *  app/api/agent/order/route.ts's answer to `items` being absent.
 *
 *  The cause was a parser that branched on WHICH KEY the tool call
 *  arrived under and then assumed the shape of the entries inside it:
 *  `toolCallList` meant flat `{id, name, arguments}` entries and
 *  `toolCalls` meant OpenAI `{id, function:{name, arguments}}` entries.
 *  Vapi sends `toolCallList` carrying OPENAI-SHAPED entries. The first
 *  branch won, read `entry.arguments` (undefined), coerced it to `{}`,
 *  and every route saw a call with no arguments at all.
 *
 *  WHY NOTHING CAUGHT IT. `get_menu` and `get_hours` are the two tools a
 *  probe reaches for, and for an argument-less call `{}` is
 *  indistinguishable from a successful parse -- so they answered
 *  perfectly on the very same calls whose orders were being dropped. The
 *  contract test next door fixtures `get_menu` with `{}`. Every
 *  hand-rolled probe used a container and an entry shape that matched.
 *  The defect lived exactly in the MISMATCH between the two, and nothing
 *  had ever constructed one.
 *
 *  So this file does not test a shape. It tests the MATRIX: every
 *  container crossed with every entry shape crossed with both argument
 *  encodings, for every tool that carries arguments, asserting that all
 *  of them arrive at the route identically. A test that exercises one
 *  combination is how this shipped. */

// ---------------------------------------------------------------------
// The matrix.
// ---------------------------------------------------------------------

/** The three keys Vapi has been seen to deliver a tool call under. */
const CONTAINERS = ["toolCallList", "toolCalls", "toolWithToolCallList"] as const;
type Container = (typeof CONTAINERS)[number];

/** The two shapes an entry inside any of those containers can have.
 *  Which container an entry arrives in says NOTHING about which of these
 *  it is -- that assumption is the entire bug. */
const ENTRY_SHAPES = ["flat", "openai"] as const;
type EntryShape = (typeof ENTRY_SHAPES)[number];

/** `arguments` is a JSON string in OpenAI's own wire format and an
 *  already-parsed object in Vapi's documented one, and either can turn
 *  up in either entry shape. */
const ENCODINGS = ["object", "string"] as const;
type Encoding = (typeof ENCODINGS)[number];

type Combination = {
  label: string;
  container: Container;
  shape: EntryShape;
  encoding: Encoding;
};

const COMBINATIONS: Combination[] = CONTAINERS.flatMap((container) =>
  ENTRY_SHAPES.flatMap((shape) =>
    ENCODINGS.map((encoding) => ({
      label: `${container} + ${shape} entry + ${encoding} arguments`,
      container,
      shape,
      encoding,
    })),
  ),
);

const TOOL_CALL_ID = "call_9w3zzVmqKj04ah0kW95p5BjI";
const PROVIDER_CALL_ID = "01a000a0-430a-766c-ad61-b9ac47a0552b";

function entryFor(
  combination: Combination,
  name: string,
  args: Record<string, unknown>,
  id: string,
) {
  const encoded = combination.encoding === "string" ? JSON.stringify(args) : args;
  return combination.shape === "openai"
    ? { id, type: "function", function: { name, arguments: encoded } }
    : { id, name, arguments: encoded };
}

/** One Vapi POST body for a given point in the matrix. */
function envelope(
  combination: Combination,
  name: string,
  args: Record<string, unknown>,
  id = TOOL_CALL_ID,
) {
  const entry = entryFor(combination, name, args, id);
  const list =
    combination.container === "toolWithToolCallList"
      ? // This container nests the call one level deeper, under a `tool`
        // describing the declaration it came from.
        [{ tool: { type: "function", function: { name } }, toolCall: entry }]
      : [entry];

  return {
    message: {
      timestamp: 1755547200000,
      type: "tool-calls",
      [combination.container]: list,
      call: { id: PROVIDER_CALL_ID, orgId: "org-uuid", type: "inboundPhoneCall" },
      assistant: {},
    },
  };
}

// ---------------------------------------------------------------------
// Nonna Rosa, as of the two lost orders. Mike's $40.00 is Meatballs al
// Forno + Lasagne Verdi; Sai's $25.00 is Meatballs al Forno + Olive Oil
// Cake. Those totals are what the callers heard read back and confirmed,
// so they are what the prices below have to add up to.
// ---------------------------------------------------------------------

const SECRET = "swordfish";
const SECRET_HASH = crypto.createHash("sha256").update(SECRET, "utf-8").digest("hex");

const LOCATION = {
  id: "loc-nonna-rosa",
  agent_secret_hash: SECRET_HASH,
  timezone: "America/Los_Angeles",
  seats: 4,
  max_party_size: 8,
  reservation_slot_minutes: 90,
  order_types: "both",
  tax_rate_bps: 0,
  pickup_promise_minutes: 20,
  delivery_promise_minutes: 45,
  fallback_human_number: "+15105550111",
};

const CATEGORIES = [
  { id: "c1", name: "Pasta", sort_order: 1 },
  { id: "c2", name: "Secondi", sort_order: 2 },
  { id: "c3", name: "Dolci", sort_order: 3 },
];

const ITEMS = [
  { id: "m2", category_id: "c1", name: "Lasagne Verdi", price_cents: 2400, sold_out_until: null, description: null, pick_label: null, sort_order: 1 },
  { id: "m1", category_id: "c2", name: "Meatballs al Forno", price_cents: 1600, sold_out_until: null, description: null, pick_label: null, sort_order: 1 },
  { id: "m3", category_id: "c3", name: "Olive Oil Cake", price_cents: 900, sold_out_until: null, description: null, pick_label: null, sort_order: 1 },
];

const TABLES: Record<string, unknown[]> = {
  menu_categories: CATEGORIES,
  menu_items: ITEMS,
  hours: [],
  holiday_hours: [],
  bookings: [],
  orders: [],
  messages: [],
};

// ---------------------------------------------------------------------
// What the routes actually did. Every query, every RPC and every write
// is recorded, because "the route received these arguments" is only
// honestly answerable by what reached the database.
// ---------------------------------------------------------------------

type Observed = {
  queries: { table: string; calls: unknown[][] }[];
  rpc: { fn: string; args: Record<string, unknown> }[];
  ticket: unknown;
  transfer: unknown;
};

let observed: Observed;

function reset() {
  observed = { queries: [], rpc: [], ticket: null, transfer: null };
}

reset();

/** A recording stand-in for a PostgREST query builder. Every filter is
 *  kept, so a value derived from a tool call's arguments -- the booking
 *  window `check_availability` computes from `requested_at`, the row
 *  `take_message` inserts -- is visible in the observation. */
function queryFor(table: string) {
  const calls: unknown[][] = [];
  observed.queries.push({ table, calls });

  const result = { data: TABLES[table] ?? [], error: null };
  const chain: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
    maybeSingle: async () => ({ data: (TABLES[table] ?? [])[0] ?? null, error: null }),
  };
  for (const method of ["select", "eq", "not", "in", "gte", "lte", "order", "update", "insert"]) {
    chain[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return chain;
    };
  }
  return chain;
}

/** Re-priced from the menu, exactly as `public.place_order` does -- so
 *  the dollar total this test asserts is the one the caller confirmed,
 *  not a number written into a fixture. */
function orderTotalCents(itemIds: string[], quantities: number[]) {
  return itemIds.reduce((sum, id, i) => {
    const item = ITEMS.find((m) => m.id === id);
    return sum + (item ? item.price_cents * quantities[i] : 0);
  }, 0);
}

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
      return queryFor(table);
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      observed.rpc.push({ fn, args });
      const data =
        fn === "book_table"
          ? { booked: true, duplicate: false, booking_id: "bk-1", reason: null }
          : fn === "cancel_booking"
            ? {
                cancelled: true,
                already_cancelled: false,
                booking_id: "bk-1",
                booking_at: "2026-08-21T02:00:00Z",
                reason: null,
              }
            : fn === "change_booking"
              ? {
                  changed: true,
                  already_changed: false,
                  booking_id: "bk-1",
                  booking_at: "2026-08-22T03:00:00Z",
                  booking_party_size: 4,
                  reason: null,
                }
              : {
                  placed: true,
                  duplicate: false,
                  order_id: "ord-1",
                  order_number: 1042,
                  subtotal_cents: orderTotalCents(
                    args.p_item_ids as string[],
                    args.p_quantities as number[],
                  ),
                  tax_cents: 0,
                  total_cents: orderTotalCents(
                    args.p_item_ids as string[],
                    args.p_quantities as number[],
                  ),
                  reason: null,
                  item: null,
                };
      return { single: async () => ({ data, error: null }) };
    },
  }),
}));

vi.mock("@/lib/agent/context", () => ({
  callIdForProvider: async () => "call-row-1",
}));

vi.mock("@/lib/agent/notify", () => ({
  // The kitchen ticket: the one artefact that carries every argument
  // place_order was given, all the way to a human.
  orderMessage: (input: unknown) => {
    observed.ticket = input;
    return "ticket";
  },
  sendOrderSms: async () => true,
}));

vi.mock("@/lib/agent/transfer", () => ({
  logTransferOutcome: async (locationId: string, providerCallId: string | null, reason?: string) => {
    observed.transfer = { locationId, providerCallId, reason };
  },
}));

// Run the scheduled work inline so `transfer_to_human`'s `reason`
// argument is observable at all.
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void fn() }));

const { AGENT_TOOLS } = await import("@/lib/vapi/provision");

const ROUTES: Record<string, (request: Request) => Promise<Response>> = {
  menu: (await import("@/app/api/agent/menu/route")).POST,
  hours: (await import("@/app/api/agent/hours/route")).POST,
  availability: (await import("@/app/api/agent/availability/route")).POST,
  reservation: (await import("@/app/api/agent/reservation/route")).POST,
  "cancel-reservation": (await import("@/app/api/agent/cancel-reservation/route")).POST,
  "change-reservation": (await import("@/app/api/agent/change-reservation/route")).POST,
  order: (await import("@/app/api/agent/order/route")).POST,
  transfer: (await import("@/app/api/agent/transfer/route")).POST,
  message: (await import("@/app/api/agent/message/route")).POST,
};

// ---------------------------------------------------------------------
// One argument set per tool, using the names AGENT_TOOLS actually
// declares -- asserted below, so an invented name cannot quietly make
// this file prove nothing.
// ---------------------------------------------------------------------

const FUTURE = "2026-08-20T19:00:00-07:00";
const LATER = "2026-08-21T20:00:00-07:00";
const PHONE = "4093337727";

const ARGUMENTS: Record<string, Record<string, unknown>> = {
  get_menu: { item: "meatballs" },
  get_hours: {},
  check_availability: { requested_at: FUTURE, party_size: 6 },
  create_reservation: {
    requested_at: FUTURE,
    party_size: 2,
    customer_name: "Mike",
    customer_phone: PHONE,
    provider_call_id: PROVIDER_CALL_ID,
  },
  cancel_reservation: {
    customer_name: "Mike",
    customer_phone: PHONE,
    booking_time: FUTURE,
  },
  change_reservation: {
    customer_name: "Sai",
    customer_phone: PHONE,
    booking_time: FUTURE,
    new_requested_at: LATER,
    new_party_size: 4,
  },
  place_order: {
    items: [
      { name: "Meatballs al Forno", quantity: 1, note: "no onions" },
      { name: "Lasagne Verdi", quantity: 1 },
    ],
    type: "delivery",
    customer_name: "Mike",
    customer_phone: PHONE,
    address: "1 Telegraph Ave, Oakland",
    provider_call_id: PROVIDER_CALL_ID,
  },
  transfer_to_human: { reason: "allergy question", provider_call_id: PROVIDER_CALL_ID },
  take_message: {
    caller_name: "Ann",
    callback_number: "+15105550100",
    message: "please call me back about last night's order",
    provider_call_id: PROVIDER_CALL_ID,
  },
};

/** Every name a tool declares: the JSON Schema properties the model
 *  fills in, plus the staticParameters Vapi merges into the same
 *  arguments object. */
function declaredNames(tool: (typeof AGENT_TOOLS)[number]) {
  return [
    ...Object.keys(tool.properties),
    ...(tool.staticParameters ?? []).map((p) => p.key),
  ].sort();
}

/** The tools whose calls carry arguments at all. `get_hours` is the one
 *  that does not, and it is exactly why the outage went unseen: an
 *  argument-less tool cannot tell a successful parse from a dropped one. */
const ARGUMENT_CARRYING = AGENT_TOOLS.filter((t) => declaredNames(t).length > 0);

// ---------------------------------------------------------------------

beforeAll(() => {
  // The day of the two lost orders. Frozen so every combination in a
  // matrix is compared against the others at one instant -- `get_hours`,
  // the past-time gates and the promised ready time all read the clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-18T20:00:00Z"));
});

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  reset();
});

// ---------------------------------------------------------------------

describe("the fixtures are the tools' own declared arguments", () => {
  it("covers all nine tools and no others", () => {
    expect(Object.keys(ARGUMENTS).sort()).toEqual(AGENT_TOOLS.map((t) => t.name).sort());
    expect(AGENT_TOOLS).toHaveLength(9);
    expect(COMBINATIONS).toHaveLength(12);
  });

  it.each(AGENT_TOOLS.map((t) => [t.name, t] as const))(
    "%s carries every name it declares, and no invented one",
    (name, tool) => {
      expect(Object.keys(ARGUMENTS[name]).sort()).toEqual(declaredNames(tool));
    },
  );

  it("place_order's line items carry the names the nested schema declares", () => {
    const tool = AGENT_TOOLS.find((t) => t.name === "place_order")!;
    // `properties.items` is the ARRAY schema; the per-line object schema
    // is one level further in, under its own `items`.
    const array = tool.properties.items as { items: { properties: Record<string, unknown> } };
    const line = (ARGUMENTS.place_order.items as Record<string, unknown>[])[0];
    expect(Object.keys(line).sort()).toEqual(Object.keys(array.items.properties).sort());
  });

  it("get_hours is the only argument-less tool -- the reason this went unseen", () => {
    expect(AGENT_TOOLS.filter((t) => declaredNames(t).length === 0).map((t) => t.name)).toEqual([
      "get_hours",
    ]);
    expect(ARGUMENT_CARRYING).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------

describe("parseToolCall reads an entry by its own shape, not by its container", () => {
  it.each(AGENT_TOOLS.map((t) => [t.name] as const))(
    "%s parses identically in all twelve container/entry combinations",
    (name) => {
      for (const combination of COMBINATIONS) {
        expect(
          parseToolCall(envelope(combination, name, ARGUMENTS[name])),
          combination.label,
        ).toEqual({
          toolCallId: TOOL_CALL_ID,
          name,
          args: ARGUMENTS[name],
          providerCallId: PROVIDER_CALL_ID,
        });
      }
    },
  );

  it("reads the exact payload Vapi logged for Mike's lost order", () => {
    // Verbatim from the call log: the documented CONTAINER carrying
    // OPENAI-SHAPED entries. Neither branch of the old parser was
    // written for this, and the first one won.
    const body = {
      message: {
        type: "tool-calls",
        toolCallList: [
          {
            id: TOOL_CALL_ID,
            type: "function",
            function: {
              name: "place_order",
              arguments:
                '{"type":"pickup","items":[{"name":"Meatballs al Forno","quantity":1},' +
                '{"name":"Lasagne Verdi","quantity":1}],' +
                '"customer_name":"Mike","customer_phone":"4093337727"}',
            },
          },
        ],
        call: { id: PROVIDER_CALL_ID },
      },
    };

    expect(parseToolCall(body)).toEqual({
      toolCallId: TOOL_CALL_ID,
      name: "place_order",
      args: {
        type: "pickup",
        items: [
          { name: "Meatballs al Forno", quantity: 1 },
          { name: "Lasagne Verdi", quantity: 1 },
        ],
        customer_name: "Mike",
        customer_phone: "4093337727",
      },
      providerCallId: PROVIDER_CALL_ID,
    });
  });

  it("falls through to the next container when the first holds nothing readable", () => {
    // A container is no longer allowed to swallow the call: an entry
    // with neither an id nor a name is not something Vapi can be
    // answered on, so the real call one key over is still found.
    const body = {
      message: {
        type: "tool-calls",
        toolCallList: [{ nothing: "identifiable" }],
        toolCalls: [
          { id: TOOL_CALL_ID, type: "function", function: { name: "get_menu", arguments: '{"item":"wings"}' } },
        ],
        call: { id: PROVIDER_CALL_ID },
      },
    };
    expect(parseToolCall(body)).toEqual({
      toolCallId: TOOL_CALL_ID,
      name: "get_menu",
      args: { item: "wings" },
      providerCallId: PROVIDER_CALL_ID,
    });
  });

  it("reads a half-and-half entry rather than dropping the call", () => {
    // The name inside `function`, the arguments left outside it. Exactly
    // the kind of hybrid this module was caught out by once already, and
    // the alternative to reading it is a caller's order on the floor.
    const body = {
      message: {
        type: "tool-calls",
        toolCallList: [
          { id: TOOL_CALL_ID, function: { name: "get_menu" }, arguments: { item: "wings" } },
        ],
        call: { id: PROVIDER_CALL_ID },
      },
    };
    expect(parseToolCall(body)).toEqual({
      toolCallId: TOOL_CALL_ID,
      name: "get_menu",
      args: { item: "wings" },
      providerCallId: PROVIDER_CALL_ID,
    });
  });

  it("still answers an envelope whose entries are not objects at all with the call id alone", () => {
    const body = {
      message: { type: "tool-calls", toolCallList: ["nope"], call: { id: PROVIDER_CALL_ID } },
    };
    expect(parseToolCall(body)).toEqual({
      toolCallId: null,
      name: null,
      args: {},
      providerCallId: PROVIDER_CALL_ID,
    });
  });
});

// ---------------------------------------------------------------------

/** One request, and everything the route did with it. */
async function call(path: string, body: unknown) {
  reset();
  const res = await ROUTES[path](
    new Request(`https://x.test/api/agent/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dialtone-secret": SECRET },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  return {
    response: JSON.parse(await res.text()),
    effects: JSON.parse(JSON.stringify(observed)),
  };
}

describe("every tool that carries arguments delivers them to its route, whatever the shape", () => {
  it.each(ARGUMENT_CARRYING.map((t) => [t.name, t.path] as const))(
    "%s reaches app/api/agent/%s identically in all twelve combinations",
    async (name, path) => {
      const args = ARGUMENTS[name];

      // The reference: the one combination that always worked -- the
      // documented container with the documented entry shape.
      const reference = await call(path, envelope(COMBINATIONS[0], name, args));

      for (const combination of COMBINATIONS) {
        const actual = await call(path, envelope(combination, name, args));
        expect(actual, combination.label).toEqual(reference);
      }

      // ...and the arguments were load-bearing. Without this the
      // assertion above is satisfied by twelve routes that all read
      // nothing, which is precisely what production was doing.
      const withoutArguments = await call(path, envelope(COMBINATIONS[0], name, {}));
      expect(reference).not.toEqual(withoutArguments);
    },
  );

  it("get_hours still answers the same call id in all twelve combinations", async () => {
    // The tool that hid the bug. It has no arguments to lose, but the
    // toolCallId it must be answered with is lost by the same mismatch.
    const reference = await call("hours", envelope(COMBINATIONS[0], "get_hours", {}));
    expect(reference.response.results[0].toolCallId).toBe(TOOL_CALL_ID);

    for (const combination of COMBINATIONS) {
      const actual = await call("hours", envelope(combination, "get_hours", {}));
      expect(actual, combination.label).toEqual(reference);
    }
  });
});

// ---------------------------------------------------------------------

describe("the two orders that were lost", () => {
  /** The exact container/entry mismatch from the call log, per caller. */
  const logged = (items: { name: string; quantity: number }[], customer: string) => ({
    message: {
      type: "tool-calls",
      toolCallList: [
        {
          id: TOOL_CALL_ID,
          type: "function",
          function: {
            name: "place_order",
            arguments: JSON.stringify({
              type: "pickup",
              items,
              customer_name: customer,
              customer_phone: PHONE,
            }),
          },
        },
      ],
      call: { id: PROVIDER_CALL_ID },
    },
  });

  it.each([
    [
      "Mike",
      [
        { name: "Meatballs al Forno", quantity: 1 },
        { name: "Lasagne Verdi", quantity: 1 },
      ],
      "$40.00",
      ["m1", "m2"],
    ],
    [
      "Sai",
      [
        { name: "Meatballs al Forno", quantity: 1 },
        { name: "Olive Oil Cake", quantity: 1 },
      ],
      "$25.00",
      ["m1", "m3"],
    ],
  ] as const)("%s's order is placed, for the total he confirmed", async (customer, items, total, ids) => {
    const { response, effects } = await call("order", logged([...items], customer));

    const result = response.results[0];
    expect(result.toolCallId).toBe(TOOL_CALL_ID);
    // "I don't have any items yet." was an `error`, and it is what both
    // callers heard.
    expect(result.error).toBeUndefined();

    const placed = JSON.parse(result.result);
    expect(placed.placed).toBe(true);
    expect(placed.total).toBe(total);

    // The write actually happened, with this caller's items on it.
    const write = effects.rpc.find((r: { fn: string }) => r.fn === "place_order");
    expect(write).toBeDefined();
    expect(write.args.p_item_ids).toEqual([...ids]);
    expect(write.args.p_quantities).toEqual([1, 1]);
    expect(write.args.p_customer_name).toBe(customer);
    expect(write.args.p_customer_phone).toBe(PHONE);
    expect(write.args.p_type).toBe("pickup");
  });
});
