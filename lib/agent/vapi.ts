/** Reading what Vapi actually POSTs to a custom tool's `server.url`.
 *
 *  Vapi call 01a000a0-430a-766c-ad61-b9ac47a0552b told a caller "I'm
 *  having a bit of trouble pulling up the menu right now" while the
 *  database held four categories and fourteen items and the very same
 *  endpoint answered a hand-rolled POST, with the right secret, with
 *  HTTP 200 and the whole menu. Vapi's own message log for that call
 *  says why: the tool result came back "No result returned". Two
 *  independent faults produced that, and this file is the second half of
 *  the fix (lib/agent/respond.ts is the first): every route read its
 *  arguments off the TOP LEVEL of the request body, and Vapi has never
 *  put them there. Even with the response envelope corrected, every tool
 *  would have received `{}`.
 *
 *  Vapi sends two different shapes in production and both are real:
 *
 *    message.toolCallList[i] = { id, name, arguments: {...} }   (documented)
 *    message.toolCalls[i]    = { id, type: "function",
 *                                function: { name, arguments: "{...}" } }
 *
 *  -- the second being OpenAI's own shape, where `arguments` is a JSON
 *  *string*. The Nonna Rosa log above is the second. Accept both, plus
 *  `toolWithToolCallList` as a last resort, plus a flat body so that
 *  `curl`, scripts/exercise-tools.mjs and the existing route tests keep
 *  exercising the same routes. */

export type ToolCall = {
  /** Vapi matches a result back to its call by exact string equality on
   *  this. `null` means "this body did not present a tool call we could
   *  identify" -- see lib/agent/respond.ts for why nothing is ever
   *  synthesised to fill the gap. */
  toolCallId: string | null;
  name: string | null;
  args: Record<string, unknown>;
  /** `message.call.id` -- Vapi's own id for the call in progress, sent
   *  on every tool-call POST regardless of tool configuration. */
  providerCallId: string | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string, or null. Empty strings are folded into null on
 *  purpose: an id of "" can no more be matched by Vapi than a missing
 *  one can, so letting it through would make `toolCallId !== null` --
 *  which is what decides the auth posture in respond.ts -- answer "yes,
 *  a real tool call" for something that can never be answered. */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A tool call's `arguments`, in whichever form it arrived, as an object.
 *
 *  Never throws and never rethrows. A malformed `arguments` string is
 *  the one case where it would be most tempting to fail loudly, and
 *  exactly the case where failing loudly is worst: the caller is on the
 *  phone, and the route still has to answer 200 with a sentence a person
 *  can hear. `{}` here means "no arguments could be read", which every
 *  route already handles -- it is the same thing an argument-less tool
 *  sends. The toolCallId is unaffected, so the sentence still reaches
 *  the caller. */
function coerceArgs(raw: unknown): Record<string, unknown> {
  // toolCallList shape: already an object.
  if (isPlainObject(raw)) return raw;

  // OpenAI shape: a JSON string. "{}" is exactly what the live Nonna
  // Rosa log carries; "" and "not json" both throw and are caught.
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      // "[1,2]", "4" and "null" all parse cleanly and are still not a
      // set of named arguments.
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Deliberately swallowed. See the docstring.
    }
  }

  return {};
}

/** Keys that only ever appear on a Vapi `message` envelope. */
const ENVELOPE_MARKERS = [
  "toolCallList",
  "toolCalls",
  "toolWithToolCallList",
  "call",
  "type",
] as const;

/** Is this body a Vapi envelope, or a flat legacy one?
 *
 *  The obvious test -- "does `body.message` exist" -- is wrong and
 *  dangerous here, because `take_message`'s own declared argument is
 *  named `message` (AGENT_TOOLS, lib/vapi/provision.ts). A flat body for
 *  that tool is
 *
 *    {"caller_name":"Ann","callback_number":"+1...","message":"call me back"}
 *
 *  and treating it as an envelope means reading `.toolCallList` off a
 *  string, finding nothing, and answering a real caller with an empty
 *  message -- losing the only thing they rang to say.
 *
 *  So: `message` has to be a non-null, non-array object AND carry at
 *  least one marker key. A string `message` fails the first half; an
 *  object-valued legacy `message` fails the second. Both land on the
 *  flat branch, which is right for both. */
function envelopeOf(body: Record<string, unknown>): Record<string, unknown> | null {
  const message = body.message;
  if (!isPlainObject(message)) return null;
  return ENVELOPE_MARKERS.some((key) => key in message) ? message : null;
}

/** `toolCallList` is an array and Vapi may batch. Because each tool has
 *  its own `server.url`, a batch arriving at one route means two calls
 *  to the SAME tool; only the first is answered, so the second gets "No
 *  result returned" -- the exact failure this module exists to fix, in a
 *  rarer shape. Multi-call support is deliberately not built yet (the
 *  `results` ARRAY in the response is what leaves room for it), but the
 *  day it happens must not be silent. */
function firstOf(list: unknown[]): unknown {
  if (list.length > 1) {
    console.error("[agent] batched tool calls, only the first answered", {
      count: list.length,
    });
  }
  return list[0];
}

/** Reads a Vapi tool-call POST body in either shape it really sends, and
 *  falls back to treating a flat body as the arguments themselves. */
export function parseToolCall(body: unknown): ToolCall {
  // A. Not a plain object at all -- including the `null` a route hands
  // over when `request.json()` threw on an empty or malformed body.
  if (!isPlainObject(body)) {
    return { toolCallId: null, name: null, args: {}, providerCallId: null };
  }

  const message = envelopeOf(body);

  // C. Flat legacy body. `args` is the body itself, by reference rather
  // than cloned: routes only read from it, and a clone would allocate a
  // copy of an entire order payload per call for nothing.
  if (!message) {
    return {
      toolCallId: null,
      name: null,
      args: body,
      providerCallId: stringOrNull(body.provider_call_id),
    };
  }

  // B. Envelope. The call id is recovered first, so that even a shape we
  // cannot find a tool call in still attributes itself to a call.
  const call = isPlainObject(message.call) ? message.call : null;
  const providerCallId = call ? stringOrNull(call.id) : null;

  // B1. The documented shape.
  if (Array.isArray(message.toolCallList) && message.toolCallList.length > 0) {
    const entry = firstOf(message.toolCallList);
    if (isPlainObject(entry)) {
      return {
        toolCallId: stringOrNull(entry.id),
        name: stringOrNull(entry.name),
        args: coerceArgs(entry.arguments),
        providerCallId,
      };
    }
  }

  // B2. The OpenAI shape, which is what the live call actually sent.
  if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
    const entry = firstOf(message.toolCalls);
    if (isPlainObject(entry) && isPlainObject(entry.function)) {
      const fn = entry.function;
      // Deliberately NOT gated on `type === "function"`: a future type
      // value that still carries a function payload should be answered,
      // not silently dropped into the "no tool call found" branch.
      if (typeof fn.name === "string") {
        return {
          toolCallId: stringOrNull(entry.id),
          name: stringOrNull(fn.name),
          args: coerceArgs(fn.arguments),
          providerCallId,
        };
      }
    }
  }

  // B3. Last resort. Vapi nests the call one level deeper here, and this
  // is the least stable of the three shapes -- every field access is
  // guarded, and on any payload that carries both this and B1 the two
  // are redundant.
  if (
    Array.isArray(message.toolWithToolCallList) &&
    message.toolWithToolCallList.length > 0
  ) {
    const entry = firstOf(message.toolWithToolCallList);
    if (isPlainObject(entry) && isPlainObject(entry.toolCall)) {
      const toolCall = entry.toolCall;
      const fn = isPlainObject(toolCall.function) ? toolCall.function : toolCall;
      return {
        toolCallId: stringOrNull(toolCall.id),
        name: stringOrNull(fn.name),
        args: coerceArgs(fn.arguments),
        providerCallId,
      };
    }
  }

  // B4. An envelope with no tool call in it -- a status-update or an
  // end-of-call-report posted to a tool URL by misconfiguration.
  //
  // This must NOT fall through to the flat branch. `body.message` is a
  // Vapi envelope object, not a caller's words, and reading its top-level
  // keys as a tool's arguments would hand a route `{type, call,
  // assistant, ...}` and let it act on them.
  return { toolCallId: null, name: null, args: {}, providerCallId };
}
