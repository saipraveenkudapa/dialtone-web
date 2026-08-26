import "server-only";

import { ProvisioningError, vapiRequest, type VapiRequestOptions } from "@/lib/vapi/provision";

/* Vapi's phone numbers, which is where this product's phone numbers
 * actually live.
 *
 * The column is called `locations.twilio_number` and that name is now a
 * fossil. There are zero numbers on the Twilio account: the only live
 * number on this platform was issued by Vapi (`provider: "vapi"`) and is
 * bound to a Vapi assistant, and "get this restaurant a number" means
 * POST /phone-number, not a Twilio purchase. The column keeps its name
 * because renaming it would touch every read path for no gain -- it
 * holds the E.164 string of whichever provider issued it, and always
 * did.
 *
 * Shapes below are the ones the live API returns, checked against
 * api.vapi.ai rather than read off the docs:
 *
 *   GET    /phone-number        -> [{ id, orgId, assistantId, number,
 *                                     name, provider, status,
 *                                     providerResourceId, createdAt,
 *                                     updatedAt }]
 *   PATCH  /phone-number/{id}   -> the same object, updated
 *   POST   /phone-number        -> the same object, created
 *
 * Everything here goes through vapiRequest() so a 401 reads as "the key
 * is wrong" and not as "this restaurant is broken", the same way every
 * other Vapi call in the product reports itself.
 *
 * There is deliberately no release/delete wrapper. DELETE /phone-number
 * is the one irreversible act in this feature -- the number can be on a
 * door, a menu and a Google listing -- and nothing in the operator
 * console should be one mis-click away from it. Handing a number back is
 * a job for the Vapi dashboard, by a person who meant it.
 */

/** One number on the Vapi account, narrowed to the fields this product
 *  reasons about. `assistantId` is the binding that decides which
 *  restaurant a caller reaches, so it is the field everything else here
 *  exists to read or set. */
export type VapiPhoneNumber = {
  id: string;
  /** E.164, as Vapi reports it. This -- never a caller-supplied string
   *  -- is what gets written to locations.twilio_number. */
  number: string;
  name: string | null;
  provider: string;
  assistantId: string | null;
  status: string | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Vapi's JSON to ours, or null if the record is not one we can offer.
 *
 *  A record with no id cannot be attached and a record with no number
 *  cannot be dialled or shown, so neither belongs in a picker. That is
 *  not a theoretical case: a number mid-provision can appear before its
 *  E.164 string does. Dropping it is honest -- it comes back on the next
 *  render, by which time it is real. */
export function toPhoneNumber(raw: unknown): VapiPhoneNumber | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const id = text(record.id);
  const number = text(record.number);
  if (!id || !number) return null;

  return {
    id,
    number,
    name: text(record.name),
    provider: text(record.provider) ?? "unknown",
    assistantId: text(record.assistantId),
    status: text(record.status),
  };
}

/** Vapi caps assistant names at 40 characters and is no more generous
 *  here. The name is a label in two dashboards and nothing keys off it,
 *  so truncating is free. */
function label(name: string): string {
  return name.length <= 40 ? name : name.slice(0, 40);
}

/* ── the area code ─────────────────────────────────────────────────── */

/** A three-digit NANP area code, and nothing wider.
 *
 *  The plan reserves the first digit: 0 reaches an operator and 1 opens
 *  a long-distance dial string, so no area code has ever begun with
 *  either and a string that does is a typo rather than a place. Nothing
 *  beyond that is checked here on purpose -- WHICH of the eight hundred
 *  remaining codes Vapi actually holds numbers in is Vapi's fact and
 *  changes hourly, so a table here would refuse real area codes and
 *  still not save a request.
 *
 *  `unknown` rather than `string` because the argument's first stop is a
 *  "use server" boundary: a hand-rolled POST to that action id can carry
 *  a number, a null or nothing at all, and a TypeError raised on
 *  `.trim()` is a 500 where the product owes a sentence. */
export function isAreaCode(value: unknown): value is string {
  return typeof value === "string" && /^[2-9][0-9]{2}$/.test(value.trim());
}

/** What an area code that is not one gets told, wherever it is refused.
 *
 *  One string because two copies drift, and this sentence is printed by
 *  both the module that spends and the module that decides. It
 *  deliberately does not echo what was typed: the two things worth
 *  saying are the rule and that nothing was spent. */
export const AREA_CODE_REFUSAL =
  "That is not an area code. It has to be exactly three digits and can never begin with 0 or " +
  "1 — this is the code the restaurant's customers will see and dial. No number was requested " +
  "and nothing was spent.";

/** The NANP area code inside a number this product already has on file,
 *  or null when there is not one to read.
 *
 *  Pointed at locations.business_phone and locations.fallback_human_number,
 *  which hold whatever an owner typed -- "(510) 555-0142", "+1 510 555
 *  0142", "5105550142", "1-510-555-0142". So the digits are taken first
 *  and the shape decided afterwards, the same way lib/phone.ts's
 *  normalizer does it.
 *
 *  Anything that is not a ten-digit national number, with or without its
 *  leading 1, gets null rather than its first three digits: +44 20 7183
 *  8750 has no NANP area code to offer, and offering "442" would ask
 *  Vapi for a number in a place that does not exist. Null is the honest
 *  answer, and the caller's job is then to ask a person.
 *
 *  The one case this CANNOT tell apart is a foreign number typed with no
 *  country code at all -- "55 1234 5678" is a Mexico City line and is
 *  also, digit for digit, a New Jersey one. Nothing in the string
 *  settles it, which is the second reason what comes out of here is only
 *  ever a suggestion an operator confirms before it is spent. */
export function areaCodeOf(stored: string | null | undefined): string | null {
  if (!stored) return null;

  const trimmed = stored.trim();
  const digits = trimmed.replace(/\D/g, "");

  /* The leading + has to be read BEFORE it is stripped, because it is
     the one unambiguous piece of evidence in the string: it says the
     digits after it begin with a country code. "+49 30 123456" is ten
     digits and is a Berlin landline, and taking its first three would
     ask Vapi for a number in "493" -- which is a real request, for a
     real number, in a place the caller's customers are not. A + is NANP
     only when what follows it is a 1 and ten more digits. */
  if (trimmed.startsWith("+") && !(digits.length === 11 && digits.startsWith("1"))) return null;

  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return null;

  const area = national.slice(0, 3);
  return isAreaCode(area) ? area : null;
}

/** Vapi has numbers, but none left in the area code that was asked for.
 *
 *  A different fact from "that request was wrong" and from "Vapi is
 *  broken", and the only one of the three whose next move is a
 *  neighbouring area code rather than a bug report. Nothing was issued
 *  and nothing was spent, which is why this is safe to surface as its
 *  own thing rather than as a failure of unknown consequence.
 *
 *  A class rather than a message shape so the panel can tell it apart
 *  without matching on prose twice -- see runProvision. */
export class NoNumberInAreaCodeError extends Error {
  readonly areaCode: string;

  constructor(areaCode: string) {
    super(
      `Vapi has no free number in area code ${areaCode} right now, so nothing was issued and ` +
        "nothing was spent. Try a neighbouring area code — this is not a fault in this " +
        "deployment and asking again for the same one will not change it.",
    );
    this.name = "NoNumberInAreaCodeError";
    this.areaCode = areaCode;
  }
}

/** A request that may have allocated a number, and no way from here to
 *  find out whether it did.
 *
 *  POST /phone-number is not a read. Once it has left this process a
 *  deadline, a 502 from something in front of Vapi, a dropped connection
 *  or a 201 whose body will not parse all leave the same question open,
 *  and the one answer that must never be given to it is "no number was
 *  issued" -- an operator who reads that presses the button again, and
 *  the second press is the one that mints the duplicate.
 *
 *  Only 4xx is excluded, and only because it is Vapi itself saying it
 *  refused the request before the pool was touched. */
export class NumberOutcomeUnknownError extends Error {
  constructor(detail: string) {
    super(
      `${detail} This deployment cannot tell whether a number was issued — check the Vapi ` +
        "dashboard before asking for another one, because asking again could mint a second.",
    );
    this.name = "NumberOutcomeUnknownError";
  }
}

/* Vapi answers "there is nothing left in that area code" with the same
   400 it answers a malformed body with, and carries the difference only
   in the prose -- there is no code, and no field, to read instead. So
   this is a text match, and deliberately a narrow one: a negation AND
   the word "available" in some form.

   It is also BOUNDED BY THE STATUS, which the prose alone cannot do.
   "Vapi returned 504 on POST /phone-number: The service is not
   available" satisfies both halves of the text test, and it is the
   opposite fact: a gateway 5xx on a POST is exactly the case where the
   request may have reached Vapi and a number may exist. Only a 400 --
   Vapi's own answer, from Vapi -- may be read as an empty area code.
   The 400 that started all this ("At least one of
   numberDesiredAreaCode, sipUri must be provided") carries neither half
   of the text test, so it stays out on its own account. */
function readsAsNoAvailability(message: string): boolean {
  const text = message.toLowerCase();
  return /\b(no|not|none|cannot|can't|unable)\b/.test(text) && /availab/.test(text);
}

/** Every number on the account. One page: this is an operator's own Vapi
 *  org, which holds numbers in the single digits, and the limit is the
 *  same one findAssistantForLocation() uses against /assistant.
 *
 *  `options` exists for the deadline. This is read while a page is
 *  rendering, and a page that has not painted cannot be acted on -- see
 *  VAPI_TIMEOUT_MS. */
export async function listPhoneNumbers(
  vapiKey: string,
  options?: VapiRequestOptions,
): Promise<VapiPhoneNumber[]> {
  const body = await vapiRequest(vapiKey, "GET", "/phone-number?limit=1000", undefined, options);
  if (!Array.isArray(body)) return [];
  return body.map(toPhoneNumber).filter((n): n is VapiPhoneNumber => n !== null);
}

/** Point an existing number at an assistant.
 *
 *  Exactly reversible: one more PATCH puts it back, which is why the
 *  operator console offers this without a confirmation step and offers
 *  provisioning with one. */
export async function bindPhoneNumber(
  vapiKey: string,
  { phoneNumberId, assistantId, name }: { phoneNumberId: string; assistantId: string; name: string },
): Promise<VapiPhoneNumber> {
  const body = await vapiRequest(vapiKey, "PATCH", `/phone-number/${phoneNumberId}`, {
    assistantId,
    name: label(name),
  });

  const number = toPhoneNumber(body);
  if (!number) {
    // The binding may well have landed; we simply cannot describe what
    // we bound. Say that, rather than reporting a success we cannot
    // evidence -- the caller's next read of the account settles it.
    throw new Error(
      "Vapi accepted the change but returned a phone number record this deployment could not " +
        "read. Reload the page to see where the number actually points.",
    );
  }
  return number;
}

/** Take a new number from Vapi's own pool and bind it in the same call.
 *
 *  `provider: "vapi"` is the free-number path -- no Twilio account and
 *  no card. It spends one of the org's allowance slots. There is no undo
 *  worth the name, so every caller of this must have asked first.
 *
 *  `areaCode` is required, and it is required because Vapi requires it:
 *  a body without it comes back "At least one of numberDesiredAreaCode,
 *  sipUri must be provided" and no number is issued. It is not an
 *  implementation detail this could fill in quietly either way -- it is
 *  the part of the number the restaurant's customers see on a door and
 *  dial, so it is decided by a person upstream and only carried here.
 *
 *  Three failures are told apart on the way out, because each has a
 *  different next move. A malformed area code is refused before the
 *  request is built, so nothing is spent on a typo. An area code Vapi
 *  has nothing left in comes back as NoNumberInAreaCodeError -- "try 925
 *  instead", not "something is broken". And anything that leaves the
 *  outcome of the POST itself unread comes back as
 *  NumberOutcomeUnknownError, so that no caller downstream can promise
 *  an operator a number was not issued when nobody knows. */
export async function createPhoneNumber(
  vapiKey: string,
  { assistantId, name, areaCode }: { assistantId: string; name: string; areaCode: string },
): Promise<VapiPhoneNumber> {
  // First, and before a request exists. Vapi picks the number out of
  // this area code and hands it over already dialable, so a typo here is
  // a real number in the wrong city that nothing can hand back.
  if (!isAreaCode(areaCode)) throw new Error(AREA_CODE_REFUSAL);
  const desired = areaCode.trim();

  let body: unknown;
  try {
    body = await vapiRequest(vapiKey, "POST", "/phone-number", {
      provider: "vapi",
      assistantId,
      name: label(name),
      numberDesiredAreaCode: desired,
    });
  } catch (err) {
    const status = err instanceof ProvisioningError ? err.status : undefined;

    // Not a retry, and deliberately not one: Vapi's pool does not refill
    // between two requests a second apart, and a loop here would spend
    // the deadline of a page an operator is watching to learn nothing.
    if (status === 400 && err instanceof Error && readsAsNoAvailability(err.message)) {
      throw new NoNumberInAreaCodeError(desired);
    }

    // A 4xx is Vapi refusing this request -- a bad body, a bad key, a
    // quota -- and a refused request never reached the pool, so the
    // error stands exactly as it came. Everything else happened to a
    // POST that allocates, with the outcome unread: a deadline, a 5xx,
    // a dropped connection, a body that would not parse. Whoever reports
    // those must not say a number was not issued.
    if (status !== undefined && status >= 400 && status < 500) throw err;
    throw new NumberOutcomeUnknownError(err instanceof Error ? err.message : String(err));
  }

  const number = toPhoneNumber(body);
  if (!number) {
    // Worth being loud about: a number may now exist and be billing,
    // with nothing on our side recording it. The Vapi dashboard is the
    // only place that can settle it -- which is this error's whole
    // subject, so it carries it rather than a second sentence bolted on
    // by a caller.
    throw new NumberOutcomeUnknownError(
      "Vapi reported a new number but returned a record this deployment could not read.",
    );
  }
  return number;
}
