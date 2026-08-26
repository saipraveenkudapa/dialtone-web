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
 *  exercising the same routes.
 *
 *  THE CONTAINER DOES NOT DECIDE THE ENTRY SHAPE, and reading it as if
 *  it did cost two real orders on 2026-08-18. This module used to branch
 *  on which KEY was present and then assume the shape of the entries
 *  inside it: `toolCallList` meant flat entries, `toolCalls` meant
 *  OpenAI ones. Vapi sends `toolCallList` carrying OPENAI-SHAPED
 *  entries. The first branch won, read `entry.arguments` (undefined),
 *  coerced it to `{}`, and every route was handed a tool call with no
 *  arguments at all -- so a caller who had just confirmed a $40 total
 *  heard "I don't have any items yet." and the `orders` table stayed
 *  empty.
 *
 *  Nothing caught it because the two tools anyone reaches for while
 *  probing -- get_menu and get_hours -- declare no required arguments,
 *  and for them `{}` is indistinguishable from a successful parse. They
 *  answered perfectly on the very calls whose orders were being dropped.
 *
 *  So each entry is now read BY ITS OWN SHAPE, in every container: an
 *  entry carrying a nested `function` object is read there, an entry
 *  carrying `name`/`arguments` flat is read flat, the arguments are
 *  taken from `arguments` OR `parameters` (Vapi's docs use both -- see
 *  `argumentsIn`), and either may be a JSON string or an already-parsed
 *  object in either shape. See lib/agent/vapi-entry-shape.test.ts, which
 *  runs every tool's real declared arguments through all twenty-four
 *  container x entry-shape x wire-key x encoding combinations. */

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

/** The three keys a tool call has been seen to arrive under, in the
 *  order they are trusted. `toolCallList` is the documented one;
 *  `toolCalls` is what the Nonna Rosa call sent; `toolWithToolCallList`
 *  nests the call one level deeper and is the least stable of the three.
 *  On a payload carrying more than one of them they are redundant, so
 *  the first that yields a readable entry wins. */
const CONTAINERS = ["toolCallList", "toolCalls", "toolWithToolCallList"] as const;

/** A tool call's arguments, from whichever of the four places they came.
 *
 *  Vapi delivers them under TWO different key names and does not say
 *  which you will get. Its own docs, fetched raw, disagree with each
 *  other on the same page pair:
 *
 *    fern/server-url/events.mdx
 *      toolCallList:         [{ id, name, parameters: {...} }]
 *      toolWithToolCallList: [{ name, toolCall: { id, parameters } }]
 *    fern/tools/custom-tools.mdx
 *      toolCallList:         [{ id, name, arguments: {...} }]
 *      toolWithToolCallList: [{ ..., toolCall: { id,
 *                                function: { name, parameters } } }]
 *
 *  Three of those four carry `parameters`; production sends `arguments`.
 *  Reading only `arguments` because that is what production sends is the
 *  same mistake as reading `toolCallList` entries as flat because that
 *  is what the docs said -- a guess about a shape, dressed as knowledge,
 *  one Vapi serialization change away from the outage above. The
 *  failure mode is identical too: the id survives, so the response is a
 *  healthy-looking 200, `get_menu` and `get_hours` keep answering
 *  perfectly because they have nothing to lose, and only a caller
 *  placing an order hears "I don't have any items yet."
 *
 *  So both names are read, at both levels, first one defined wins --
 *  `!== undefined` rather than truthiness so that an explicit `null` or
 *  `""` still means "arguments were sent and are unreadable", which
 *  `coerceArgs` turns into `{}` exactly as before.
 *
 *  THE ONE PLACE THIS WOULD BE WRONG is the OUTER element of
 *  `toolWithToolCallList`, whose `parameters` is the tool's JSON SCHEMA
 *  DECLARATION -- `{type:"object",properties:{location:{type:"string"}}}`
 *  in custom-tools.mdx -- and not any caller's arguments. `entryIn`
 *  descends into `toolCall` and hands back `null` if it cannot, so that
 *  element never reaches this function. Keep it that way: loosening
 *  `entryIn` would feed a route a JSON Schema as if a caller had said
 *  it. */
function argumentsIn(entry: Record<string, unknown>, fn: Record<string, unknown>): unknown {
  if (fn.arguments !== undefined) return fn.arguments;
  if (fn.parameters !== undefined) return fn.parameters;
  if (entry.arguments !== undefined) return entry.arguments;
  return entry.parameters;
}

/** One entry, read by its own shape.
 *
 *  The only question asked is "does this entry carry a nested `function`
 *  object" -- never "which list did it arrive in". Both shapes put the
 *  id at the ENTRY level, so `entry.id` is right for both.
 *
 *  The fallbacks to the entry level are not speculative: a hybrid entry
 *  that names the tool inside `function` while leaving the arguments
 *  outside it (or the reverse) is exactly the kind of half-and-half
 *  payload this module was caught out by once already, and the
 *  alternative to reading it is dropping a live caller's order. On a
 *  purely flat entry `fn` IS `entry`, so they are no-ops.
 *
 *  `null` means "nothing identifiable here", which lets the next
 *  container be tried rather than answering a real tool call sitting one
 *  key over with silence. Only an entry with NEITHER an id NOR a name is
 *  refused, and the `&&` is load-bearing in both directions:
 *
 *   - An id with no readable name is still answerable and must be kept.
 *     Every tool has its own `server.url`, so the route already knows
 *     which tool it is and nothing dispatches on `name`; the id, by
 *     contrast, is the only thing Vapi can match a result back by, and
 *     `agentUnauthorised` (lib/agent/respond.ts) keys its 200-vs-401
 *     posture off it. Dropping the entry here would carry the id into
 *     B4 as `null` and hand the caller silence -- the outage's own
 *     failure class. Vapi's documented `toolWithToolCallList` puts the
 *     name on the OUTER element, so an id with no name at entry level is
 *     a shape Vapi prints in its own docs.
 *   - A name with no id is worth keeping for the same reason
 *     `parseToolCall` answers a flat body at all: the route can still do
 *     the work and say so, and `toolCallId: null` is the honest report
 *     that no id was sent.
 *
 *  Both directions are pinned by tests, so tightening this to `||`
 *  fails rather than ships. */
function readEntry(entry: unknown): Omit<ToolCall, "providerCallId"> | null {
  if (!isPlainObject(entry)) return null;

  // Deliberately NOT gated on `type === "function"`: a future type value
  // that still carries a function payload should be answered, not
  // silently dropped.
  const fn = isPlainObject(entry.function) ? entry.function : entry;

  const toolCallId = stringOrNull(entry.id);
  const name = stringOrNull(fn.name) ?? stringOrNull(entry.name);
  if (toolCallId === null && name === null) return null;

  return { toolCallId, name, args: coerceArgs(argumentsIn(entry, fn)) };
}

/** The entry a container's first element actually holds.
 *  `toolWithToolCallList`'s element is the TOOL -- `{type, name,
 *  parameters, description, server, messages, toolCall}` -- with the
 *  call nested one level in under `toolCall`; the other two containers
 *  hold the call directly.
 *
 *  Strict on purpose -- see `argumentsIn`. The outer element of a
 *  `toolWithToolCallList` describes the TOOL, and its `parameters` is
 *  the JSON Schema Vapi was given at provisioning time, so returning it
 *  as a fallback would hand a route the schema as the caller's words. */
function entryIn(container: (typeof CONTAINERS)[number], first: unknown): unknown {
  if (container !== "toolWithToolCallList") return first;
  if (isPlainObject(first) && isPlainObject(first.toolCall)) return first.toolCall;
  return null;
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

  // B1-B3. Each container in turn, and each entry read by its own shape
  // rather than by the container it arrived in. That distinction is the
  // whole of this module's second repair -- see the header.
  for (const container of CONTAINERS) {
    const list = message[container];
    if (!Array.isArray(list) || list.length === 0) continue;

    const entry = readEntry(entryIn(container, firstOf(list)));
    if (entry) return { ...entry, providerCallId };
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
