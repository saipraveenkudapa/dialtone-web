import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

/** Exercises `app/api/agent/message/route.ts` directly -- calling its
 *  exported `POST` with a real `Request`, no HTTP server involved -- for
 *  the things `messages.test.ts` cannot show about `buildMessage` alone:
 *  what actually reaches the `messages` table, which location it is
 *  written against, and what the caller hears when it cannot be written.
 *
 *  The property this route lives or dies by is the tenant one. It runs
 *  under the service role and bypasses RLS, so "this message belongs to
 *  the restaurant whose secret authenticated the call" is a property of
 *  this code and nothing else -- including for `provider_call_id`, which
 *  arrives in the request body and must never be able to hang a message
 *  off another restaurant's call. */

const SECRET = "swordfish";
const SECRET_HASH = crypto.createHash("sha256").update(SECRET, "utf-8").digest("hex");

const LOCATION = { id: "loc-1", agent_secret_hash: SECRET_HASH };

/** The one call row `callIdForProvider` can find: it belongs to LOCATION
 *  and to this provider id, and to nothing else. */
const CALL_ROW = { id: "call-1", location_id: LOCATION.id, provider_call_id: "vapi-123" };

/** Every row handed to `messages.insert(...)`. */
let inserted: Record<string, unknown>[];
/** What that insert resolves with -- each test sets the failure it is
 *  pinning down. */
let insertResult: () => Promise<{ error: { code: string } | null }>;

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
      if (table === "calls") {
        // Mirrors callIdForProvider's query shape exactly -- both `.eq()`
        // filters -- so the real lookup logic runs rather than a hand-fed
        // answer.
        return {
          select: () => ({
            eq: (col1: string, val1: unknown) => ({
              eq: (col2: string, val2: unknown) => ({
                maybeSingle: async () => {
                  const row: Record<string, unknown> = CALL_ROW;
                  const matches = row[col1] === val1 && row[col2] === val2;
                  return { data: matches ? { id: CALL_ROW.id } : null, error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "messages") {
        return {
          insert: (values: Record<string, unknown>) => {
            inserted.push(values);
            return insertResult();
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { POST } = await import("@/app/api/agent/message/route");

function request(body?: unknown, { rawBody, secret }: { rawBody?: string; secret?: string } = {}) {
  return new Request("https://x.test/api/agent/message", {
    method: "POST",
    headers: {
      "x-dialtone-secret": secret ?? SECRET,
      "content-type": "application/json",
    },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

const MESSAGE = {
  caller_name: "Dana Whitlock",
  callback_number: "+15105550119",
  message: "Unhappy about Friday's order, wants the manager to ring back.",
};

describe("POST /api/agent/message", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    inserted = [];
    insertResult = async () => ({ error: null });
    errorSpy.mockClear();
  });

  it("401s and writes nothing when the secret matches no location", async () => {
    const res = await POST(request(MESSAGE, { secret: "wrong" }));
    expect(res.status).toBe(401);
    expect(inserted).toHaveLength(0);
  });

  it("writes the message against the location the secret resolved to", async () => {
    const res = await POST(request({ ...MESSAGE, provider_call_id: "vapi-123" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, taken: true });
    expect(inserted).toEqual([
      {
        location_id: LOCATION.id,
        call_id: CALL_ROW.id,
        caller_name: MESSAGE.caller_name,
        callback_phone: MESSAGE.callback_number,
        body: MESSAGE.message,
      },
    ]);
  });

  it("ignores a location_id in the body -- the secret is the only thing that decides the tenant", async () => {
    await POST(request({ ...MESSAGE, location_id: "loc-someone-else" }));
    expect(inserted[0].location_id).toBe(LOCATION.id);
  });

  it("does not attach a message to another restaurant's call", async () => {
    // The provider id is real, but it belongs to a call at a different
    // location, so the lookup is scoped out of it and the message is
    // written with no call attached rather than the wrong one.
    const other = { ...CALL_ROW, location_id: "loc-2" };
    CALL_ROW.location_id = other.location_id;
    try {
      await POST(request({ ...MESSAGE, provider_call_id: "vapi-123" }));
      expect(inserted[0].call_id).toBeNull();
      expect(inserted[0].location_id).toBe(LOCATION.id);
    } finally {
      CALL_ROW.location_id = LOCATION.id;
    }
  });

  it("still takes the message when no call row exists yet", async () => {
    // The webhook that creates the calls row can lose the race with the
    // tool call. A message with no call attached is still a person
    // waiting for a callback, so it is written anyway.
    const res = await POST(request({ ...MESSAGE, provider_call_id: "vapi-never-seen" }));
    expect(res.status).toBe(200);
    expect(inserted[0].call_id).toBeNull();
  });

  it("takes the message when the payload carries no provider_call_id at all", async () => {
    const res = await POST(request(MESSAGE));
    expect(res.status).toBe(200);
    expect(inserted[0].call_id).toBeNull();
  });

  it("redacts a card number before it reaches the insert", async () => {
    await POST(
      request({ ...MESSAGE, message: "You charged 4111 1111 1111 1111 twice on Friday" }),
    );
    expect(inserted[0].body).toBe("You charged [redacted] twice on Friday");
  });

  it("asks again, and writes nothing, for each thing it could not hear", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...MESSAGE, caller_name: "" }, "I didn't catch your name."],
      [
        { ...MESSAGE, callback_number: "" },
        "I didn't catch the best number to call you back on.",
      ],
      [{ ...MESSAGE, message: "  " }, "I didn't catch what you'd like me to pass on."],
    ];

    for (const [body, spoken] of cases) {
      const res = await POST(request(body));
      // 400 and a sentence a person can hear: the caller can answer this,
      // so it is a question, not a failure.
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: spoken });
    }
    expect(inserted).toHaveLength(0);
  });

  it("asks again on a malformed body rather than 500ing", async () => {
    const res = await POST(request(undefined, { rawBody: "not json{" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "I didn't catch your name." });
    expect(inserted).toHaveLength(0);
  });

  it("500s with a speakable apology when the write fails, logging only the location and SQLSTATE", async () => {
    insertResult = async () => ({ error: { code: "23514" } });

    const res = await POST(request(MESSAGE));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "I couldn't get that message down." });

    // Never the caller's name, number or words -- a PostgrestError's
    // details would carry all three.
    expect(errorSpy).toHaveBeenCalledWith("[agent] message insert failed", {
      location_id: LOCATION.id,
      code: "23514",
    });
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(MESSAGE.caller_name);
    expect(logged).not.toContain(MESSAGE.callback_number);
    expect(logged).not.toContain("manager");
  });
});
