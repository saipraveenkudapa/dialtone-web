import { describe, expect, it } from "vitest";
import {
  callStatusFromEndedReason,
  outcomeFromArtifacts,
  parseServerMessage,
} from "./server-message";

/** The shape Vapi really delivers to a phone number's `server.url`,
 *  narrowed to the keys this module reads. Not the shape of the call
 *  object the REST API returns, which is a different thing: this is
 *  copied from the webhook body Vapi actually POSTed to
 *  /api/vapi/webhook (readable back through Vapi's own read-only
 *  `GET /logs?type=Webhook`), so the field names, the nesting and the
 *  units are the ones production sends.
 *
 *  Three of those details are load-bearing and each has a test below:
 *  `costBreakdown` sits at the TOP LEVEL of the message and NOT on
 *  `message.call`; the costs are USD floats; and `artifact.messages[0]`
 *  is the system entry holding the whole prompt. */
function report(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      type: "end-of-call-report",
      endedReason: "customer-ended-call",
      startedAt: "2026-08-14T14:37:05.239Z",
      endedAt: "2026-08-14T14:37:49.063Z",
      phoneNumber: { id: "62aa9658", number: "+15106268819", name: "Nonna Rosa" },
      customer: { number: "+13477518097" },
      cost: 0.2023,
      // Top level of the message. This is the only place the delivered
      // body carries the money.
      costBreakdown: {
        transport: 0,
        stt: 0.0116,
        llm: 0.1031,
        tts: 0.0306,
        vapi: 0.0571,
        chat: 0,
        total: 0.2023,
        llmPromptTokens: 34200,
        ttsCharacters: 611,
        knowledgeBaseCost: 0,
        voicemailDetectionCost: 0,
        analysisCostBreakdown: { summary: 0, structuredData: 0, successEvaluation: 0 },
      },
      call: {
        id: "01a000b4-8289-788f-9acc-b83483497bc1",
        type: "inboundPhoneCall",
        // `message.call` is the call as it was CREATED, not as it
        // ended. The report that closes the call really does carry
        // `status: "ringing"` and `cost: 0` here, and no costBreakdown
        // key at all -- which is why reading the money from this object
        // put $0.00 against every Vapi call in the database.
        status: "ringing",
        cost: 0,
        createdAt: "2026-08-14T14:37:05.033Z",
        phoneCallProvider: "vapi",
        transport: { provider: "vapi.sip" },
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
  // floats. This is the defect: the mapping read
  // `message.call.costBreakdown`, the delivered body has no such key,
  // and so every Vapi call in the database reads $0.00 while Vapi bills
  // for it.
  it("reads the cost from the top level of the message, where it really is", () => {
    const parsed = parseServerMessage(report());
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");

    // transport 0 + vapi 0.0571 = $0.0571 -> 6c
    expect(parsed.report.telephonyCostCents).toBe(6);
    // total 0.2023 - telephony 0.0571 = $0.1452 -> 15c
    expect(parsed.report.llmCostCents).toBe(15);
    expect(Number.isInteger(parsed.report.telephonyCostCents)).toBe(true);
    expect(Number.isInteger(parsed.report.llmCostCents)).toBe(true);
  });

  it("prefers the message's own breakdown over the nested call's", () => {
    // A live delivery only ever carries the message-level one. This says
    // which wins if a body ever carried both, and the answer is the one
    // the live delivery uses.
    const parsed = parseServerMessage(
      report({
        call: {
          id: "c1",
          createdAt: "2026-08-14T14:37:05.033Z",
          costBreakdown: { transport: 9.99, vapi: 9.99, llm: 9.99, stt: 9.99, tts: 9.99 },
        },
      }),
    );
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");
    expect(parsed.report.telephonyCostCents).toBe(6);
    expect(parsed.report.llmCostCents).toBe(15);
  });

  // `GET /call/<id>` puts the same figures on the call object itself, so
  // a body assembled from the REST call rather than from a live delivery
  // -- a replay, a backfill -- prices instead of landing as free.
  it("falls back to the call object's breakdown when the message has none", () => {
    const parsed = parseServerMessage(
      report({
        costBreakdown: undefined,
        call: {
          id: "c1",
          createdAt: "2026-08-14T14:37:05.033Z",
          costBreakdown: { transport: 0, vapi: 0.0571, stt: 0.0116, llm: 0.1031, tts: 0.0306 },
        },
      }),
    );
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");
    expect(parsed.report.telephonyCostCents).toBe(6);
    expect(parsed.report.llmCostCents).toBe(15);
  });

  // A report with no cost in it still has to land. The transcript and
  // the recording are the parts nobody can re-derive later; the cost can
  // be read back off Vapi's own API.
  it("stores no cost rather than failing when the report carries none", () => {
    for (const costBreakdown of [undefined, {}, { total: 0 }, "0.20", []]) {
      const parsed = parseServerMessage(
        report({
          costBreakdown,
          call: { id: "c1", createdAt: "2026-08-14T14:37:05.033Z", cost: 0 },
        }),
      );
      if (parsed.type !== "end-of-call-report") throw new Error("wrong type");

      expect(parsed.report.telephonyCostCents).toBe(0);
      expect(parsed.report.llmCostCents).toBe(0);
      // and everything else the report carried survived it
      expect(parsed.report.transcript.lines).toHaveLength(2);
      expect(parsed.report.recordingUrl).toContain("X-Amz-Signature");
      expect(parsed.report.durationSeconds).toBe(44);
    }
  });

  // Multiplying a USD float by 100 is how a cent goes missing. Each
  // bucket becomes an integer number of dollar-millionths first, and
  // every sum and difference after that is integer arithmetic.
  it("rounds half up, and not through a float multiplication", () => {
    // What the naive route does to $1.005, in IEEE 754: 100.49999999999999.
    expect(Math.round(1.005 * 100)).toBe(100);

    const parsed = parseServerMessage(
      report({ costBreakdown: { transport: 1.005, vapi: 0, total: 1.005 } }),
    );
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");
    expect(parsed.report.telephonyCostCents).toBe(101);
    expect(parsed.report.llmCostCents).toBe(0);
  });

  // `knowledgeBaseCost`, `voicemailDetectionCost` and the analysis
  // buckets are real charges that `llm + stt + tts` does not include.
  // Deriving the model column from `total` is what keeps them in the
  // spend figure getTodayStats adds up instead of dropping them.
  it("keeps the buckets it cannot name, by deriving the model column from total", () => {
    const parsed = parseServerMessage(
      report({
        costBreakdown: {
          transport: 0,
          vapi: 0.05,
          stt: 0.01,
          llm: 0.1,
          tts: 0.03,
          knowledgeBaseCost: 0.02,
          total: 0.21,
        },
      }),
    );
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");
    expect(parsed.report.telephonyCostCents).toBe(5);
    // $0.21 - $0.05 = $0.16, not the 14c that llm + stt + tts alone give.
    expect(parsed.report.llmCostCents).toBe(16);
  });

  it("falls back to the named buckets when the report carries no total", () => {
    const parsed = parseServerMessage(
      report({
        costBreakdown: { transport: 0, vapi: 0.0571, stt: 0.0116, llm: 0.1031, tts: 0.0306 },
      }),
    );
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");
    expect(parsed.report.telephonyCostCents).toBe(6);
    // 0.0116 + 0.1031 + 0.0306 summed as integers is $0.1453 -> 15c. As
    // floats it is 0.14529999999999998, which is the whole problem.
    expect(parsed.report.llmCostCents).toBe(15);
  });

  it("never produces a negative cost, whatever the body says", () => {
    const parsed = parseServerMessage(
      report({
        costBreakdown: {
          transport: -5,
          vapi: -1,
          llm: "free",
          stt: null,
          tts: NaN,
          total: -7,
        },
      }),
    );
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");
    // Both columns are `not null default 0 check (>= 0)`, and a failed
    // CHECK loses the whole UPDATE -- transcript and recording with it.
    expect(parsed.report.telephonyCostCents).toBe(0);
    expect(parsed.report.llmCostCents).toBe(0);
  });

  /* The shape the test above cannot see. Every bucket negative at once
     happens to cancel: the total is negative too, so the difference that
     feeds the model column stays small and both columns clamp to zero
     for the wrong reason. ONE negative bucket among positives is the
     case that bites -- a negative telephony was subtracted from a
     positive total and landed in the model column as a credit turned
     into a charge. Real bodies do carry a negative bucket: a credit, a
     provider refund, a correction Vapi applies after the fact. */
  it("does not turn one negative bucket into a charge on the other column", () => {
    const parsed = parseServerMessage(
      report({
        costBreakdown: { transport: -5, vapi: 0.05, llm: 0.1, total: 0.15 },
      }),
    );
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");

    // Before the clamp moved ahead of the subtraction this read 0 and
    // 510: $5.10 of model cost on a fifteen-cent call, which
    // getTodayStats then added to the operator's spend figure.
    expect(parsed.report.telephonyCostCents).toBe(0);
    expect(parsed.report.llmCostCents).toBe(15);
    // And the pair still cannot exceed what Vapi actually billed.
    expect(
      parsed.report.telephonyCostCents + parsed.report.llmCostCents,
    ).toBeLessThanOrEqual(16);
  });

  // The mirror image: the negative sits in the pipeline instead, so the
  // telephony column is the one that must not absorb it.
  it("does not let a negative pipeline bucket inflate the telephony column", () => {
    const parsed = parseServerMessage(
      report({
        costBreakdown: { transport: 0.05, vapi: 0, llm: -5, total: 0.05 },
      }),
    );
    if (parsed.type !== "end-of-call-report") throw new Error("wrong type");

    expect(parsed.report.telephonyCostCents).toBe(5);
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

describe("what the call produced", () => {
  const nothing = {
    transferred: false,
    hasOrder: false,
    hasBooking: false,
    hasMessage: false,
  };

  // `calls.outcome` is a `call_outcome` enum with exactly six values
  // (20260807000100_schema.sql). A seventh fails the UPDATE, and that
  // UPDATE is the one carrying the transcript, the costs and the
  // recording path -- so a bad label does not mislabel a call, it loses
  // one. Exhaustive because there are only sixteen inputs.
  it("only ever returns a value the enum allows, or null", () => {
    const allowed = ["order", "booking", "question", "transferred"];

    for (const transferred of [false, true]) {
      for (const hasOrder of [false, true]) {
        for (const hasBooking of [false, true]) {
          for (const hasMessage of [false, true]) {
            const outcome = outcomeFromArtifacts({
              transferred,
              hasOrder,
              hasBooking,
              hasMessage,
            });
            if (outcome === null) continue;
            // 'spam' has its own boolean column and nothing on this path
            // sets it; 'abandoned' could only be guessed from "short
            // call, nothing to show for it", which is also what asking
            // the closing time looks like. Neither is ever produced.
            expect(allowed).toContain(outcome);
          }
        }
      }
    }
  });

  // Every one of these is a row this product wrote during the call --
  // place_order, book_table, take_message -- not a reading of anything
  // the caller said.
  it("names each thing the call left behind in our own tables", () => {
    expect(outcomeFromArtifacts({ ...nothing, hasOrder: true })).toBe("order");
    expect(outcomeFromArtifacts({ ...nothing, hasBooking: true })).toBe("booking");
    expect(outcomeFromArtifacts({ ...nothing, transferred: true })).toBe("transferred");
    // No 'message' in the enum. Of the six, only 'question' names an
    // enquiry, and the message row itself carries who rang, what about
    // and what number to ring back.
    expect(outcomeFromArtifacts({ ...nothing, hasMessage: true })).toBe("question");
  });

  // The point of deriving this from rows rather than from words: a
  // caller who said "I'd like to order" and hung up produced nothing,
  // and gets no label. Null renders as the neutral "completed" chip,
  // which is true; 'order' would put the call in the orders filter.
  it("leaves a call with nothing to show for it unlabelled", () => {
    expect(outcomeFromArtifacts(nothing)).toBeNull();
  });

  // A caller who ordered and then asked an allergen question really did
  // order. transferred_to_human is a column of its own and the Today
  // page counts handoffs from there, so nothing is lost by ranking the
  // order first -- while ranking the transfer first would take a real
  // order out of the orders filter.
  it("keeps the order when the same call was also handed to a person", () => {
    expect(outcomeFromArtifacts({ ...nothing, hasOrder: true, transferred: true })).toBe(
      "order",
    );
    expect(outcomeFromArtifacts({ ...nothing, hasBooking: true, transferred: true })).toBe(
      "booking",
    );
  });

  it("prefers the order when one call did more than one thing", () => {
    expect(
      outcomeFromArtifacts({
        transferred: true,
        hasOrder: true,
        hasBooking: true,
        hasMessage: true,
      }),
    ).toBe("order");
    expect(outcomeFromArtifacts({ ...nothing, hasBooking: true, hasMessage: true })).toBe(
      "booking",
    );
    expect(outcomeFromArtifacts({ ...nothing, transferred: true, hasMessage: true })).toBe(
      "transferred",
    );
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
