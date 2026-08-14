import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Exercises `app/api/vapi/webhook/route.ts` directly -- calling its
 *  exported `POST` with a real `Request`, no HTTP server involved.
 *
 *  This route is the one place two long-standing defects are repaired,
 *  and both are the kind that fail silently in production:
 *
 *   F1  No Vapi call was ever logged. Seven real calls had reached
 *       +15106268819 and the `calls` table still held five rows of seed
 *       data, because call logging was built for Twilio and the live
 *       number is Vapi-provisioned. The knock-on was that
 *       callIdForProvider() found nothing, so every agent-taken order
 *       and booking stored a null call link.
 *   F4  The kill switch was inert. The number resolved straight to an
 *       assistant, so nothing consulted our database before the
 *       assistant answered, and an owner flipping the switch mid-service
 *       changed nothing about who picked up the phone.
 */

const SECRET_A = "secret-for-nonna";
const SECRET_B = "secret-for-marty";
const hash = (s: string) => crypto.createHash("sha256").update(s, "utf-8").digest("hex");

type Row = Record<string, unknown>;

const LOCATION_A: Row = {
  id: "loc-a",
  name: "Nonna Rosa",
  agent_secret_hash: hash(SECRET_A),
  vapi_assistant_id: "assistant-a",
  fallback_human_number: "+15105550142",
  kill_switch_on: false,
  is_live: true,
  recording_enabled: true,
};

const LOCATION_B: Row = {
  id: "loc-b",
  name: "Marty's",
  agent_secret_hash: hash(SECRET_B),
  vapi_assistant_id: "assistant-b",
  fallback_human_number: "+15105550199",
  kill_switch_on: false,
  is_live: true,
  recording_enabled: true,
};

/** An in-memory stand-in for the two tables and the one bucket this
 *  route touches, with the constraints that actually matter reproduced:
 *  the GLOBAL unique index on `calls.provider_call_id`, which is what
 *  refuses a cross-tenant insert, and errors surfaced as PostgrestError
 *  shapes carrying a SQLSTATE. */
const store: {
  locations: Row[];
  calls: Row[];
  call_events: Row[];
  uploads: { path: string; contentType: string; bytes: number }[];
  fail: { uploadError: unknown; callUpdateError: unknown };
} = {
  locations: [],
  calls: [],
  call_events: [],
  uploads: [],
  fail: { uploadError: null, callUpdateError: null },
};

let nextId = 1;

class Query {
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private filters: ((row: Row) => boolean)[] = [];

  constructor(private readonly table: "locations" | "calls" | "call_events") {}

  select() {
    return this;
  }
  insert(payload: Row) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  not(column: string) {
    this.filters.push((row) => row[column] !== null && row[column] !== undefined);
    return this;
  }

  private run(): { data: Row[]; error: { code: string } | null } {
    const rows = store[this.table] as Row[];
    const matched = rows.filter((row) => this.filters.every((f) => f(row)));

    if (this.op === "select") return { data: matched, error: null };

    if (this.op === "insert") {
      const payload = this.payload as Row;
      if (
        this.table === "calls" &&
        payload.provider_call_id != null &&
        store.calls.some((c) => c.provider_call_id === payload.provider_call_id)
      ) {
        // 23505: the global unique index on provider_call_id. This is
        // the database half of the tenant boundary.
        return { data: [], error: { code: "23505" } };
      }
      const row = { id: `${this.table}-${nextId++}`, ...payload };
      rows.push(row);
      return { data: [row], error: null };
    }

    if (this.table === "calls" && store.fail.callUpdateError) {
      return { data: [], error: store.fail.callUpdateError as { code: string } };
    }
    for (const row of matched) Object.assign(row, this.payload);
    return { data: matched, error: null };
  }

  async maybeSingle() {
    const { data, error } = this.run();
    return { data: data[0] ?? null, error };
  }
  async single() {
    const { data, error } = this.run();
    if (!error && data.length === 0) return { data: null, error: { code: "PGRST116" } };
    return { data: data[0] ?? null, error };
  }
  then<T>(resolve: (value: { data: Row[]; error: unknown }) => T) {
    return Promise.resolve(this.run()).then(resolve);
  }
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: "locations" | "calls" | "call_events") => new Query(table),
    storage: {
      from: (bucket: string) => ({
        upload: async (
          path: string,
          body: ArrayBuffer,
          options: { contentType: string },
        ) => {
          if (store.fail.uploadError) return { error: store.fail.uploadError };
          expect(bucket).toBe("call-recordings");
          store.uploads.push({
            path,
            contentType: options.contentType,
            bytes: body.byteLength,
          });
          return { error: null };
        },
      }),
    },
  }),
}));

const { POST } = await import("@/app/api/vapi/webhook/route");

function post(body: unknown, secret: string | null = SECRET_A) {
  return POST(
    new Request("https://x.test/api/vapi/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret === null ? {} : { "x-dialtone-secret": secret }),
      },
      body: JSON.stringify(body),
    }),
  );
}

const statusUpdate = (status: string, callId = "call-1") => ({
  message: {
    type: "status-update",
    status,
    call: { id: callId, createdAt: "2026-08-14T14:37:05.033Z" },
    customer: { number: "+13477518097" },
    phoneNumber: { number: "+15106268819" },
  },
});

const endOfCall = (callId = "call-1", overrides: Row = {}) => ({
  message: {
    type: "end-of-call-report",
    endedReason: "customer-ended-call",
    startedAt: "2026-08-14T14:37:05.239Z",
    endedAt: "2026-08-14T14:37:49.063Z",
    customer: { number: "+13477518097" },
    phoneNumber: { number: "+15106268819" },
    call: {
      id: callId,
      createdAt: "2026-08-14T14:37:05.033Z",
      costBreakdown: { transport: 0, stt: 0.0076, llm: 0.0719, tts: 0.0173, vapi: 0.0365 },
    },
    artifact: {
      transcript: "AI: Hi.\nUser: My card is 4111 1111 1111 1111.",
      messages: [
        { role: "system", message: "THE WHOLE SYSTEM PROMPT", secondsFromStart: 0 },
        { role: "bot", message: "Hi. Thanks for calling Nonna Rosa.", secondsFromStart: 0.6 },
        { role: "user", message: "My card is 4111 1111 1111 1111.", secondsFromStart: 6.1 },
      ],
      presignedMonoUrl: "https://recordings.example.com/a-mono.wav?X-Amz-Signature=abc",
    },
    ...overrides,
  },
});

const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const fetchMock = vi.fn();

beforeEach(() => {
  store.locations = [{ ...LOCATION_A }, { ...LOCATION_B }];
  store.calls = [];
  store.call_events = [];
  store.uploads = [];
  store.fail = { uploadError: null, callUpdateError: null };
  nextId = 1;
  errorSpy.mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(1_401_004),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── F4: the kill switch, on the call path at last ──────────────────

describe("assistant-request", () => {
  it("hands Vapi the assistant id when the agent is on", async () => {
    const res = await post({ message: { type: "assistant-request" } });
    expect(res.status).toBe(200);

    // Top level and UNWRAPPED. Vapi accepts exactly {assistant},
    // {assistantId}, {destination} or {error} here.
    expect(await res.json()).toEqual({ assistantId: "assistant-a" });
  });

  it("sends the caller to a person when the kill switch is on", async () => {
    store.locations[0].kill_switch_on = true;

    const body = await (await post({ message: { type: "assistant-request" } })).json();

    expect(body).toEqual({
      destination: {
        type: "number",
        number: "+15105550142",
        // Vapi's default line is "Transferring the call now", which is
        // wrong coming from a restaurant.
        message: "One moment, I'm connecting you.",
      },
    });
    expect(body.assistantId).toBeUndefined();
  });

  it("does the same for a location that is not live", async () => {
    store.locations[0].is_live = false;
    const body = await (await post({ message: { type: "assistant-request" } })).json();
    expect(body.destination.number).toBe("+15105550142");
    expect(body.assistantId).toBeUndefined();
  });

  // {"assistantId": null} would be a malformed answer, and Vapi's
  // fallback for a malformed answer is not our fallback number.
  it("never answers with a null assistant id", async () => {
    store.locations[0].vapi_assistant_id = null;
    const body = await (await post({ message: { type: "assistant-request" } })).json();
    expect(body.destination.number).toBe("+15105550142");
    expect("assistantId" in body).toBe(false);
  });

  // The caller must hear something. `error` is spoken aloud by Vapi, so
  // it is a sentence, not a code.
  it("speaks a sentence rather than going silent when there is no fallback number", async () => {
    store.locations[0].kill_switch_on = true;
    store.locations[0].fallback_human_number = null;

    const res = await post({ message: { type: "assistant-request" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ error: "Sorry, we can't take your call right now." });
  });

  it("fails closed on a secret that matches no location, writing nothing", async () => {
    const res = await post({ message: { type: "assistant-request" } }, "wrong-secret");

    // A failed assistant-request routes the caller to the phone number's
    // fallbackDestination -- a human.
    expect(res.status).toBe(401);
    expect(store.calls).toHaveLength(0);
    expect(store.call_events).toHaveLength(0);

    // Nothing caller-supplied, and nothing derived from the secret,
    // reaches the log or the body.
    expect(JSON.stringify(await res.json())).not.toContain("wrong-secret");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("wrong-secret");
  });

  it("is never answered with the tool envelope", async () => {
    for (const message of [
      { type: "assistant-request" },
      { type: "status-update", status: "ringing", call: { id: "c" } },
      { type: "end-of-call-report", call: { id: "c" } },
      { type: "conversation-update" },
    ]) {
      const body = await (await post({ message })).json();
      // {results:[...]} is Vapi's TOOL contract (lib/agent/respond.ts).
      // Emitting it here would break both contracts at once.
      expect(body).not.toHaveProperty("results");
    }
  });
});

// ── F1: the call finally gets logged ───────────────────────────────

describe("status-update", () => {
  // The whole reason status-update is handled: tool calls land DURING a
  // call, and callIdForProvider() looks the call up by provider_call_id.
  // A row that only appears in the end-of-call-report is a row that
  // every order and booking taken on that call was written without.
  it("creates the call row while the call is still happening", async () => {
    const res = await post(statusUpdate("in-progress"));
    expect(res.status).toBe(200);

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({
      location_id: "loc-a",
      provider_call_id: "call-1",
      from_number: "+13477518097",
      dialed_number: "+15106268819",
      started_at: "2026-08-14T14:37:05.033Z",
      status: "in_progress",
    });
  });

  // A Vapi call has no Twilio SID. Writing Vapi's id into that column
  // would duplicate provider_call_id and poison the key
  // app/api/twilio/voice upserts on.
  it("leaves twilio_call_sid null rather than borrowing the Vapi id", async () => {
    await post(statusUpdate("ringing"));
    expect(store.calls[0].twilio_call_sid).toBeNull();
    expect(store.calls[0].twilio_call_sid).not.toBe("call-1");
  });

  it("does not invent a caller's city or state, which Vapi never sends", async () => {
    await post(statusUpdate("ringing"));
    expect(store.calls[0].from_city).toBeUndefined();
    expect(store.calls[0].from_state).toBeUndefined();
  });

  it("creates one row however many updates arrive", async () => {
    await post(statusUpdate("ringing"));
    await post(statusUpdate("in-progress"));
    await post(statusUpdate("in-progress"));

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].status).toBe("in_progress");
    expect(store.call_events).toHaveLength(3);
  });

  // Vapi delivers these out of order and retries them.
  it("never drags a finished call back to ringing", async () => {
    await post(statusUpdate("in-progress"));
    await post(endOfCall());
    expect(store.calls[0].status).toBe("completed");

    await post(statusUpdate("ringing"));
    expect(store.calls[0].status).toBe("completed");
  });
});

describe("end-of-call-report", () => {
  it("closes the row with what the call produced", async () => {
    await post(statusUpdate("in-progress"));
    const res = await post(endOfCall());
    expect(res.status).toBe(200);

    expect(store.calls[0]).toMatchObject({
      status: "completed",
      answered_at: "2026-08-14T14:37:05.239Z",
      ended_at: "2026-08-14T14:37:49.063Z",
      duration_seconds: 44,
      transcript_status: "ready",
      transferred_to_human: false,
      telephony_cost_cents: 4,
      llm_cost_cents: 10,
    });
  });

  it("logs the call even when no status-update ever arrived", async () => {
    await post(endOfCall());
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].location_id).toBe("loc-a");
    expect(store.calls[0].status).toBe("completed");
  });

  it("stores the caller's words scrubbed, and never the system prompt", async () => {
    await post(endOfCall());

    const transcript = JSON.stringify(store.calls[0].transcript);
    expect(transcript).not.toContain("4111");
    expect(transcript).not.toContain("THE WHOLE SYSTEM PROMPT");
    expect(transcript).toContain("[redacted]");
  });

  // call_events is append-only: a card number that lands there has no
  // cleanup path, and the raw body carries the conversation twice over.
  it("keeps the audit trail free of free text and of the recording link", async () => {
    await post(endOfCall());

    const payload = JSON.stringify(store.call_events.at(-1)?.payload);
    expect(payload).not.toContain("4111");
    expect(payload).not.toContain("THE WHOLE SYSTEM PROMPT");
    expect(payload).not.toContain("X-Amz-Signature");
    expect(store.call_events.at(-1)?.event_type).toBe("end-of-call-report");
  });

  it("records a transfer, and claims nothing when there was none", async () => {
    await post(endOfCall("call-t", { destination: { type: "number", number: "+1510" } }));
    expect(store.calls[0]).toMatchObject({ transferred_to_human: true, outcome: "transferred" });

    await post(endOfCall("call-n"));
    const plain = store.calls.find((c) => c.provider_call_id === "call-n");
    expect(plain?.transferred_to_human).toBe(false);
    // The order / booking / message rows carry the meaning instead.
    expect(plain?.outcome).toBeUndefined();
  });
});

// ── the tenant boundary on a write whose id comes from the body ────

describe("one restaurant's report cannot touch another's call", () => {
  /** location_id comes from the authenticated secret; provider_call_id
   *  comes from the request body. An `.upsert()` on provider_call_id
   *  would make the body choose the row -- and the unique index is
   *  global, so a report authenticated for restaurant B would match and
   *  rewrite restaurant A's row, moving A's call, transcript, recording
   *  and costs into B's dashboard. supabaseAdmin() bypasses RLS, so the
   *  choice of statement is the only tenant boundary on this write. */
  it("refuses to rewrite a call belonging to another location", async () => {
    await post(statusUpdate("in-progress"), SECRET_A);
    expect(store.calls).toHaveLength(1);
    const before = { ...store.calls[0] };

    // B holds a valid secret and claims A's call id.
    const res = await post(endOfCall("call-1"), SECRET_B);

    // Answered, so Vapi does not retry forever -- and nothing moved.
    expect(res.status).toBe(200);
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].location_id).toBe("loc-a");
    expect(store.calls[0]).toEqual(before);
    expect(store.call_events).toHaveLength(1);
  });

  it("never resolves a location from the body's own phone number", async () => {
    // The body names Nonna Rosa's number throughout; the secret is
    // Marty's. The secret wins, every time.
    await post(statusUpdate("in-progress", "call-b"), SECRET_B);
    expect(store.calls[0].location_id).toBe("loc-b");
  });

  it("scopes the lookup by location, so B cannot even read A's row", async () => {
    await post(statusUpdate("in-progress", "shared-id"), SECRET_A);
    await post(statusUpdate("in-progress", "shared-id"), SECRET_B);

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].location_id).toBe("loc-a");
    // B's insert was refused by the global unique index (23505), which
    // is logged as a SQLSTATE and a location id, never as the error text.
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain("23505");
    expect(logged).not.toContain(SECRET_B);
  });
});

// ── the recording ──────────────────────────────────────────────────

describe("the recording", () => {
  it("fetches the presigned URL with no credentials attached", async () => {
    await post(endOfCall());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("X-Amz-Signature");
    // Sending Twilio's (or anyone's) credentials to a third-party
    // storage host would be a credential leak, and the presigned URL
    // does not want one.
    expect(init).toBeUndefined();
  });

  it("stores WAV, under the location's own prefix, and keeps only the path", async () => {
    await post(endOfCall());

    expect(store.uploads).toHaveLength(1);
    expect(store.uploads[0].contentType).toBe("audio/wav");
    expect(store.uploads[0].path).toMatch(/^loc-a\/calls-\d+\.wav$/);
    expect(store.calls[0].recording_path).toBe(store.uploads[0].path);
  });

  it("honours a location that has switched recording off", async () => {
    store.locations[0].recording_enabled = false;
    await post(endOfCall());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.uploads).toHaveLength(0);
    // The call is still logged. That is the point.
    expect(store.calls[0].status).toBe("completed");
  });

  // Kept verbatim from the Twilio path: losing a recording must never
  // take the call record with it.
  it("still logs the call when the audio cannot be fetched", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });

    const res = await post(endOfCall());

    expect(res.status).toBe(200);
    expect(store.calls[0].status).toBe("completed");
    expect(store.calls[0].transcript).toBeTruthy();
    expect(store.calls[0].recording_path).toBeUndefined();
  });

  it("does not write a fetchable recording link into the log", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await post(endOfCall());

    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("X-Amz-Signature");
  });
});

describe("everything else Vapi may send", () => {
  it("answers 200 and writes nothing", async () => {
    for (const type of ["conversation-update", "speech-update", "hang", "future-type"]) {
      const res = await post({ message: { type } });
      expect(res.status).toBe(200);
    }
    expect(store.calls).toHaveLength(0);
    expect(store.call_events).toHaveLength(0);
  });

  it("survives a body that is not JSON at all", async () => {
    const res = await POST(
      new Request("https://x.test/api/vapi/webhook", {
        method: "POST",
        headers: { "x-dialtone-secret": SECRET_A },
        body: "not json",
      }),
    );
    expect(res.status).toBe(200);
    expect(store.calls).toHaveLength(0);
  });
});
