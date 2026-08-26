import { hasUsableCallerName, hasUsableCallerPhone } from "@/lib/agent/caller";
import { looksLikeCardNumber, redactCardNumbers } from "@/lib/agent/redact";

/** Everything `take_message` (app/api/agent/message/route.ts) decides
 *  about a message before it is written, pulled out here so it can be
 *  tested without a database -- the same split as
 *  `buildOrderLines`/`buildTransferLogUpdate`.
 *
 *  The tool exists because transfers are now only for catering and
 *  allergy questions. Everything that used to be handed to a human --
 *  an angry caller, "put me through to the manager", a complaint about
 *  last Friday's order, speech the agent still cannot make out after two
 *  tries -- becomes a row the restaurant can work through instead. So
 *  the bar this file sets has to be exactly one thing: is this a message
 *  somebody could actually act on? A message nobody can return is not a
 *  message, and writing one would be worse than refusing, because it
 *  would look like the caller had been heard. */

/** How long a spoken message may be once it is written down.
 *
 *  Long enough for a complaint told properly -- a couple of hundred
 *  words is more than anybody dictates over the phone -- and far short
 *  of the 2000-character wall the column itself enforces, which exists
 *  to stop a different writer turning `body` into a transcript dump. */
export const MAX_MESSAGE_LENGTH = 400;

/** Caps for the two identity fields. Unlike the message body these are
 *  NOT truncated when they run over: half a phone number is a wrong
 *  number, and half a name is somebody else. Anything past these lengths
 *  did not come out of a person answering "and your name?", so it is
 *  asked again instead. */
export const MAX_CALLER_NAME_LENGTH = 80;
export const MAX_CALLBACK_PHONE_LENGTH = 32;

export type TakenMessage = {
  caller_name: string;
  callback_phone: string;
  body: string;
};

/** Why a message could not be taken yet. All three mean the same kind of
 *  thing -- the agent did not hear enough -- so the route answers all
 *  three the way every other unheard field is answered: ask again
 *  (`agentFail`), never a business decision the agent reads out. */
export type MessageResult =
  | { ok: true; message: TakenMessage }
  | { ok: false; reason: "no_name" | "no_callback" | "no_message" };

/** Free text a caller said aloud, as a string or nothing at all.
 *
 *  Strings only. A name or a message that arrived as an object, an array
 *  or a boolean is not a mis-heard name, it is a payload nobody should
 *  guess at -- the same line `normaliseItemNote` draws for an item note.
 *  Runs of whitespace collapse, because speech-to-text emits them and
 *  they are never meaningful. */
function spokenText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

/** The callback number, which is the one field a tool payload plausibly
 *  carries as a JSON number rather than a string ("callback_number":
 *  5105550119). Coerced rather than refused: the alternative is asking a
 *  caller to repeat a number the agent heard perfectly well. Only finite
 *  numbers -- NaN and Infinity stringify into things that are not
 *  numbers at all. */
function spokenPhone(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  return spokenText(value);
}

/** Turn a `take_message` payload into the row to write, or the reason it
 *  cannot be written yet.
 *
 *  Order of operations, all three of which matter:
 *
 *  1. Redact, then validate, then truncate.
 *
 *     Redaction comes first for the reason spelled out in
 *     `buildTransferLogUpdate`: truncating first can slice a card number
 *     in half at the boundary, leaving a run too short for
 *     `redactCardNumbers` to recognise. Scrub while the text is whole
 *     and there is nothing left to leak by the time it is cut to size.
 *
 *     Validating after redaction rather than before means the checks
 *     below judge the exact text that will be written, not a version of
 *     it that redaction is about to change underneath them. It applies
 *     to the two text fields; the callback number is not scrubbed at all
 *     (see 2).
 *
 *  2. The callback number is checked, not scrubbed.
 *
 *     Redaction is for text -- the message body, and the name in case a
 *     card is read into it. Running it over the callback number as well
 *     used to look like the same rule applied evenly, and it was a trap:
 *     `redactCardNumbers` matches thirteen or more digits with
 *     whitespace between them, which is what an international callback
 *     number sounds like once the dial-out prefix is spoken ("011 44 20
 *     7946 0958", "00 91 98765 43210"). Both became `[redacted]`, which
 *     has no digits, so `hasUsableCallerPhone` failed and the agent said
 *     "I didn't catch the best number to call you back on" -- and the
 *     caller, having been asked for the number, said the same number
 *     again, and heard the same sentence again, with the name and the
 *     whole message thrown away each time. A refusal a caller cannot
 *     answer is the loop `app/api/agent/reservation/route.ts` documents
 *     avoiding for a party of twelve, arrived at from the other side.
 *
 *     So the number keeps its digits, and the no-card-numbers rule is
 *     kept here by `looksLikeCardNumber` instead: a run in the card
 *     length range that also carries the card checksum and starts with a
 *     card issuer's digit is a card, and the whole field is refused --
 *     nothing masked, nothing stored, the agent asks again, which is the
 *     right question to ask somebody who just read out a card. An
 *     ordinary number, domestic or overseas, is none of those things and
 *     is written down as said, the same way `bookings.customer_phone` is
 *     and for the same reason: it is how the restaurant reaches a
 *     person, not something the caller said in passing.
 *
 *  3. Usability is `hasUsableCallerName` / `hasUsableCallerPhone`
 *     (lib/agent/caller.ts) -- the same two questions the cancel and
 *     change routes ask before touching a booking. The question there is
 *     "is this enough to find who you are?" and here it is "is this
 *     enough to ring you back?", which come to the same thing: a name
 *     transcribed as "22" and a number heard as five digits identify
 *     nobody. One definition, not two that drift. */
export function buildMessage(input: {
  caller_name?: unknown;
  callback_number?: unknown;
  message?: unknown;
}): MessageResult {
  const name = redactCardNumbers(spokenText(input.caller_name));
  const phone = spokenPhone(input.callback_number);
  const body = redactCardNumbers(spokenText(input.message));

  if (!hasUsableCallerName(name) || name.length > MAX_CALLER_NAME_LENGTH) {
    return { ok: false, reason: "no_name" };
  }
  if (
    looksLikeCardNumber(phone) ||
    !hasUsableCallerPhone(phone) ||
    phone.length > MAX_CALLBACK_PHONE_LENGTH
  ) {
    return { ok: false, reason: "no_callback" };
  }
  // Nothing to pass on. Not the same failure as a message that rambles:
  // one is silence, the other is a caller who said plenty, and only the
  // second is worth keeping the first 400 characters of.
  if (body === "") {
    return { ok: false, reason: "no_message" };
  }

  return {
    ok: true,
    message: {
      caller_name: name,
      callback_phone: phone,
      body: body.slice(0, MAX_MESSAGE_LENGTH),
    },
  };
}
