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

export function hasUsableCallerName(name: string | null | undefined): boolean {
  return (name ?? "").replace(/[^a-zA-Z\s]/g, "").trim().length > 0;
}

export function hasUsableCallerPhone(phone: string | null | undefined): boolean {
  return (phone ?? "").replace(/[^0-9]/g, "").length >= 7;
}
