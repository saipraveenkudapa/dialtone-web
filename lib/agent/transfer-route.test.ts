import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

/** Exercises `app/api/agent/transfer/route.ts` directly -- calling its
 *  exported `POST` with a real `Request`, no HTTP server involved -- to
 *  pin down the one property that makes this route the escape hatch it's
 *  meant to be: the transfer number comes back regardless of what
 *  happens to the logging write. `logTransferOutcome`'s own correctness
 *  (never throwing, redacting, truncating, logging only the SQLSTATE) is
 *  covered in transfer.test.ts; this file only cares what the route does
 *  with it. */

const SECRET = "swordfish";
const SECRET_HASH = crypto.createHash("sha256").update(SECRET, "utf-8").digest("hex");

const LOCATION = {
  id: "loc-1",
  agent_secret_hash: SECRET_HASH,
  fallback_human_number: "+15105550100",
};

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== "locations") throw new Error(`unexpected table ${table} in this mock`);
      return {
        select: () => ({
          not: () => ({
            eq: (_col: string, hash: string) => ({
              maybeSingle: async () => ({
                data: hash === LOCATION.agent_secret_hash ? LOCATION : null,
                error: null,
              }),
            }),
          }),
        }),
      };
    },
  }),
}));

/** Callbacks handed to `after()`, captured rather than run -- proving
 *  the route never runs (or awaits) them on the response path. A test
 *  that wants to see what one does invokes it explicitly, afterward. */
let scheduled: Array<() => unknown>;
const afterMock = vi.fn((cb: () => unknown) => {
  scheduled.push(cb);
});

vi.mock("next/server", () => ({
  after: (cb: () => unknown) => afterMock(cb),
}));

const logTransferOutcomeMock = vi.fn<
  (
    locationId: string,
    providerCallId: string | null | undefined,
    reason: string | undefined,
  ) => Promise<void>
>(async () => {});
vi.mock("@/lib/agent/transfer", () => ({
  logTransferOutcome: (
    locationId: string,
    providerCallId: string | null | undefined,
    reason: string | undefined,
  ) => logTransferOutcomeMock(locationId, providerCallId, reason),
}));

const { POST } = await import("@/app/api/agent/transfer/route");

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


function request(body?: unknown, { rawBody, secret }: { rawBody?: string; secret?: string } = {}) {
  return new Request("https://x.test/api/agent/transfer", {
    method: "POST",
    headers: {
      "x-dialtone-secret": secret ?? SECRET,
      "content-type": "application/json",
    },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

describe("POST /api/agent/transfer", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    scheduled = [];
    afterMock.mockClear();
    logTransferOutcomeMock.mockClear();
    logTransferOutcomeMock.mockResolvedValue(undefined);
    errorSpy.mockClear();
  });

  it("401s a non-tool-call request whose secret matches no location, scheduling nothing", async () => {
    // Kept, deliberately. A flat body carries no toolCallId, so nobody is
    // on the phone behind it -- it is a probe or a misrouted client, and
    // answering it 200 would delete the only cheap perimeter signal there
    // is.
    const res = await POST(request({ reason: "test" }, { secret: "wrong" }));
    expect(res.status).toBe(401);
    expect(scheduled).toHaveLength(0);
  });

  it("answers a REAL tool call with a bad secret 200, so the caller hears a sentence", async () => {
    // The other half of the same decision. This used to be a 401, which
    // Vapi ignores completely -- so a live caller heard silence. Nothing
    // loosens: no location is resolved, nothing is read, nothing written.
    const res = await POST(
      request(
        {
          message: {
            type: "tool-calls",
            toolCalls: [
              {
                id: "call_9w3zzVmqKj04ah0kW95p5BjI",
                type: "function",
                function: { name: "transfer_to_human", arguments: "{}" },
              },
            ],
            call: { id: "01a000a0-430a-766c-ad61-b9ac47a0552b" },
          },
        },
        { secret: "wrong" },
      ),
    );
    const entry = await toolResult(res);
    expect(entry.toolCallId).toBe("call_9w3zzVmqKj04ah0kW95p5BjI");
    expect(typeof entry.error).toBe("string");
    // The number is never handed out, and nothing is scheduled.
    expect(entry.result).toBeUndefined();
    expect(scheduled).toHaveLength(0);
  });

  it("returns the fallback number and schedules the log write via after()", async () => {
    const res = await POST(
      request({ reason: "shellfish allergy", provider_call_id: "vapi-1" }),
    );
    expect(await okResult(res)).toEqual({ number: LOCATION.fallback_human_number });

    expect(afterMock).toHaveBeenCalledTimes(1);
    // Not run yet -- after() only schedules. logTransferOutcome is only
    // invoked once the (captured) callback is actually run.
    expect(logTransferOutcomeMock).not.toHaveBeenCalled();

    await scheduled[0]();
    expect(logTransferOutcomeMock).toHaveBeenCalledWith(
      LOCATION.id,
      "vapi-1",
      "shellfish allergy",
    );
  });

  it("still returns the number when the scheduled log write will reject once it runs", async () => {
    logTransferOutcomeMock.mockRejectedValueOnce(new Error("db unreachable"));

    const res = await POST(request({ reason: "money dispute", provider_call_id: "vapi-2" }));

    // The response already resolved above -- proving it never depended
    // on the scheduled write -- before the rejecting callback has run at
    // all.
    expect(await okResult(res)).toEqual({ number: LOCATION.fallback_human_number });

    // Running the scheduled task later must not surface as an unhandled
    // rejection either (real `after()` wraps this in its own try/catch;
    // this just confirms the route handed it a plain rejecting promise
    // rather than, say, awaiting it itself and letting the rejection
    // propagate out of POST).
    await expect(scheduled[0]()).rejects.toThrow("db unreachable");
  });

  it("still returns the number when the scheduled log write resolves having only logged an error", async () => {
    // Mirrors what logTransferOutcome does for an ordinary Postgrest
    // error: it resolves normally (see transfer.test.ts), it just also
    // logs. The route must not care either way.
    logTransferOutcomeMock.mockResolvedValueOnce(undefined);

    const res = await POST(request({ reason: "wants a manager", provider_call_id: "vapi-3" }));

    expect(await okResult(res)).toEqual({ number: LOCATION.fallback_human_number });
    await expect(scheduled[0]()).resolves.toBeUndefined();
  });

  it("still returns the number when after() itself throws (e.g. no waitUntil in this environment)", async () => {
    afterMock.mockImplementationOnce(() => {
      throw new Error("`after()` will not work correctly, because `waitUntil` is not available");
    });

    const res = await POST(request({ reason: "test", provider_call_id: "vapi-4" }));

    expect(await okResult(res)).toEqual({ number: LOCATION.fallback_human_number });
    expect(errorSpy).toHaveBeenCalled();
  });

  it("still yields a transfer when the request body is malformed JSON", async () => {
    const res = await POST(request(undefined, { rawBody: "not json{" }));

    expect(await okResult(res)).toEqual({ number: LOCATION.fallback_human_number });

    await scheduled[0]();
    // Nothing could be read from the body, so the scheduled task is told
    // exactly that rather than guessing. `null` rather than `undefined`
    // for the call id: parseToolCall reports "could not tell" as null,
    // the same answer a body of an unrecognised shape gets.
    expect(logTransferOutcomeMock).toHaveBeenCalledWith(LOCATION.id, null, undefined);
  });

  it("yields a transfer with no body at all", async () => {
    const res = await POST(request(undefined));
    expect(await okResult(res)).toEqual({ number: LOCATION.fallback_human_number });
  });

  /* ── the number has to be DIALABLE, not merely set ────────────────
     This route hands its answer to Vapi, which dials it verbatim. A
     truthiness test let "12" and a legacy "(510) 555-0199" through, and
     the failure then happened INSIDE the transfer -- which the caller
     experiences as dead air part-way through being helped, on the one
     tool that exists for allergies, complaints and money. Refusing
     returns a sentence the agent can say instead. */
  describe("a fallback number that cannot be dialled", () => {
    const stored = LOCATION.fallback_human_number;
    afterEach(() => {
      LOCATION.fallback_human_number = stored;
    });

    for (const bad of ["12", "(510) 555-0199", "5105550199", ""]) {
      it(`refuses to hand out ${JSON.stringify(bad)} and schedules nothing`, async () => {
        LOCATION.fallback_human_number = bad;

        const entry = await toolResult(await POST(request({ reason: "shellfish allergy" })));

        expect(entry.result).toBeUndefined();
        expect(typeof entry.error).toBe("string");
        expect(scheduled).toHaveLength(0);
      });
    }

    it("logs the location id and never the number itself", async () => {
      LOCATION.fallback_human_number = "(510) 555-0199";

      await POST(request({ reason: "shellfish allergy" }));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = errorSpy.mock.calls[0];
      expect(logged).toContain(LOCATION.id);
      // The diagnostic says WHICH failure without repeating a caller's
      // destination into the log.
      expect(String(logged[0])).toMatch(/cannot be dialled/);
      expect(JSON.stringify(logged)).not.toContain("555-0199");
    });

    it("still hands out a number that is stored exactly as it will be dialled", async () => {
      LOCATION.fallback_human_number = "+442079460958";

      const res = await POST(request({ reason: "shellfish allergy" }));

      expect(await okResult(res)).toEqual({ number: "+442079460958" });
    });
  });
});
