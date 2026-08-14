/** Whether a spoken name or phone number carries enough to identify a
 *  caller's booking -- mirrored, deliberately loosely, from
 *  `app.caller_name_key` / `app.caller_phone_key` in
 *  supabase/migrations/20260812000800_cancel_change_reservation.sql.
 *
 *  Those two SQL functions strip a name down to alphabetic characters and
 *  a phone number down to digits, and return NULL -- which
 *  cancel_booking/change_booking then answer as `missing_details` -- when
 *  nothing usable survives: a name transcribed as "22", a phone number
 *  heard as five digits. `missing_details` is not in either route's
 *  speakable-refusal allowlist (see cancel-reservation/route.ts and
 *  change-reservation/route.ts), on purpose: every other reason those
 *  functions can return describes a request the route was supposed to
 *  have already validated, so seeing `missing_details` back from the
 *  database means this check was skipped, not that it failed -- and that
 *  stays a logged 500, not a sentence read to a caller.
 *
 *  So the routes ask this question themselves, before the request ever
 *  reaches the database, and answer a "no" the same way every other
 *  unheard field is answered: ask again. That means this only has to
 *  agree with the SQL side on the reachable failure -- nothing survives
 *  to identify anyone -- not reproduce its normalisation byte for byte.
 *  The SQL functions remain the authority on what actually matches a
 *  booking; this is an earlier, cheaper gate in front of them, not a
 *  replacement. */

/** The text form of a spoken field as it actually arrived.
 *
 *  Every value asked about here came out of a `JSON.parse` of a
 *  model-authored `arguments` string, so its declared type is a claim
 *  about the shape, not a guarantee about the bytes -- and the routes
 *  reach it through an `as {customer_phone?: string}` cast, which is
 *  precisely what stops tsc from noticing the difference. The two
 *  predicates below used to take `string | null | undefined` and call
 *  `.replace` on whatever turned up, so `"customer_phone": 5105550100`
 *  threw `TypeError: replace is not a function` out of the handler. An
 *  unwrapped throw in a route is a framework 500, and Vapi ignores any
 *  non-200 completely -- so a caller ringing to cancel or move a table
 *  heard nothing at all.
 *
 *  Finite numbers are COERCED rather than refused, for the reason
 *  lib/agent/messages.ts gives for `spokenPhone`: a callback number is
 *  the one field a tool payload plausibly carries unquoted, and asking a
 *  caller to repeat a number the agent heard perfectly well is a refusal
 *  they cannot answer. NaN and Infinity stringify into things that are
 *  not numbers at all, so they are not numbers here either. Everything
 *  else -- an object, an array, a boolean, null, undefined -- is not a
 *  mis-heard field but a payload nobody should guess at, and becomes the
 *  empty string, which both predicates already answer "no" to.
 *
 *  Exported because the value the gate approves has to be the value the
 *  route sends to SQL: a check that passes "5105550100" and then hands
 *  Postgres the JSON number 5105550100 has approved something it did not
 *  send. */
export function callerFieldText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return "";
}

export function hasUsableCallerName(name: unknown): boolean {
  return callerFieldText(name).replace(/[^a-zA-Z\s]/g, "").trim().length > 0;
}

export function hasUsableCallerPhone(phone: unknown): boolean {
  return callerFieldText(phone).replace(/[^0-9]/g, "").length >= 7;
}
