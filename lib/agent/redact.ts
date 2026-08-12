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
 *  Maestro) -- allowing a single space or dash between any two digits,
 *  which is how a person actually reads one out ("4111 1111 1111 1111")
 *  or types one ("4111-1111-1111-1111"), as well as an unbroken run
 *  ("4111111111111111"). `\b\d{13,19}\b` alone catches only the last of
 *  those.
 *
 *  Deliberately narrow, so it leaves alone what legitimately lives in
 *  these fields:
 *   - a phone number: even a US number with its country code
 *     ("15105550119") is 11 digits, short of the 13-digit floor here,
 *     and formatting it with dashes doesn't add digits;
 *   - a dollar amount ("$1,234.56"): the comma and the decimal point
 *     each break the run;
 *   - a time ("3:15pm", "19:30"): the colon breaks the run;
 *   - an order number ("order #4829"): nowhere near 13 digits long.
 *  Anything that actually reaches 13 straight digits, with at most one
 *  separator between any two of them, is treated as a card number and
 *  removed -- erring toward redacting an implausible false positive
 *  (a 13+ digit reference number with card-style spacing) over ever
 *  leaving a real card number in place. */
const CARD_NUMBER_RUN = /\b\d(?:[ -]?\d){12,18}\b/g;

/** Replaces every card-number-like run in `text` with `[redacted]`.
 *  Everything else in the string -- punctuation, letters, shorter digit
 *  runs -- passes through unchanged. */
export function redactCardNumbers(text: string): string {
  return text.replace(CARD_NUMBER_RUN, "[redacted]");
}
