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
import type { CallOutcome, CallStatus } from "@/lib/supabase/types";
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

/** USD floats to integer cents, rounded once and deliberately.
 *
 *  Money is integer cents everywhere in this product and Vapi reports
 *  every cost as a USD float. Two things were measured on the real
 *  delivery for call 01a00261 before this was written, and both of them
 *  shape what follows.
 *
 *  WHERE THE COSTS ACTUALLY ARE. `message.costBreakdown`, at the TOP
 *  LEVEL of the message -- and NOT `message.call.costBreakdown`, which
 *  the delivered body does not have at all. `message.call` is the call
 *  as it stood when it was CREATED: in the report that closes the call
 *  it still reads `status: "ringing"` and `cost: 0`, and carries no
 *  breakdown key. Pricing off that object is the whole reason every
 *  Vapi call in this database shows $0.00 against a bill Vapi really
 *  sent.
 *
 *  The nested call is still read, second. `GET /call/<id>` returns the
 *  same figures on the call object itself, so a body assembled from the
 *  REST call rather than from a live delivery -- a replay, a backfill --
 *  prices correctly instead of silently landing as free. It costs
 *  nothing: when the message carries its own breakdown that one wins,
 *  and when neither does the answer is zero either way.
 *
 *  HOW IT IS ROUNDED. Adding USD floats and multiplying by 100 is how a
 *  cent goes missing: `0.0116 + 0.1031 + 0.0306` is 0.14529999999999998,
 *  and `1.005 * 100` is 100.49999999999999, which rounds DOWN to a
 *  dollar. So each bucket is converted to an integer number of
 *  dollar-millionths first -- one float operation per bucket, at a
 *  magnitude where four decimal places are exact -- and every sum and
 *  difference after that is integer arithmetic. Each column is then
 *  rounded to the nearest cent exactly once, half up.
 *
 *  Sub-cent precision is still lost, and that is the remaining honest
 *  cost of two integer-cent columns: this call cost $0.2023 and is
 *  stored as 21 cents across the pair. A `cost_micros` column would be
 *  the real fix and it is not this change's to add.
 */

/** A dollar in millionths, and a cent in the same unit. */
const MICROS_PER_DOLLAR = 1_000_000;
const MICROS_PER_CENT = 10_000;

function microsOf(usd: unknown): number {
  return typeof usd === "number" && Number.isFinite(usd)
    ? Math.round(usd * MICROS_PER_DOLLAR)
    : 0;
}

/** Integer dollar-millionths to integer cents, half up, clamped at
 *  zero -- both columns are `not null default 0 check (>= 0)` and a
 *  negative would lose the whole write, transcript and recording with
 *  it. */
function centsFromMicros(micros: number): number {
  if (!Number.isFinite(micros) || micros <= 0) return 0;
  return Math.floor((micros + MICROS_PER_CENT / 2) / MICROS_PER_CENT);
}

/** The two cost columns, from the breakdown the message carried.
 *
 *  Vapi DOES split telephony from the model, so neither column has to
 *  be invented. `transport` is the carriage and `vapi` is the platform
 *  minute fee; together they are what this product calls telephony.
 *  Everything else Vapi billed is the model pipeline -- `stt`, `llm`,
 *  `tts`, and the smaller buckets the same breakdown carries (`chat`,
 *  `knowledgeBaseCost`, `voicemailDetectionCost`,
 *  `analysisCostBreakdown`, every one of them zero on this number
 *  today).
 *
 *  Which is why the model column is `total - telephony` computed in
 *  micros, rather than `llm + stt + tts`: every dollar Vapi billed then
 *  lands in exactly one of the two columns, including the small buckets
 *  and any bucket Vapi adds next year, so nothing silently drops out of
 *  the spend figure `getTodayStats` adds up. `total` is also the better
 *  number -- the four-decimal buckets on this call sum to $0.2024 while
 *  `total` says $0.2023, because Vapi computes it from the unrounded
 *  per-provider costs.
 *
 *  The partition is exact; the rounding is not. Each column is rounded
 *  to the nearest cent once, so the pair can sit a cent either side of
 *  `total` -- this call is 6c + 15c against a $0.2023 bill. That is the
 *  lesser evil on purpose: deriving the second column by subtracting a
 *  rounded first from a rounded total would make the pair add up
 *  exactly and leave one of the two columns a cent wrong on every
 *  single call, and both columns are read on their own.
 *
 *  With no `total`, the pipeline buckets are summed instead. With no
 *  breakdown at all both columns are 0, which is the schema default: a
 *  report carrying no cost must still store its transcript and its
 *  recording. */
function costsFrom(breakdown: Record<string, unknown>): {
  telephonyCostCents: number;
  llmCostCents: number;
} {
  /* CLAMPED HERE, NOT ONLY ON THE WAY OUT. centsFromMicros clamps each
     COLUMN at zero, which is what the CHECK constraints need, but the
     model column is computed as `billed - telephony` and a negative
     telephony is therefore ADDED to it. One bucket below zero was enough:
     {transport: -5, vapi: 0.05, llm: 0.10, total: 0.15} priced as
     telephony 0c and agent 510c -- $5.10 of model cost on a fifteen-cent
     call, in a column getTodayStats sums into the operator's spend
     figure. Clamping each SIDE of the partition first is what makes the
     subtraction safe, because there is then nothing negative left to
     subtract. */
  const telephonyMicros = Math.max(
    0,
    microsOf(breakdown.transport) + microsOf(breakdown.vapi),
  );
  const pipelineMicros = Math.max(
    0,
    microsOf(breakdown.llm) + microsOf(breakdown.stt) + microsOf(breakdown.tts),
  );
  const totalMicros = microsOf(breakdown.total);

  // `total` is trusted only when it is a positive number that is at
  // least as big as the part we can name. A body whose total is missing,
  // zero or smaller than its own buckets is not describing a bill.
  const billedMicros =
    totalMicros > telephonyMicros + pipelineMicros
      ? totalMicros
      : telephonyMicros + pipelineMicros;

  return {
    telephonyCostCents: centsFromMicros(telephonyMicros),
    // Both sides are already clamped, so this difference cannot go
    // negative -- the Math.max is the guard for anyone who later changes
    // how billedMicros is chosen, not for the arithmetic above it.
    llmCostCents: centsFromMicros(Math.max(0, billedMicros - telephonyMicros)),
  };
}

/** What this call produced, for `calls.outcome`.
 *
 *  The column is a `call_outcome` enum -- 'order', 'booking',
 *  'question', 'transferred', 'spam', 'abandoned' (20260807000100) --
 *  and a value outside it fails the UPDATE, taking the transcript, the
 *  costs and the recording path with it. So this returns one of those
 *  six or null.
 *
 *  Null is a real answer, not a gap. Every dashboard renders a call
 *  with no outcome as a neutral "completed" chip, which is true;
 *  lib/data.ts filters the calls list on `outcome = 'order'` and
 *  `outcome = 'booking'`, so a label invented here is not decoration,
 *  it is a row appearing in a filter it does not belong in.
 *
 *  NOTHING HERE IS READ OUT OF THE TRANSCRIPT. Every input is a row
 *  this product itself wrote while the call was still up: `place_order`,
 *  `book_table` and `take_message` each insert carrying the call's id,
 *  which is why the status-update handler has to create the calls row
 *  before any of them fire. "This call produced an order" is therefore a
 *  fact in our own database. A caller who says "I'd like to order" and
 *  then hangs up leaves no order row and gets no order label.
 *
 *  The ranking only decides the rare call that did two things:
 *
 *   - an order beats a booking beats everything else. Those two are the
 *     outcomes this product exists to produce and each has money or a
 *     table attached.
 *   - a transfer ranks BELOW them, which is a change from writing
 *     'transferred' whenever the call was handed over. Nothing is lost
 *     by it: `transferred_to_human` is a column of its own and the
 *     Today page counts transfers from that column, never from this
 *     one. A caller who ordered and then asked an allergen question
 *     really did order, and filing that call under the handoff would
 *     take a real order out of the orders filter.
 *   - a message ranks last and maps to 'question'. There is no
 *     'message' in the enum, and of the six values only 'question'
 *     names an enquiry -- `take_message` exists for the caller the
 *     agent could not finish with, and the row it wrote carries who
 *     rang, what about and what number to ring back, so this label only
 *     has to get the category right.
 *
 *  'spam' and 'abandoned' are never produced here. `is_spam` is its own
 *  column and nothing on this path sets it, and 'abandoned' could only
 *  be guessed from "short call, nothing to show for it" -- which is
 *  also exactly what a caller asking the closing time looks like. Both
 *  stay available for a human to set. */
export type CallArtifacts = {
  transferred: boolean;
  hasOrder: boolean;
  hasBooking: boolean;
  hasMessage: boolean;
};

export function outcomeFromArtifacts(artifacts: CallArtifacts): CallOutcome | null {
  if (artifacts.hasOrder) return "order";
  if (artifacts.hasBooking) return "booking";
  if (artifacts.transferred) return "transferred";
  if (artifacts.hasMessage) return "question";
  return null;
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
  /* Computed from the two timestamps rather than read off
     `message.durationSeconds`, which the delivered body DOES carry -- an
     earlier comment here said it did not, and that was wrong. It is
     preferred anyway: startedAt and endedAt are the same two instants
     this row stores as answered_at and ended_at, so the length always
     agrees with the timeline drawn from them, and a body that arrives
     without the convenience field still prices and still times.
     (Measured on 01a00261: durationSeconds 68.514, this 69, the column
     69.)

     The column is `check (duration_seconds >= 0)`, and a clock that went
     backwards must not take the whole write with it. */
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
    // TOP LEVEL of the message first -- that is where a live delivery
    // puts it, and the nested call snapshot has no breakdown at all.
    // See costsFrom.
    const call = isPlainObject(message.call) ? message.call : null;
    const breakdown = isPlainObject(message.costBreakdown)
      ? message.costBreakdown
      : call && isPlainObject(call.costBreakdown)
        ? call.costBreakdown
        : {};

    const endedReason = stringOrNull(message.endedReason);
    const answeredAt = stringOrNull(message.startedAt);
    const endedAt = stringOrNull(message.endedAt);
    const transferred = transferredFrom(message, endedReason);

    const { telephonyCostCents, llmCostCents } = costsFrom(breakdown);

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
