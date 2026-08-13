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
