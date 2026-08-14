import { describe, expect, it } from "vitest";
import { callStatusFromEndedReason, parseServerMessage } from "./server-message";

/** The shape Vapi really delivers to a phone number's `server.url`,
 *  narrowed to the keys this module reads. Built from the live call
 *  object 01a000b4-8289-788f-9acc-b83483497bc1 on +15106268819, so the
 *  field names, the nesting and the units are the ones production sends
 *  -- `costBreakdown` in USD floats, no `durationSeconds` anywhere, and
 *  `artifact.messages[0]` holding the whole system prompt. */
function report(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      type: "end-of-call-report",
      endedReason: "customer-ended-call",
      startedAt: "2026-08-14T14:37:05.239Z",
      endedAt: "2026-08-14T14:37:49.063Z",
      phoneNumber: { id: "62aa9658", number: "+15106268819", name: "Nonna Rosa" },
      customer: { number: "+13477518097" },
      call: {
        id: "01a000b4-8289-788f-9acc-b83483497bc1",
        type: "inboundPhoneCall",
        status: "ended",
        createdAt: "2026-08-14T14:37:05.033Z",
        phoneCallProvider: "vapi",
        transport: { provider: "vapi.sip" },
        costBreakdown: {
          transport: 0,
          stt: 0.0076,
          llm: 0.0719,
          tts: 0.0173,
          vapi: 0.0365,
          chat: 0,
          total: 0.1332,
        },
      },
      artifact: {
        transcript: "AI: Hi. Thanks for calling Nonna Rosa.\nUser: My card is 4111 1111 1111 1111.",
        messages: [
          { role: "system", message: "YOU ARE ANSWERING THE PHONE FOR NONNA ROSA...", secondsFromStart: 0 },
          { role: "bot", message: "Hi. Thanks for calling Nonna Rosa.", secondsFromStart: 0.6 },
          { role: "user", message: "My card is 4111 1111 1111 1111.", secondsFromStart: 6.1 },
          { role: "tool_calls", toolCalls: [{ id: "t1" }], secondsFromStart: 8 },
        ],
        recordingUrl: "https://x.r2.cloudflarestorage.com/hipaa-recordings/a-mono.wav",
        presignedMonoUrl:
          "https://hipaa-recordings.example.com/a-mono.wav?X-Amz-Signature=deadbeef",
      },
      ...overrides,
    },
  };
}

describe("end-of-call-report", () => {
  it("reads the call id, the caller and the number they dialled", () => {
    const parsed = parseServerMessage(report());
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");

    expect(parsed.report.identity).toEqual({
      providerCallId: "01a000b4-8289-788f-9acc-b83483497bc1",
      fromNumber: "+13477518097",
      dialedNumber: "+15106268819",
      startedAt: "2026-08-14T14:37:05.033Z",
    });
  });

  // The report has NO durationSeconds field. Getting this wrong is
  // silent: the column is nullable, so a missing computation shows up as
  // a dashboard full of calls with no length rather than as an error.
  it("computes the duration, which the report does not carry", () => {
    const parsed = parseServerMessage(report());
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");
    expect(parsed.report.durationSeconds).toBe(44);
  });

  it("clamps a backwards clock to zero rather than failing the row's CHECK", () => {
    const parsed = parseServerMessage(
      report({ startedAt: "2026-08-14T14:37:49.063Z", endedAt: "2026-08-14T14:37:05.239Z" }),
    );
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");
    // `check (duration_seconds >= 0)` -- a negative here loses the whole
    // write, and with it the transcript and the recording.
    expect(parsed.report.durationSeconds).toBe(0);
  });

  // Money is integer cents everywhere in this product; Vapi reports USD
  // floats. Five buckets, two columns.
  it("folds five USD float cost buckets into two integer-cent columns", () => {
    const parsed = parseServerMessage(report());
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");

    // transport 0 + vapi 0.0365 -> 4c
    expect(parsed.report.telephonyCostCents).toBe(4);
    // llm 0.0719 + stt 0.0076 + tts 0.0173 = 0.0968 -> 10c
    expect(parsed.report.llmCostCents).toBe(10);
    expect(Number.isInteger(parsed.report.telephonyCostCents)).toBe(true);
    expect(Number.isInteger(parsed.report.llmCostCents)).toBe(true);
  });

  it("never produces a negative cost, whatever the body says", () => {
    const parsed = parseServerMessage(
      report({
        call: {
          id: "c1",
          createdAt: "2026-08-14T14:37:05.033Z",
          costBreakdown: { transport: -5, vapi: -1, llm: "free", stt: null, tts: NaN },
        },
      }),
    );
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");
    // Both columns are `not null default 0 check (>= 0)`.
    expect(parsed.report.telephonyCostCents).toBe(0);
    expect(parsed.report.llmCostCents).toBe(0);
  });

  // The single most damaging thing that could be stored from this body.
  // artifact.messages[0] is the role-"system" entry and it carries the
  // ENTIRE system prompt -- storing it verbatim would put a copy of the
  // prompt in every call row and then in the owner's transcript view.
  it("never lets the system prompt into the transcript", () => {
    const parsed = parseServerMessage(report());
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");

    expect(parsed.report.transcript.lines.every((l) => l.who !== "agent" || l.at > 0)).toBe(
      true,
    );
    expect(JSON.stringify(parsed.report.transcript)).not.toContain(
      "YOU ARE ANSWERING THE PHONE",
    );
    // tool_calls entries are machinery, not anything anybody said.
    expect(parsed.report.transcript.lines).toHaveLength(2);
  });

  it("shapes the transcript the way the owner's call page reads it", () => {
    const parsed = parseServerMessage(report());
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");

    expect(parsed.report.transcript.lines[0]).toEqual({
      at: 0.6,
      who: "agent",
      text: "Hi. Thanks for calling Nonna Rosa.",
    });
  });

  // lib/agent/redact.ts: "every write path for live-call text should call
  // through here". This is such a path, and the schema comment on
  // calls.transcript already promises it.
  it("redacts a card number a caller read out loud", () => {
    const parsed = parseServerMessage(report());
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");

    expect(parsed.report.transcript.lines[1].text).toBe("My card is [redacted].");
    expect(JSON.stringify(parsed.report.transcript)).not.toContain("4111");
  });

  // Redacting only the derived transcript is not enough: the raw body
  // carries the same conversation a second time as one flat string in
  // `artifact.transcript`. call_events is append-only -- a card number
  // that lands there has no cleanup path -- so the audit payload is a
  // whitelist of scalars rather than the body.
  it("keeps the caller's words, the prompt and the recording link out of the audit payload", () => {
    const parsed = parseServerMessage(report());
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");

    const payload = JSON.stringify(parsed.audit.payload);
    expect(payload).not.toContain("4111");
    expect(payload).not.toContain("My card is");
    expect(payload).not.toContain("YOU ARE ANSWERING THE PHONE");
    expect(payload).not.toContain("X-Amz-Signature");
    expect(payload).not.toContain("Thanks for calling");
    expect(parsed.audit.eventType).toBe("end-of-call-report");
    // It still says whether there was audio, which is the part anybody
    // replaying this trail would want.
    expect(parsed.audit.payload.recording_available).toBe(true);
  });

  // Only the presigned URL is fetchable. The raw `recordingUrl` answers
  // an unauthenticated GET with HTTP 400 InvalidArgument, so falling
  // back to it would produce a silent, permanent recording failure --
  // or worse, tempt someone into attaching a credential to the fetch.
  it("takes the presigned URL and never the raw object-store one", () => {
    const parsed = parseServerMessage(report());
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");
    expect(parsed.report.recordingUrl).toContain("X-Amz-Signature");

    const noPresigned = parseServerMessage(
      report({
        artifact: {
          messages: [],
          recordingUrl: "https://x.r2.cloudflarestorage.com/hipaa-recordings/a-mono.wav",
        },
      }),
    );
    if (noPresigned.type !== "end-of-call-report") throw new Error("wrong type");
    expect(noPresigned.report.recordingUrl).toBeNull();
  });

  // This URL comes out of a request body and the server is about to
  // fetch it. Authentication says the body came from someone holding
  // this location's secret; it does not say they may choose which host
  // we call, or hand us a credentialled URL to replay.
  it("refuses a recording URL that is not plain https", () => {
    for (const presignedMonoUrl of [
      "http://internal.local/a.wav",
      "file:///etc/passwd",
      "https://user:pass@example.com/a.wav",
      "not a url",
    ]) {
      const parsed = parseServerMessage(
        report({ artifact: { messages: [], presignedMonoUrl } }),
      );
      if (parsed.type !== "end-of-call-report") throw new Error("wrong type");
      expect(parsed.report.recordingUrl).toBeNull();
    }
  });

  it("marks a transferred call as transferred, from either signal", () => {
    const viaDestination = parseServerMessage(
      report({ destination: { type: "number", number: "+15105550142" } }),
    );
    if (viaDestination.type !== "end-of-call-report") throw new Error("wrong type");
    expect(viaDestination.report.transferred).toBe(true);

    const viaReason = parseServerMessage(
      report({ endedReason: "assistant-forwarded-call" }),
    );
    if (viaReason.type !== "end-of-call-report") throw new Error("wrong type");
    expect(viaReason.report.transferred).toBe(true);

    const neither = parseServerMessage(report());
    if (neither.type !== "end-of-call-report") throw new Error("wrong type");
    expect(neither.report.transferred).toBe(false);
  });
});

describe("endedReason to call_status", () => {
  it("maps the two reasons the live calls actually produce", () => {
    expect(callStatusFromEndedReason("customer-ended-call", "2026-08-14T14:37:49Z")).toBe(
      "completed",
    );
    expect(
      callStatusFromEndedReason("call.in-progress.error-transfer-failed", "2026-08-14T14:37:49Z"),
    ).toBe("failed");
  });

  it("maps the two ways nobody ever spoke", () => {
    expect(callStatusFromEndedReason("customer-did-not-answer", "2026-08-14T14:37:49Z")).toBe(
      "no_answer",
    );
    expect(callStatusFromEndedReason("silence-timed-out", "2026-08-14T14:37:49Z")).toBe(
      "no_answer",
    );
  });

  it("does not call a call completed when nothing says it ended", () => {
    expect(callStatusFromEndedReason(null, null)).toBe("in_progress");
  });
});

describe("status-update", () => {
  function statusUpdate(status: unknown) {
    return {
      message: {
        type: "status-update",
        status,
        call: { id: "call-1", createdAt: "2026-08-14T14:37:05.033Z" },
        customer: { number: "+13477518097" },
        phoneNumber: { number: "+15106268819" },
      },
    };
  }

  // Not branching on one of them is the point: it is unproven whether
  // inbound Vapi-SIP calls report "ringing" at all, and a handler that
  // only acts on one of the two would create no row for half the calls.
  it("accepts either of the two statuses that mean the call is live", () => {
    for (const [vapi, ours] of [
      ["ringing", "ringing"],
      ["in-progress", "in_progress"],
      ["queued", "ringing"],
      ["forwarding", "in_progress"],
    ] as const) {
      const parsed = parseServerMessage(statusUpdate(vapi));
      if (parsed.type !== "status-update") throw new Error("wrong type");
      expect(parsed.status).toBe(ours);
    }
  });

  it("reports an unmapped status as null rather than guessing at one", () => {
    for (const status of ["not-found", "deletion-failed", "", 7, null]) {
      const parsed = parseServerMessage(statusUpdate(status));
      if (parsed.type !== "status-update") throw new Error("wrong type");
      expect(parsed.status).toBeNull();
    }
  });

  it("still identifies the call even when the status means nothing to us", () => {
    const parsed = parseServerMessage(statusUpdate("not-found"));
    if (parsed.type !== "status-update") throw new Error("wrong type");
    expect(parsed.identity.providerCallId).toBe("call-1");
  });
});

describe("everything else", () => {
  it("recognises an assistant-request", () => {
    expect(parseServerMessage({ message: { type: "assistant-request" } })).toEqual({
      type: "assistant-request",
    });
  });

  it("drops the message types this route has no job for", () => {
    for (const type of ["conversation-update", "speech-update", "hang", "brand-new-type"]) {
      expect(parseServerMessage({ message: { type } })).toEqual({ type: "unhandled", name: type });
    }
  });

  it("never throws on a body that is not a Vapi envelope at all", () => {
    for (const body of [null, undefined, "", 7, [], {}, { message: "hello" }, { message: {} }]) {
      expect(parseServerMessage(body).type).toBe("unhandled");
    }
  });

  // The tool contract is a different contract. A tool-call body
  // misdelivered here must not be mistaken for anything actionable.
  it("does not mistake a tool-call body for a server message", () => {
    const parsed = parseServerMessage({
      message: { toolCalls: [{ id: "t1", function: { name: "get_menu", arguments: "{}" } }] },
    });
    expect(parsed.type).toBe("unhandled");
  });
});
