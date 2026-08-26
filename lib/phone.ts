/** Best-effort normalization of a phone number an owner typed by hand
 *  into E.164 -- the one format Vapi's native transferCall destination
 *  will accept (a bare "(510) 555-0199" 400s with "must be a valid phone
 *  number in the E.164 format", caught live provisioning the onboarding
 *  flow's own test tenant). Assumes US/Canada (+1) when nothing else is
 *  given, since every location in this product is one so far; a number
 *  that already starts with "+" is trusted as already carrying its own
 *  country code and only has its formatting stripped.
 *
 *  This is intentionally narrower than "any E.164 number" -- it accepts
 *  what an owner would actually type (a 10-digit US number, with or
 *  without punctuation, with or without a leading 1) and refuses
 *  anything else, rather than guessing at a country code for a shape it
 *  has never seen. `supabase/seed.sql` documents `fallback_human_number`
 *  as "dialled by Twilio and must be E.164" for exactly this reason. */
export function normalizePhoneToE164(raw: string): string | null {
  const trimmed = raw.trim();

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** The number exactly as stored, but ONLY when that is the string that
 *  will actually be dialled -- otherwise null.
 *
 *  "Not null" and "dialable" are different questions, and this product
 *  asked the first while meaning the second in four places. Nothing
 *  downstream re-formats `locations.fallback_human_number`:
 *  app/api/twilio/voice dials it verbatim in TwiML, app/api/agent/
 *  transfer hands it to Vapi verbatim, and lib/vapi/provision.ts bakes
 *  it into the assistant's native transfer destination -- where a bare
 *  "(510) 555-0199" 400s with "must be a valid phone number in the
 *  E.164 format", caught live. So a row holding "12", or a legacy
 *  local-format number written before setFallbackNumber normalized on
 *  the way in, clears a null check and then drops the one caller nobody
 *  can afford to drop: the one asking about an allergy.
 *
 *  EQUALITY, NOT TRUTHINESS, and normalizePhoneToE164 is the arbiter
 *  rather than a second rule of anybody's own -- it is the exact
 *  function setFallbackNumber writes through, so what a reader demands
 *  and what a save produces cannot drift. A value that normalizes to
 *  something OTHER than itself is not merely untidy: it is a different
 *  string from the one that will be dialled.
 *
 *  This function does NOT repair. Returning the normalized form would
 *  make the string dialled and the string stored two different things,
 *  which is precisely the drift the go-live checklist exists to put in
 *  front of an operator; the repair is one press (save the number
 *  again) and it belongs to the human. Callers get a yes/no and say so
 *  in their own words. */
export function dialableNumber(stored: string | null | undefined): string | null {
  if (!stored) return null;
  return normalizePhoneToE164(stored) === stored ? stored : null;
}
