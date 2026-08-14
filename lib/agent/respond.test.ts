import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentOk, agentFail, agentUnauthorised } from "./respond";

/** Pins VAPI'S contract, not ours.
 *
 *  This file used to pin the bug. Its three tests asserted, in order:
 *
 *    1. `agentOk({items:[]})` -> 200 with body `{ok:true, items:[]}` --
 *       an envelope Vapi discards, with the payload as an object rather
 *       than the string `result` Vapi requires.
 *    2. `agentFail("Something went wrong", 500)` -> status 500 -- the
 *       exact status Vapi's docs say is "ignored completely".
 *    3. `agentFail("nope")` -> status 400 -- pinning the default that
 *       guaranteed silence on every validation refusal.
 *
 *  All three passed, every run, for as long as the repo has existed.
 *  They did not fail to test the contract; they pinned the WRONG one and
 *  actively defended it against correction, which is how 684 green tests
 *  coexisted with a bug that broke every tool call on every production
 *  call. Rewritten below to assert what Vapi actually reads. */

/** The response body, and the single result entry inside it. */
async function envelope(res: Response) {
  const body = (await res.json()) as {
    results: { toolCallId: string | null; result?: string; error?: string }[];
  };
  return body;
}

const ALL_SEPARATORS = /[\r\n\u2028\u2029]/;

describe("the Vapi results envelope", () => {
  it("wraps a success in results[] with a single-line string result", async () => {
    const res = agentOk({ a: 1 }, "tc_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ toolCallId: "tc_1", result: '{"a":1}' }],
    });
  });

  it("wraps a failure in results[] with a spoken-friendly error", async () => {
    const res = agentFail("I can't pull the menu up right now.", "tc_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ toolCallId: "tc_1", error: "I can't pull the menu up right now." }],
    });
  });

  it("makes results an ARRAY of length one -- a bare result object does not work", async () => {
    const body = await envelope(agentOk({ a: 1 }, "tc_1"));
    // The docs call this out explicitly ("Individual result objects won't
    // work"), so it gets its own assertion rather than riding along
    // inside a toEqual.
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toHaveLength(1);
  });

  it("uses result XOR error -- the other key is absent, not undefined", async () => {
    const ok = (await envelope(agentOk({ a: 1 }, "tc"))).results[0];
    expect("result" in ok).toBe(true);
    expect("error" in ok).toBe(false);

    const fail = (await envelope(agentFail("nope", "tc"))).results[0];
    expect("error" in fail).toBe(true);
    expect("result" in fail).toBe(false);
  });

  it("serialises the payload as a STRING, never an object", async () => {
    // The failing production response sent an object. This is the bug.
    const body = await envelope(agentOk({ categories: [], sold_out: [] }, "tc"));
    expect(typeof body.results[0].result).toBe("string");
  });
});

describe("always HTTP 200 -- the assertion that would have caught this", () => {
  // Every distinct message the nine routes can produce. Vapi ignores any
  // non-200 completely, so a single one of these answering 400 or 500 is
  // a caller hearing silence.
  const SPOKEN = [
    "I'm having trouble with our system right now. Let me get someone for you.",
    "I can't pull the menu up right now.",
    "I can't check the hours right now.",
    "I didn't catch the date and time for that.",
    "That time has already passed.",
    "I didn't catch how many people.",
    "I can't check the book right now.",
    "I didn't catch the date and time.",
    "I still need a name and a number for the booking.",
    "I couldn't get that booking in.",
    "I didn't catch when the booking is for.",
    "That booking has already passed.",
    "I still need the name and number the booking's under.",
    "I can't get to the book right now.",
    "I didn't catch when the booking is for now.",
    "I didn't catch the new date and time.",
    "I don't have any items yet.",
    "I still need a name and a callback number.",
    "I didn't catch whether that's for pickup or delivery.",
    "I still need the delivery address.",
    "I can't reach the kitchen system right now.",
    "I didn't catch how many wings you wanted.",
    "I couldn't get that order in.",
    "No transfer number is set up.",
    "I didn't catch your name.",
    "I didn't catch the best number to call you back on.",
    "I didn't catch what you'd like me to pass on.",
    "I couldn't get that message down.",
  ];

  it.each(SPOKEN)("answers 200 for %j", (message) => {
    expect(agentFail(message, "tc_1").status).toBe(200);
  });

  it("answers 200 for every success too", () => {
    expect(agentOk({}, "tc_1").status).toBe(200);
  });

  it("gives agentFail no status parameter to misuse", () => {
    // Crude, and exactly right: the tripwire against someone
    // reintroducing the `status = 400` argument whose default guaranteed
    // silence on every refusal.
    expect(agentFail.length).toBe(2);
  });
});

describe("toolCallId", () => {
  it("echoes Vapi's real id formats byte for byte", async () => {
    for (const id of ["toolu_01DTxxxxxxxxxxxxxxxxxxxx", "call_9w3zzVmqKj04ah0kW95p5BjI"]) {
      const body = await envelope(agentOk({}, id));
      expect(body.results[0].toolCallId).toBe(id);
    }
  });

  it("emits a present null, not an omitted key, when the request was not Vapi-shaped", async () => {
    // Nothing is ever synthesised here: Vapi matches on exact string
    // equality, so a made-up id can never match anything it is waiting
    // on -- it could only disguise genuine contract drift as a healthy
    // call. `null` is the honest "we could not tell".
    for (const res of [agentOk({}, null), agentFail("x", null)]) {
      const body = await envelope(res);
      expect("toolCallId" in body.results[0]).toBe(true);
      expect(body.results[0].toolCallId).toBeNull();
    }
  });
});

describe("the single-line rule", () => {
  it("escapes newlines in data losslessly rather than stripping them", async () => {
    const data = { ingredients: "Black pepper,\npecorino" };
    const res = agentOk(data, "tc");
    const raw = await res.text();

    expect(raw).not.toMatch(ALL_SEPARATORS);
    // Lossless, not a strip: what the owner typed reaches the model
    // byte for byte.
    const result = JSON.parse(raw).results[0].result;
    expect(JSON.parse(result)).toEqual(data);
  });

  it("escapes U+2028, which JSON.stringify leaves raw", async () => {
    const data = { a: "x\u2028y" };
    const raw = await agentOk(data, "tc").text();
    expect(raw).not.toContain("\u2028");
    expect(JSON.parse(JSON.parse(raw).results[0].result)).toEqual(data);
  });

  it("escapes U+2029 too", async () => {
    const data = { a: "x\u2029y" };
    const raw = await agentOk(data, "tc").text();
    expect(raw).not.toContain("\u2029");
    expect(JSON.parse(JSON.parse(raw).results[0].result)).toEqual(data);
  });

  it("collapses newlines in spoken prose to a single space", async () => {
    const body = await envelope(agentFail("first line\nsecond line", "tc"));
    // Lossy on purpose, and losing nothing: a line break carries no
    // meaning in a sentence somebody hears read aloud.
    expect(body.results[0].error).toBe("first line second line");
  });

  it("never pretty-prints a nested payload", async () => {
    // shapeMenu's real shape. `JSON.stringify(data, null, 2)` here would
    // put a newline between every key.
    const raw = await agentOk(
      {
        categories: [{ name: "Pasta", items: [{ name: "Cacio e Pepe", price: "$21.00" }] }],
        sold_out: [],
      },
      "tc",
    ).text();
    expect(raw).not.toMatch(ALL_SEPARATORS);
  });
});

describe("agentUnauthorised", () => {
  const SENTENCE = "I'm having trouble with our system right now. Let me get someone for you.";

  it("answers a recognisable tool call 200, so the caller hears a sentence", async () => {
    const res = agentUnauthorised("call_9w3zzVmqKj04ah0kW95p5BjI");
    expect(res.status).toBe(200);
    const body = await envelope(res);
    expect(body.results[0]).toEqual({
      toolCallId: "call_9w3zzVmqKj04ah0kW95p5BjI",
      error: SENTENCE,
    });
  });

  it("keeps 401 for a request that is not a tool call at all", async () => {
    // A scanner, a probe, a misrouted client -- nobody is on the phone
    // behind it, and answering 200 would delete the only cheap perimeter
    // signal there is.
    const res = agentUnauthorised(null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not authorised" });
  });

  it("says the same opaque thing however authentication failed, naming nothing", async () => {
    const body = await envelope(agentUnauthorised("tc_1"));
    const spoken = body.results[0].error ?? "";
    // Identical for a missing header, a malformed secret, a secret
    // matching no location, and a location with a NULL hash -- one bit,
    // "not accepted", which the old 401 already disclosed.
    expect(spoken).toBe(SENTENCE);
    expect(spoken).not.toContain("x-dialtone-secret");
    expect(spoken).not.toContain("hash");
    expect(spoken).not.toContain("secret");
  });
});

/** The compensating control the 200-for-a-bad-secret decision rests on.
 *
 *  Turning a 401 into a 200 removed the only signal a rejection ever
 *  emitted. `locationForSecret` (lib/agent/auth.ts) logs only when the
 *  Supabase query itself errors -- a missing header, a malformed secret,
 *  a well-formed secret matching no location, and a location with a NULL
 *  agent_secret_hash all return null in silence -- and no route logs
 *  before calling `agentUnauthorised`. So without the line inside
 *  `agentUnauthorised`, credential stuffing wrapped in six lines of Vapi
 *  envelope would be indistinguishable from healthy traffic in both
 *  status codes and logs, and the argument written in respond.ts would
 *  be false. These tests are what stop the signal being dropped again
 *  silently. */
describe("agentUnauthorised leaves a signal behind", () => {
  let logged: unknown[][];

  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs exactly one rejection for the 200 branch, where the status no longer carries it", () => {
    agentUnauthorised("call_9w3zzVmqKj04ah0kW95p5BjI");
    expect(logged).toHaveLength(1);
    expect(logged[0][0]).toBe("[agent] agent secret rejected");
    expect(logged[0][1]).toEqual({ tool_call: true });
  });

  it("logs the 401 branch too, so the code means the same thing wherever it is read", () => {
    agentUnauthorised(null);
    expect(logged).toHaveLength(1);
    expect(logged[0][0]).toBe("[agent] agent secret rejected");
    expect(logged[0][1]).toEqual({ tool_call: false });
  });

  it("writes no secret material and nothing the caller chose", () => {
    // Not the header name, not the hash, not the secret -- and NOT the
    // toolCallId's value, which is a string an attacker picks and could
    // otherwise use to stuff whatever they liked into this line.
    const attacker = 'call_" evil {"admin":true} x-dialtone-secret=swordfish';
    agentUnauthorised(attacker);
    const line = JSON.stringify(logged);
    for (const forbidden of ["x-dialtone-secret", "hash", "swordfish", "evil", attacker]) {
      expect(line).not.toContain(forbidden);
    }
  });

  it("says nothing about the rejection in the body either", async () => {
    const body = await envelope(agentUnauthorised("tc_1"));
    expect(JSON.stringify(body)).not.toContain("rejected");
  });
});
