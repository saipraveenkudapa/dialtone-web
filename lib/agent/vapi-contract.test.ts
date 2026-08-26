import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseToolCall } from "./vapi";

/** The regression test for Vapi call 01a000a0-430a-766c-ad61-b9ac47a0552b.
 *
 *  It lives under lib/ deliberately: vitest.config.ts sets
 *  `include: ["lib/**\/*.test.ts"]`, so the same file placed under app/
 *  would never run -- which is its own way of never catching this again.
 *  Same convention as lib/agent/{order,message,transfer}-route.test.ts:
 *  import a route's POST directly and call it with a real Request. */

// ---------------------------------------------------------------------
// The two frozen payloads. Verbatim, and not to be edited to make a test
// pass -- the first is the shape published at docs.vapi.ai (retargeted
// from get_weather to get_menu), the second is copied out of Vapi's own
// message log for the Nonna Rosa call above, where `arguments` is the
// JSON *string* "{}" and the tool result came back "No result returned".
// ---------------------------------------------------------------------

const PROVIDER_CALL_ID = "01a000a0-430a-766c-ad61-b9ac47a0552b";

const DOCUMENTED_PAYLOAD = {
  message: {
    timestamp: 1678901234567,
    type: "tool-calls",
    toolCallList: [
      { id: "toolu_01DTxxxxxxxxxxxxxxxxxxxx", name: "get_menu", arguments: { item: "wings" } },
    ],
    toolWithToolCallList: [],
    call: { id: PROVIDER_CALL_ID, orgId: "org-uuid", type: "webCall" },
    assistant: {},
  },
};

const LIVE_PAYLOAD = {
  message: {
    type: "tool-calls",
    toolCalls: [
      {
        id: "call_9w3zzVmqKj04ah0kW95p5BjI",
        type: "function",
        function: { name: "get_menu", arguments: "{}" },
      },
    ],
    call: { id: PROVIDER_CALL_ID },
  },
};

// ---------------------------------------------------------------------
// Nonna Rosa's real shape: 4 categories, 14 items.
// ---------------------------------------------------------------------

const SECRET = "swordfish";
const SECRET_HASH = crypto.createHash("sha256").update(SECRET, "utf-8").digest("hex");
const LOCATION = { id: "loc-nonna-rosa", agent_secret_hash: SECRET_HASH, timezone: "America/Los_Angeles" };

const CATEGORIES = [
  { id: "c1", name: "Antipasti", sort_order: 1 },
  { id: "c2", name: "Pasta", sort_order: 2 },
  { id: "c3", name: "Secondi", sort_order: 3 },
  { id: "c4", name: "Dolci", sort_order: 4 },
];

/** 14 items. Two of them answer to the spoken word "wings", which is what
 *  makes the `alternative` assertion below prove the argument was read
 *  rather than ignored; one carries a description with a real newline in
 *  it, which is what makes the single-line assertion bite. */
const ITEMS = [
  { id: "i1", category_id: "c1", name: "Bruschetta", price_cents: 900, sold_out_until: null, description: null },
  { id: "i2", category_id: "c1", name: "Arancini", price_cents: 1100, sold_out_until: null, description: null },
  { id: "i3", category_id: "c1", name: "Buffalo Wings", price_cents: 1400, sold_out_until: null, description: null },
  { id: "i4", category_id: "c1", name: "Boneless Wings", price_cents: 1300, sold_out_until: null, description: null },
  { id: "i5", category_id: "c2", name: "Cacio e Pepe", price_cents: 2100, sold_out_until: null, description: "Black pepper,\npecorino" },
  { id: "i6", category_id: "c2", name: "Carbonara", price_cents: 2200, sold_out_until: null, description: null },
  { id: "i7", category_id: "c2", name: "Lasagne", price_cents: 2400, sold_out_until: null, description: null },
  { id: "i8", category_id: "c2", name: "Squid Ink Pasta", price_cents: 2600, sold_out_until: "2099-01-01T00:00:00Z", description: null },
  { id: "i9", category_id: "c3", name: "Pollo Milanese", price_cents: 2800, sold_out_until: null, description: null },
  { id: "i10", category_id: "c3", name: "Branzino", price_cents: 3200, sold_out_until: null, description: null },
  { id: "i11", category_id: "c3", name: "Bistecca", price_cents: 4200, sold_out_until: null, description: null },
  { id: "i12", category_id: "c4", name: "Tiramisu", price_cents: 1000, sold_out_until: null, description: null },
  { id: "i13", category_id: "c4", name: "Panna Cotta", price_cents: 950, sold_out_until: null, description: null },
  { id: "i14", category_id: "c4", name: "Cannoli", price_cents: 900, sold_out_until: null, description: null },
];

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
      const rows =
        table === "menu_categories" ? CATEGORIES : table === "menu_items" ? ITEMS : [];
      const resolved = Promise.resolve({ data: rows, error: null });
      return {
        select: () => ({
          eq: () => Object.assign(resolved, { order: () => resolved }),
        }),
      };
    },
  }),
}));

// The transfer route schedules its logging through `after()`.
vi.mock("next/server", () => ({ after: () => {} }));

const { AGENT_TOOLS } = await import("@/lib/vapi/provision");

/** Every tool route, imported statically -- a template-literal dynamic
 *  import cannot be analysed by the bundler, and a route that silently
 *  failed to resolve would make this table pass by not running. */
const ROUTES: [string, (r: Request) => Promise<Response>][] = [
  ["menu", (await import("@/app/api/agent/menu/route")).POST],
  ["hours", (await import("@/app/api/agent/hours/route")).POST],
  ["availability", (await import("@/app/api/agent/availability/route")).POST],
  ["reservation", (await import("@/app/api/agent/reservation/route")).POST],
  ["cancel-reservation", (await import("@/app/api/agent/cancel-reservation/route")).POST],
  ["change-reservation", (await import("@/app/api/agent/change-reservation/route")).POST],
  ["order", (await import("@/app/api/agent/order/route")).POST],
  ["transfer", (await import("@/app/api/agent/transfer/route")).POST],
  ["message", (await import("@/app/api/agent/message/route")).POST],
];

const menuPOST = ROUTES[0][1];

function post(body: unknown, secret = SECRET) {
  return new Request("https://x.test/api/agent/menu", {
    method: "POST",
    headers: { "content-type": "application/json", "x-dialtone-secret": secret },
    body: JSON.stringify(body),
  });
}

const SEPARATORS = /[\r\n\u2028\u2029]/;

// ---------------------------------------------------------------------

describe("parseToolCall reads both shapes Vapi really sends", () => {
  it("reads the documented toolCallList shape", () => {
    expect(parseToolCall(DOCUMENTED_PAYLOAD)).toEqual({
      toolCallId: "toolu_01DTxxxxxxxxxxxxxxxxxxxx",
      name: "get_menu",
      args: { item: "wings" },
      providerCallId: PROVIDER_CALL_ID,
    });
  });

  it("reads the OpenAI-shaped variant the live call actually sent", () => {
    expect(parseToolCall(LIVE_PAYLOAD)).toEqual({
      toolCallId: "call_9w3zzVmqKj04ah0kW95p5BjI",
      name: "get_menu",
      args: {},
      providerCallId: PROVIDER_CALL_ID,
    });
  });

  it("parses an arguments STRING into an object", () => {
    const body = {
      message: {
        type: "tool-calls",
        toolCalls: [
          { id: "t", type: "function", function: { name: "get_menu", arguments: '{"item":"wings"}' } },
        ],
      },
    };
    expect(parseToolCall(body).args).toEqual({ item: "wings" });
  });

  it("still reports a toolCallId when the arguments are malformed", () => {
    // The assertion that guarantees a malformed-arguments call still
    // hears a sentence instead of silence.
    for (const bad of ["not json", "", "[1,2]", "4", "null"]) {
      const body = {
        message: {
          type: "tool-calls",
          toolCalls: [{ id: "t_bad", type: "function", function: { name: "get_menu", arguments: bad } }],
        },
      };
      const call = parseToolCall(body);
      expect(call.args).toEqual({});
      expect(call.toolCallId).toBe("t_bad");
    }
  });

  it("reads the toolWithToolCallList shape as a last resort", () => {
    const body = {
      message: {
        type: "tool-calls",
        toolWithToolCallList: [
          {
            toolCall: {
              id: "twt_1",
              type: "function",
              function: { name: "get_menu", arguments: '{"item":"wings"}' },
            },
          },
        ],
        call: { id: PROVIDER_CALL_ID },
      },
    };
    expect(parseToolCall(body)).toEqual({
      toolCallId: "twt_1",
      name: "get_menu",
      args: { item: "wings" },
      providerCallId: PROVIDER_CALL_ID,
    });
  });

  it("treats a flat legacy body as the arguments themselves", () => {
    expect(parseToolCall({ item: "wings", provider_call_id: "vapi-1" })).toEqual({
      toolCallId: null,
      name: null,
      args: { item: "wings", provider_call_id: "vapi-1" },
      providerCallId: "vapi-1",
    });
  });

  it("does NOT mistake a flat take_message body for an envelope", () => {
    // The trap: take_message's own declared argument is named `message`.
    // Read this as an envelope and the caller's words are silently lost.
    const flat = {
      caller_name: "Ann",
      callback_number: "+15105550100",
      message: "please call me back",
    };
    const call = parseToolCall(flat);
    expect(call.args.message).toBe("please call me back");
    expect(call.args).toEqual(flat);
    expect(call.toolCallId).toBeNull();
  });

  it("answers nothing-shaped bodies with an all-null tool call", () => {
    for (const body of [null, undefined, [], "a string", 4]) {
      expect(parseToolCall(body)).toEqual({
        toolCallId: null,
        name: null,
        args: {},
        providerCallId: null,
      });
    }
    expect(parseToolCall({})).toEqual({
      toolCallId: null,
      name: null,
      args: {},
      providerCallId: null,
    });
  });

  it("recovers the call id from an envelope with no tool call, without reading its keys as arguments", () => {
    const body = { message: { type: "status-update", status: "in-progress", call: { id: PROVIDER_CALL_ID } } };
    expect(parseToolCall(body)).toEqual({
      toolCallId: null,
      name: null,
      // NOT {type, status, call} -- an envelope's own keys are never a
      // caller's words.
      args: {},
      providerCallId: PROVIDER_CALL_ID,
    });
  });
});

// ---------------------------------------------------------------------

describe("POST /api/agent/menu answers what Vapi can actually read", () => {
  it.each([
    ["the documented payload", DOCUMENTED_PAYLOAD, "toolu_01DTxxxxxxxxxxxxxxxxxxxx", true],
    ["the live Nonna Rosa payload", LIVE_PAYLOAD, "call_9w3zzVmqKj04ah0kW95p5BjI", false],
  ] as const)("reproduces the outage and fixes it: %s", async (_label, payload, id, expectAlternative) => {
    const res = await menuPOST(post(payload));

    expect(res.status).toBe(200);

    const raw = await res.text();
    // No raw line terminator anywhere on the wire, including the one
    // inside Cacio e Pepe's description.
    expect(raw).not.toMatch(SEPARATORS);

    const body = JSON.parse(raw);
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].toolCallId).toBe(id);
    expect("error" in body.results[0]).toBe(false);
    // The failing production response sent an OBJECT. This one assertion
    // is the whole bug.
    expect(typeof body.results[0].result).toBe("string");

    const menu = JSON.parse(body.results[0].result);
    expect(menu.categories).toHaveLength(4);
    expect(menu.categories.reduce((n: number, c: { items: unknown[] }) => n + c.items.length, 0)).toBe(14);
    // The description survived the escaping byte for byte.
    expect(menu.categories[1].items[0].ingredients).toBe("Black pepper,\npecorino");

    // Proof the argument was READ, not merely that a menu came back: the
    // documented payload carries item "wings", the live one carries none.
    expect(menu.alternative !== null).toBe(expectAlternative);
  });
});

// ---------------------------------------------------------------------

describe("every route answers the envelope, not silence", () => {
  it("covers every tool route there is", () => {
    // The assertion that fails the day somebody adds a tenth route and
    // forgets the envelope.
    expect(ROUTES.map(([r]) => r).sort()).toEqual(AGENT_TOOLS.map((t) => t.path).sort());
  });

  it.each(ROUTES)("POST /api/agent/%s", async (route, POST) => {
    const tool = AGENT_TOOLS.find((t) => t.path === route);
    expect(tool, `no AGENT_TOOLS entry for ${route}`).toBeDefined();

    const body = {
      message: {
        type: "tool-calls",
        toolCalls: [
          {
            id: "call_9w3zzVmqKj04ah0kW95p5BjI",
            type: "function",
            function: { name: tool!.name, arguments: "{}" },
          },
        ],
        call: { id: PROVIDER_CALL_ID },
      },
    };

    // A deliberately wrong secret: this is the branch that used to 401,
    // which Vapi ignores completely -- the silence a live caller heard.
    const res = await POST(
      new Request(`https://x.test/api/agent/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-dialtone-secret": "wrong" },
        body: JSON.stringify(body),
      }),
    );

    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toMatch(SEPARATORS);
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].toolCallId).toBe("call_9w3zzVmqKj04ah0kW95p5BjI");
    expect(typeof parsed.results[0].error).toBe("string");
    expect(parsed.results[0].error.length).toBeGreaterThan(0);
  });

  it("still 401s a request that is not a recognisable tool call", async () => {
    // The other half of the decision: a probe with no tool call in it
    // keeps the perimeter signal.
    const res = await menuPOST(post({ item: "wings" }, "wrong"));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------

describe("AGENT_TOOLS and the routes cannot drift apart", () => {
  it.each(AGENT_TOOLS.map((t) => [t.name, t.path, t.required] as const))(
    "%s -> app/api/agent/%s/route.ts",
    (_name, toolPath, required) => {
      const file = path.join(process.cwd(), "app/api/agent", toolPath, "route.ts");
      expect(existsSync(file), `${file} does not exist`).toBe(true);

      // The route's own source plus the lib/agent modules it imports:
      // take_message reads `callback_number` inside buildMessage rather
      // than naming it in the route, and that is fine -- what must never
      // happen is an argument declared to the model that nothing on the
      // server ever looks at. This is the check that would have caught
      // provider_call_id being declared through a mechanism no route
      // could receive it through.
      let source = readFileSync(file, "utf-8");
      for (const mod of source.matchAll(/from "@\/lib\/agent\/([\w-]+)"/g)) {
        const dep = path.join(process.cwd(), "lib/agent", `${mod[1]}.ts`);
        if (existsSync(dep)) source += readFileSync(dep, "utf-8");
      }

      for (const field of required) {
        expect(source, `${toolPath} never reads required argument ${field}`).toContain(field);
      }
    },
  );
});
