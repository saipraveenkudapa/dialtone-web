/** Reading what Vapi POSTs to a phone number's `server.url`.
 *
 *  Sibling of lib/agent/vapi.ts, which reads what Vapi POSTs to a
 *  *tool's* url. Same discipline, different contract: a tool call is
 *  answered with `{results:[...]}` (lib/agent/respond.ts) and this is
 *  not a tool call, so nothing here goes near that envelope.
 *
 *  Three message types matter, and only these three:
 *
 *    assistant-request    -- fires before the call is answered, when the
 *                            number has no assistant bound. Carries no
 *                            call to log yet; it is a question ("who
 *                            should answer this?") that we get 7.5
 *                            seconds to answer.
 *    status-update        -- fires as the call progresses. This is what
 *                            creates the calls row, and it has to,
 *                            because tool calls happen DURING a call
 *                            while end-of-call-report only arrives
 *                            after it. Without a row already there,
 *                            lib/agent/context.ts's callIdForProvider()
 *                            returns null and every agent-taken order
 *                            and booking is stored with no call link --
 *                            which is the symptom, not a side issue.
 *    end-of-call-report   -- fires once, at the end, carrying the
 *                            transcript, the recording, the costs and
 *                            why the call ended.
 *
 *  EVERYTHING THIS MODULE RETURNS IS ALREADY REDACTED AND ALREADY
 *  NARROWED. That is the point of it being a separate module: the route
 *  never sees the raw body, so it cannot accidentally persist one. Two
 *  things in that body must never reach a column:
 *
 *   - `artifact.messages[0]` is the role-"system" entry, and it holds
 *     the ENTIRE system prompt (8757 bytes today). Storing it verbatim
 *     would put a copy of the prompt in every call row and then in the
 *     owner's transcript view.
 *   - every free-text field can contain a card number a caller read out
 *     loud. `lib/agent/redact.ts` says every write path for live-call
 *     text should call through it; this is such a path, and it is not
 *     enough to scrub only the transcript we derive -- the raw report
 *     also carries `artifact.transcript`, the same conversation as one
 *     flat string. Nothing free-text leaves this module unscrubbed, and
 *     the audit payload is a whitelist of scalars rather than the body,
 *     so there is no second copy to forget about. `call_events` is
 *     append-only by design; a leak into it has no cleanup path.
 */

import { redactCardNumbers } from "@/lib/agent/redact";
import type { CallStatus } from "@/lib/supabase/types";
import type { TranscriptLine } from "@/lib/data";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Enough to find or create the call row. Deliberately small: the only
 *  field any of it is trusted for is `providerCallId`, and even that is
 *  never trusted to pick a LOCATION -- the secret does that. */
export type CallIdentity = {
  /** `message.call.id`, Vapi's own id for this call. */
  providerCallId: string | null;
  fromNumber: string | null;
  dialedNumber: string | null;
  /** `message.call.createdAt` -- when the call arrived. */
  startedAt: string | null;
};

/** One row of `call_events`: the append-only audit trail. A whitelist of
 *  scalars, never the body. */
export type AuditEvent = { eventType: string; payload: Record<string, unknown> };

export type EndOfCallReport = {
  identity: CallIdentity;
  endedReason: string | null;
  /** Vapi has no separate "answered" event -- the assistant answers on
   *  connect, and `message.startedAt` is that instant (206ms after
   *  `call.createdAt` on the live calls). Modelled as answered_at
   *  because for this product that is what it means: somebody picked up. */
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  status: CallStatus;
  transferred: boolean;
  transcript: { lines: TranscriptLine[] };
  telephonyCostCents: number;
  llmCostCents: number;
  /** `artifact.presignedMonoUrl`, or null. The only recording URL in the
   *  body that can actually be fetched -- see `presignedRecordingUrl`. */
  recordingUrl: string | null;
};

export type ParsedServerMessage =
  | { type: "assistant-request" }
  | {
      type: "status-update";
      identity: CallIdentity;
      status: CallStatus | null;
      audit: AuditEvent;
    }
  | { type: "end-of-call-report"; report: EndOfCallReport; audit: AuditEvent }
  /** Anything else Vapi sends to this URL: conversation-update,
   *  speech-update, hang, a type that does not exist yet. Answered 200
   *  and dropped. */
  | { type: "unhandled"; name: string | null };

/** Vapi's `status-update` status, mapped onto our own `call_status`.
 *
 *  Only the values that mean something to this product are mapped.
 *  "forwarding" is deliberately NOT `completed` -- the call is still
 *  happening -- and unmapped values return null, which the caller reads
 *  as "leave the row's status alone" rather than guessing. */
const STATUS_MAP: Record<string, CallStatus> = {
  scheduled: "ringing",
  queued: "ringing",
  ringing: "ringing",
  "in-progress": "in_progress",
  forwarding: "in_progress",
  ended: "completed",
};

/** Vapi's `endedReason` (roughly a hundred values) mapped onto our six.
 *
 *  A judgement call, and worth saying so out loud rather than burying:
 *  only two of those values have ever been seen on this number's real
 *  calls ("customer-ended-call" and
 *  "call.in-progress.error-transfer-failed"), so the rest of this is
 *  reasoned from the names, not measured. It is deliberately coarse --
 *  anything naming an error or a failure is `failed`, the two ways a
 *  caller never actually spoke are `no_answer`, and a call that reached
 *  an end at all is `completed`. `busy` is not produced: no verified
 *  endedReason means it, and inventing a mapping to fill an enum value
 *  would be worse than leaving it unused. */
export function callStatusFromEndedReason(
  endedReason: string | null,
  endedAt: string | null,
): CallStatus {
  const reason = (endedReason ?? "").toLowerCase();
  if (/error|failed/.test(reason)) return "failed";
  if (reason === "customer-did-not-answer" || reason === "silence-timed-out") {
    return "no_answer";
  }
  return endedAt ? "completed" : "in_progress";
}

/** USD floats to integer cents, clamped at zero.
 *
 *  Money is integer cents everywhere in this product; Vapi reports
 *  `costBreakdown` as USD floats. Two things are lost here and both are
 *  deliberate. Sub-cent precision: a 44-second call costs $0.1332 and
 *  becomes 13 cents across the two columns, so thousands of calls drift.
 *  And granularity: there are five cost buckets and two integer-cent
 *  columns, so speech-to-text and text-to-speech are folded in with the
 *  model as "the model pipeline" and transport with platform as
 *  "telephony". A `cost_total_micros` column would be the honest fix and
 *  it is not this change's to add. */
function toCents(...usd: unknown[]): number {
  const total = usd.reduce<number>((sum, value) => sum + numberOrZero(value), 0);
  const cents = Math.round(total * 100);
  // The column is `not null default 0 check (>= 0)`.
  return Number.isFinite(cents) && cents > 0 ? cents : 0;
}

/** The conversation, as the owner's call page reads it.
 *
 *  Two filters, both load-bearing. Roles other than bot/user are dropped
 *  -- that removes the system entry carrying the whole prompt, and the
 *  tool_calls entries, which are machinery rather than anything anybody
 *  said. And every surviving line goes through redactCardNumbers. */
function transcriptFrom(artifact: Record<string, unknown> | null): {
  lines: TranscriptLine[];
} {
  const messages = artifact && Array.isArray(artifact.messages) ? artifact.messages : [];
  const lines: TranscriptLine[] = [];

  for (const entry of messages) {
    if (!isPlainObject(entry)) continue;
    const role = entry.role;
    if (role !== "bot" && role !== "user") continue;
    const text = stringOrNull(entry.message);
    if (!text) continue;
    lines.push({
      at: numberOrZero(entry.secondsFromStart),
      who: role === "bot" ? "agent" : "caller",
      text: redactCardNumbers(text),
    });
  }

  return { lines };
}

/** The one recording URL in the body that is fetchable.
 *
 *  `artifact.recordingUrl` and `recording.mono.combinedUrl` are raw
 *  object-store URLs and answer an unauthenticated GET with HTTP 400
 *  (`InvalidArgument: Authorization`) -- they are stable identifiers,
 *  not links. `presignedMonoUrl` is regenerated per webhook delivery and
 *  needs no credentials at all, which is also why nothing may ever send
 *  one: attaching an Authorization header here would post a Twilio or
 *  Vapi credential to a third-party storage host.
 *
 *  Constrained to https with a hostname because this is a URL out of a
 *  request body that the server is about to fetch. The body is
 *  authenticated by the location's secret, so this is a narrow door
 *  already, but "authenticated" is not "may choose which host we call". */
function presignedRecordingUrl(artifact: Record<string, unknown> | null): string | null {
  const raw = artifact ? stringOrNull(artifact.presignedMonoUrl) : null;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function identityFrom(message: Record<string, unknown>): CallIdentity {
  const call = isPlainObject(message.call) ? message.call : null;
  const customer = isPlainObject(message.customer) ? message.customer : null;
  const phoneNumber = isPlainObject(message.phoneNumber) ? message.phoneNumber : null;

  return {
    providerCallId: call ? stringOrNull(call.id) : null,
    fromNumber: customer ? stringOrNull(customer.number) : null,
    dialedNumber: phoneNumber ? stringOrNull(phoneNumber.number) : null,
    startedAt: call ? stringOrNull(call.createdAt) : null,
  };
}

/** Whether this call ended up with a person.
 *
 *  `message.destination` is set when Vapi transferred the call, and
 *  `assistant-forwarded-call` is the endedReason for the assistant's own
 *  transfer_to_human. Either one is a transfer. */
function transferredFrom(
  message: Record<string, unknown>,
  endedReason: string | null,
): boolean {
  if (isPlainObject(message.destination)) return true;
  return endedReason === "assistant-forwarded-call";
}

function durationSecondsFrom(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const seconds = Math.round((end - start) / 1000);
  // There is no `durationSeconds` field in the report; it has to be
  // computed. The column is `check (duration_seconds >= 0)`, and a
  // clock that went backwards must not take the whole write with it.
  return seconds > 0 ? seconds : 0;
}

export function parseServerMessage(body: unknown): ParsedServerMessage {
  const message =
    isPlainObject(body) && isPlainObject(body.message) ? body.message : null;
  const type = message ? stringOrNull(message.type) : null;

  if (!message || !type) return { type: "unhandled", name: type };

  if (type === "assistant-request") return { type: "assistant-request" };

  if (type === "status-update") {
    const status = stringOrNull(message.status);
    const identity = identityFrom(message);
    return {
      type: "status-update",
      identity,
      status: status ? STATUS_MAP[status] ?? null : null,
      audit: {
        eventType: type,
        payload: {
          type,
          status,
          provider_call_id: identity.providerCallId,
          started_at: identity.startedAt,
        },
      },
    };
  }

  if (type === "end-of-call-report") {
    const identity = identityFrom(message);
    const artifact = isPlainObject(message.artifact) ? message.artifact : null;
    const call = isPlainObject(message.call) ? message.call : null;
    const breakdown =
      call && isPlainObject(call.costBreakdown) ? call.costBreakdown : {};

    const endedReason = stringOrNull(message.endedReason);
    const answeredAt = stringOrNull(message.startedAt);
    const endedAt = stringOrNull(message.endedAt);
    const transferred = transferredFrom(message, endedReason);

    const telephonyCostCents = toCents(breakdown.transport, breakdown.vapi);
    const llmCostCents = toCents(breakdown.llm, breakdown.stt, breakdown.tts);

    return {
      type: "end-of-call-report",
      report: {
        identity,
        endedReason,
        answeredAt,
        endedAt,
        durationSeconds: durationSecondsFrom(answeredAt, endedAt),
        status: callStatusFromEndedReason(endedReason, endedAt),
        transferred,
        transcript: transcriptFrom(artifact),
        telephonyCostCents,
        llmCostCents,
        recordingUrl: presignedRecordingUrl(artifact),
      },
      audit: {
        eventType: type,
        // A whitelist of scalars, on purpose. The raw body carries the
        // whole system prompt, the caller's unredacted words twice over
        // (`artifact.transcript` and every `artifact.messages[].message`)
        // and a fetchable recording URL. None of that belongs in an
        // append-only table.
        payload: {
          type,
          ended_reason: endedReason,
          provider_call_id: identity.providerCallId,
          started_at: identity.startedAt,
          answered_at: answeredAt,
          ended_at: endedAt,
          transferred,
          telephony_cost_cents: telephonyCostCents,
          llm_cost_cents: llmCostCents,
          recording_available: presignedRecordingUrl(artifact) !== null,
        },
      },
    };
  }

  return { type: "unhandled", name: type };
}
