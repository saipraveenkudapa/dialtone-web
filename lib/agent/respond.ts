/** One envelope for every Vapi tool endpoint.
 *
 *  Vapi's contract, not ours:
 *
 *    { "results": [ { "toolCallId": "...", "result" | "error": "..." } ] }
 *
 *  Three properties of it are load-bearing, and this module used to
 *  violate all three -- which is why every tool call on every production
 *  call came back "No result returned" and the agent apologised to real
 *  callers about a menu that was sitting right there in the database:
 *
 *   1. ALWAYS HTTP 200, even for errors. The docs are explicit that any
 *      other status code "is ignored completely" -- so the old
 *      `agentFail(msg, 500)` was not a reported error, it was silence.
 *   2. The results ARRAY wrapper is mandatory. A bare result object does
 *      not work.
 *   3. `toolCallId` must match the request's id exactly, and the result
 *      must be a single-line STRING, not an object.
 *
 *  The agent reads these values out loud, so an error must still be a
 *  sentence a person can hear, never a stack trace or a code. That was
 *  already true of the messages and stays true. */

import type { ToolCall } from "@/lib/agent/vapi";

/** The one sentence both authentication failures produce.
 *
 *  Identical for a missing header, a malformed secret, a well-formed
 *  secret matching no location, and a location whose agent_secret_hash
 *  is NULL. One bit -- "not accepted" -- is disclosed, which is exactly
 *  the bit the old 401 already disclosed. It names no location, no
 *  header and nothing derived from the hash. "Not authorised" is a
 *  status, not something a caller should hear from a restaurant. */
const UNAUTHORISED_SPOKEN = "I'm having trouble with our system right now. Let me get someone for you.";

/** JSON with no line terminators anywhere in it.
 *
 *  `JSON.stringify` with NO `space` argument is almost the whole
 *  guarantee on its own: it emits `{"a":"x\ny"}` where `\n` is the
 *  two-character escape sequence, not a line terminator. Nothing in the
 *  payload is rewritten, so a menu item's `ingredients` -- free text an
 *  importer or an owner typed, newlines and all -- and `hours_that_day`
 *  reach the model byte for byte. Stripping newlines out of the data
 *  before stringifying would be precisely the mangling the single-line
 *  rule exists to prevent; escaping is the transport's job.
 *
 *  The one residue: `JSON.stringify` leaves U+2028 and U+2029 raw, and
 *  both are line terminators to a JavaScript consumer. They are escaped
 *  here as a string-level pass over already-escaped JSON, which cannot
 *  corrupt the structure and round-trips exactly. This looks like
 *  superstition without that reason, which is why the reason is here. */
function singleLineJson(data: Record<string, unknown>) {
  return JSON.stringify(data)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Prose collapsed onto one line.
 *
 *  Lossy, and correctly so: this value is a sentence a person hears read
 *  aloud, where a line break carries no meaning at all, so collapsing it
 *  to a space loses nothing. Not theoretical hygiene either --
 *  app/api/agent/order/route.ts interpolates `built.item`, a
 *  caller-spoken menu word, straight into four different error
 *  sentences, so caller-controlled text reaches these strings today. */
function spokenLine(message: string) {
  return message.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ").trim();
}

/** Success. `data` is serialised to a single-line string, because Vapi
 *  requires `result` to be a string -- the failing production response
 *  sent an object, and that alone is the whole bug.
 *
 *  On `toolCallId: null` -- what to emit when the request was not
 *  Vapi-shaped (a hand-rolled curl, a probe, a body shape we do not know
 *  yet): Vapi matches a result to its call by exact string equality, so
 *  a synthesised id (a UUID, a hash of the body, "unknown") can never
 *  match anything Vapi is waiting on. It cannot help a live call and it
 *  can only mislead whoever reads the response later. `null` is the
 *  honest answer to "which tool call is this": we could not tell. It
 *  also keeps the failure loud -- if Vapi ships a fourth body shape
 *  tomorrow, the response says so in the field that matters instead of
 *  us minting an id that makes genuine contract drift look exactly like
 *  a healthy call.
 *
 *  The key is always present with an explicit `null` rather than
 *  omitted, so there is exactly one response shape to test and to read
 *  in a log. */
export function agentOk(data: Record<string, unknown>, toolCallId: string | null) {
  return Response.json({ results: [{ toolCallId, result: singleLineJson(data) }] });
}

/** Failure the agent speaks. HTTP 200, always.
 *
 *  There is no `status` parameter, and it was deleted rather than
 *  defaulted: leaving it in place invites a call site to pass 500 and
 *  get silence, which is the bug this module is being repaired for. */
export function agentFail(message: string, toolCallId: string | null) {
  return Response.json({ results: [{ toolCallId, error: spokenLine(message) }] });
}

/** A bad or missing agent secret -- the ONLY function here that can
 *  answer with something other than 200, and separate from `agentFail`
 *  precisely so that `agentFail` has no status to misuse.
 *
 *  The split is drawn on "is this recognisably a tool call", not on "is
 *  the secret good":
 *
 *  (a) A recognisable tool call with a bad secret answers 200 with an
 *      error result. There is a live human on the phone, and Vapi
 *      ignores a non-200 completely -- so the old 401 was exactly the
 *      silence the caller heard. Nothing about the security posture
 *      loosens: no location is resolved, no row is read, no row is
 *      written, and the route returns before touching Supabase. No new
 *      information leaks, because the sentence is identical for every
 *      way authentication can fail, and the one bit it discloses is the
 *      bit a 401 already disclosed. Brute force does not get cheaper: a
 *      200 body does not reduce the guesses needed against a SHA-256
 *      keyspace.
 *
 *      What DOES change is observability, and it is the one thing here
 *      that genuinely could loosen the posture, so it is paid for on the
 *      line below rather than argued away. A 401 is countable in the
 *      platform access log; a 200 carrying an ordinary-looking error
 *      result is not, and `locationForSecret` (lib/agent/auth.ts) logs
 *      only when the Supabase query itself fails -- a missing header, a
 *      malformed secret, a well-formed secret matching no location and a
 *      location with a NULL agent_secret_hash all return null in
 *      silence. Without a log line here, an attacker who wraps their
 *      guesses in six lines of Vapi envelope would produce a request
 *      stream indistinguishable from healthy traffic in both status
 *      codes and logs. So the rejection is logged HERE -- the HTTP
 *      status must not be the security signal, because Vapi has told us
 *      it will not read it.
 *
 *  (b) A request we cannot even identify as a tool call keeps its 401.
 *      No caller is behind a scanner, a probe or a misrouted client, and
 *      answering those 200 would turn every agent endpoint into a
 *      uniform 200-answering surface and delete the only cheap perimeter
 *      signal there is. The "200 for errors" rule is scoped to requests
 *      that present a recognisable Vapi tool call. */
export function agentUnauthorised(toolCallId: string | null) {
  // Logged in here rather than at each of the nine routes, so a tenth
  // route cannot forget it, and logged for BOTH branches so the code
  // means the same thing wherever it is read -- `tool_call` is what
  // separates "a live call whose secret is wrong, probably a rotation
  // that did not reach the assistant" from "something is scanning us".
  //
  // Nothing caller-supplied goes into it: not the header, not the
  // secret, nothing derived from the hash -- and deliberately not the
  // toolCallId's VALUE, which is a string the caller chooses and would
  // let them write whatever they liked into this line. The boolean is
  // the only part of it worth knowing. Same discipline as
  // `locationForSecret`, which logs a SQLSTATE and nothing else.
  console.error("[agent] agent secret rejected", { tool_call: toolCallId !== null });

  if (toolCallId !== null) return agentFail(UNAUTHORISED_SPOKEN, toolCallId);
  return Response.json({ error: "Not authorised" }, { status: 401 });
}

/** Sugar for the shape every route opens with. Kept here so the
 *  `parseToolCall` -> `agentUnauthorised` pairing is written down once. */
export type { ToolCall };
