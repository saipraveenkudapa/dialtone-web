import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

/** Exercises `app/api/agent/cancel-reservation/route.ts` and
 *  `app/api/agent/change-reservation/route.ts` directly -- calling their
 *  exported `POST` with a real `Request` -- for the one thing neither
 *  `caller.test.ts` nor the SQL functions can show: what a live caller
 *  hears when the model puts a spoken field on the wire as something
 *  other than a string.
 *
 *  Both routes cast `call.args` to a type that CLAIMS `customer_name` and
 *  `customer_phone` are strings. The values behind that claim came out of
 *  a `JSON.parse` of a model-authored `arguments` string, so it is a
 *  claim about the type and not a guarantee about the bytes -- and the
 *  cast is precisely what kept tsc quiet about it. A payload carrying
 *  `"customer_phone": 5105550100` used to reach
 *  `(phone ?? "").replace(...)` and throw `TypeError: replace is not a
 *  function`, which escapes the handler as a framework 500. Vapi ignores
 *  a non-200 completely, so a caller ringing to cancel or move a table
 *  heard nothing at all -- the identical failure mode as call
 *  01a000a0-430a-766c-ad61-b9ac47a0552b, reached by a different door.
 *
 *  This is not a hypothetical model quirk. `lib/agent/messages.ts` says
 *  outright that a callback number is "the one field a tool payload
 *  plausibly carries as a JSON number rather than a string", and
 *  `spokenPhone` coerces it there for exactly that reason -- so
 *  `take_message` already survived this input while the two routes that
 *  inherited the same question did not. */

const SECRET = "swordfish";
const SECRET_HASH = crypto.createHash("sha256").update(SECRET, "utf-8").digest("hex");

const LOCATION = {
  id: "loc-nonna-rosa",
  agent_secret_hash: SECRET_HASH,
  timezone: "America/Los_Angeles",
  max_party_size: 12,
};

/** Open all day, every day, so the change route's hours gate is never the
 *  thing under test here. */
const HOURS = [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
  day_of_week,
  open_time: "00:00",
  close_time: "23:59",
  is_closed: false,
}));

/** Whatever the route last handed the RPC, so the test can assert that
 *  what passed the gate is also what reached SQL. */
let rpcArgs: Record<string, unknown> | null;
let rpcName: string | null;

const cancelResult = {
  cancelled: true,
  already_cancelled: false,
  booking_id: "booking-1",
  booking_at: "2099-06-05T19:00:00Z",
  reason: null,
};

const changeResult = {
  changed: true,
  already_changed: false,
  booking_id: "booking-1",
  booking_at: "2099-06-05T20:00:00Z",
  booking_party_size: 2,
  reason: null,
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
      const rows = table === "hours" ? HOURS : [];
      return { select: () => ({ eq: async () => ({ data: rows, error: null }) }) };
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcName = fn;
      rpcArgs = args;
      return {
        single: async () => ({
          data: fn === "cancel_booking" ? cancelResult : changeResult,
          error: null,
        }),
      };
    },
  }),
}));

const cancelPOST = (await import("@/app/api/agent/cancel-reservation/route")).POST;
const changePOST = (await import("@/app/api/agent/change-reservation/route")).POST;

/** A future instant inside the open hours above. */
const WHEN = "2099-06-05T19:00:00Z";
const NEW_WHEN = "2099-06-05T20:00:00Z";

/** Vapi's live OpenAI-shaped envelope, which is what actually carries a
 *  model's arguments -- `arguments` is a JSON *string*, so a number in it
 *  arrives as a number no matter what the route's type says. */
function envelope(name: string, args: Record<string, unknown>) {
  return {
    message: {
      type: "tool-calls",
      toolCalls: [
        {
          id: "call_9w3zzVmqKj04ah0kW95p5BjI",
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
      call: { id: "01a000a0-430a-766c-ad61-b9ac47a0552b" },
    },
  };
}

function request(route: string, name: string, args: Record<string, unknown>) {
  return new Request(`https://example.test/api/agent/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dialtone-secret": SECRET },
    body: JSON.stringify(envelope(name, args)),
  });
}

/** The whole envelope, asserted on the way past: always 200, always a
 *  `results` ARRAY of exactly one entry. A route that threw would never
 *  get this far -- which is the point. */
async function toolResult(res: Response) {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.results)).toBe(true);
  expect(body.results).toHaveLength(1);
  const entry = body.results[0] as {
    toolCallId: string | null;
    result?: string;
    error?: string;
  };
  expect(entry.toolCallId).toBe("call_9w3zzVmqKj04ah0kW95p5BjI");
  return entry;
}

beforeEach(() => {
  rpcArgs = null;
  rpcName = null;
});

describe("cancel_reservation survives a spoken field that is not a string", () => {
  it("answers a numeric customer_phone with a spoken result, not a framework 500", async () => {
    const res = await cancelPOST(
      request("cancel-reservation", "cancel_reservation", {
        booking_time: WHEN,
        customer_name: "Ann",
        // The exact shape lib/agent/messages.ts warns about.
        customer_phone: 5105550100,
      }),
    );

    const entry = await toolResult(res);
    expect(typeof entry.result).toBe("string");
    expect(JSON.parse(entry.result as string).cancelled).toBe(true);
  });

  it("sends SQL the coerced string, never the raw number the gate approved", async () => {
    await cancelPOST(
      request("cancel-reservation", "cancel_reservation", {
        booking_time: WHEN,
        customer_name: "Ann",
        customer_phone: 5105550100,
      }),
    );

    // What passed `hasUsableCallerPhone` has to be what reaches
    // `app.caller_phone_key`. A gate that approves "5105550100" and then
    // hands Postgres the JSON number 5105550100 has approved something
    // it did not send.
    expect(rpcName).toBe("cancel_booking");
    expect(rpcArgs?.p_customer_phone).toBe("5105550100");
    expect(rpcArgs?.p_customer_name).toBe("Ann");
  });

  it("asks again, in a sentence, for a name transcribed as a bare number", async () => {
    const res = await cancelPOST(
      request("cancel-reservation", "cancel_reservation", {
        booking_time: WHEN,
        customer_name: 22,
        customer_phone: "+15105550100",
      }),
    );

    const entry = await toolResult(res);
    expect(entry.error).toBe("I still need the name and number the booking's under.");
    // Nothing was asked of the book on the way to asking a question.
    expect(rpcArgs).toBeNull();
  });

  it.each([
    ["an object", { area: "510" }],
    ["an array", ["510", "555", "0100"]],
    ["a boolean", true],
    ["null", null],
  ])("asks again for a customer_phone that arrived as %s", async (_label, phone) => {
    const res = await cancelPOST(
      request("cancel-reservation", "cancel_reservation", {
        booking_time: WHEN,
        customer_name: "Ann",
        customer_phone: phone,
      }),
    );

    const entry = await toolResult(res);
    expect(entry.error).toBe("I still need the name and number the booking's under.");
    expect(rpcArgs).toBeNull();
  });
});

describe("change_reservation survives the same field in the same shape", () => {
  it("answers a numeric customer_phone with a spoken result, not a framework 500", async () => {
    const res = await changePOST(
      request("change-reservation", "change_reservation", {
        booking_time: WHEN,
        new_requested_at: NEW_WHEN,
        customer_name: "Ann",
        customer_phone: 5105550100,
      }),
    );

    const entry = await toolResult(res);
    expect(typeof entry.result).toBe("string");
    expect(JSON.parse(entry.result as string).changed).toBe(true);
  });

  it("sends SQL the coerced string, never the raw number the gate approved", async () => {
    await changePOST(
      request("change-reservation", "change_reservation", {
        booking_time: WHEN,
        new_requested_at: NEW_WHEN,
        customer_name: "Ann",
        customer_phone: 5105550100,
      }),
    );

    expect(rpcName).toBe("change_booking");
    expect(rpcArgs?.p_customer_phone).toBe("5105550100");
    expect(rpcArgs?.p_customer_name).toBe("Ann");
  });

  it("asks again, in a sentence, for a name transcribed as a bare number", async () => {
    const res = await changePOST(
      request("change-reservation", "change_reservation", {
        booking_time: WHEN,
        new_requested_at: NEW_WHEN,
        customer_name: 22,
        customer_phone: "+15105550100",
      }),
    );

    const entry = await toolResult(res);
    expect(entry.error).toBe("I still need the name and number the booking's under.");
    expect(rpcArgs).toBeNull();
  });

  it.each([
    ["an object", { area: "510" }],
    ["an array", ["510", "555", "0100"]],
    ["a boolean", true],
    ["null", null],
  ])("asks again for a customer_phone that arrived as %s", async (_label, phone) => {
    const res = await changePOST(
      request("change-reservation", "change_reservation", {
        booking_time: WHEN,
        new_requested_at: NEW_WHEN,
        customer_name: "Ann",
        customer_phone: phone,
      }),
    );

    const entry = await toolResult(res);
    expect(entry.error).toBe("I still need the name and number the booking's under.");
    expect(rpcArgs).toBeNull();
  });
});
