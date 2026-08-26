/** Card-number-like digit runs, scrubbed from free text a caller could
 *  say before it lands anywhere -- a column, a payload, or a log line.
 *  The project's constraint here is absolute (no card numbers anywhere,
 *  full stop), and `transfer_reason` is the first live write path for
 *  words a caller actually said, with more coming later (the `calls`
 *  table already promises this for `transcript`, in a schema comment,
 *  before any writer for that column exists). This is meant to be the
 *  one place that promise gets kept -- every write path for live-call
 *  text should call through here rather than growing its own pattern.
 *
 *  Matches a run of 13-19 digits -- the range real card numbers fall in
 *  (13 for old Visa, 15 for Amex, 16 for most others, up to 19 for
 *  Maestro) -- allowing whitespace, a comma, or a dash between any two
 *  digits, which is how a person actually reads one out
 *  ("4111 1111 1111 1111"), types one ("4111-1111-1111-1111"), writes
 *  one out digit-group by digit-group ("4111, 1111, 1111, 1111"), or how
 *  speech-to-text renders one with a stray extra space
 *  ("4111  1111  1111  1111"), as well as an unbroken run
 *  ("4111111111111111"). `\b\d{13,19}\b` alone catches only the last of
 *  those.
 *
 *  Deliberately narrow, so it leaves alone what legitimately lives in
 *  these fields:
 *   - a phone number: even a US number with its country code
 *     ("+15105550119") is 11 digits, short of the 13-digit floor here,
 *     and formatting it with spaces, dashes, or parens doesn't add
 *     digits;
 *   - a dollar amount ("$1,234.56" or "$80.48"): real totals here are
 *     nowhere near 13 digits, and the decimal point breaks the run
 *     regardless (a comma alone no longer breaks it, but no realistic
 *     order total has 13 digits before the decimal point);
 *   - a time ("3:15pm", "19:30") or a duration ("25 min"): the colon or
 *     the word breaks the run;
 *   - a date ("2026-08-12"): only 8 digits, short of the floor;
 *   - an order number ("order #4829" or "#1043"): nowhere near 13
 *     digits long.
 *  Anything that actually reaches 13 straight digits, with at most one
 *  comma or dash between any two of them (plus any surrounding
 *  whitespace), is treated as a card number and removed -- erring
 *  toward redacting an implausible false positive (a 13+ digit
 *  reference number with card-style spacing) over ever leaving a real
 *  card number in place. */
const CARD_NUMBER_RUN = /\b\d(?:\s*[,-]?\s*\d){12,18}\b/g;

/** Replaces every card-number-like run in `text` with `[redacted]`.
 *  Everything else in the string -- punctuation, letters, shorter digit
 *  runs -- passes through unchanged. */
export function redactCardNumbers(text: string): string {
  return text.replace(CARD_NUMBER_RUN, "[redacted]");
}

/** Whether `text` contains something that is actually a card number,
 *  rather than merely a long run of digits.
 *
 *  `redactCardNumbers` above is deliberately trigger-happy, and that is
 *  right for free text: scrubbing an innocent 13-digit reference number
 *  out of a complaint costs nothing, because every other word the caller
 *  said survives around it. It is exactly wrong for a field whose entire
 *  value is the digits -- a callback number. There, replacing the run
 *  with `[redacted]` does not damage the text, it destroys the field,
 *  and the caller is asked for a number they already gave correctly.
 *  International numbers reach the 13-digit floor easily once a dial-out
 *  prefix is spoken ("011 44 20 7946 0958" is fifteen digits, "00 91
 *  98765 43210" is fourteen), so that is not a rare case, it is every
 *  overseas caller.
 *
 *  So this asks the stricter question, using the two things that are
 *  true of a payment card and not of a phone number:
 *
 *   - it carries a Luhn check digit, which a number picked for any other
 *     reason passes only about one time in ten; and
 *   - it starts with a major industry identifier in 2-6 (Amex 3, Visa 4,
 *     Mastercard 2 and 5, Discover/UnionPay/Maestro 6), while a spoken
 *     phone number leads with a trunk, exit or country prefix -- 0, 00,
 *     011, 1, or a `+` that strips to one of those.
 *
 *  Both together, on a run in the 13-19 digit card range. A caller
 *  reading a real card out is caught; the overseas caller is not.
 *
 *  This is a "should I refuse this field?" question, not a scrubber:
 *  nothing it flags may be stored in any form, so callers of it drop the
 *  whole value and ask again rather than writing a masked version. */
export function looksLikeCardNumber(text: string): boolean {
  for (const run of text.match(CARD_NUMBER_RUN) ?? []) {
    const digits = run.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!/^[2-6]/.test(digits)) continue;
    if (passesLuhn(digits)) return true;
  }
  return false;
}

/** The card industry's own checksum (ISO/IEC 7812): double every second
 *  digit from the right, subtract 9 from anything over 9, and the total
 *  is a multiple of ten. `digits` must already be digits only. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}
