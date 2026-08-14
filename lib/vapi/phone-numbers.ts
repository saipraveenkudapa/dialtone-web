import "server-only";

import { vapiRequest, type VapiRequestOptions } from "@/lib/vapi/provision";

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
 *  `provider: "vapi"` is the free-number path -- no Twilio account, no
 *  card, no area-code search. It spends one of the org's allowance
 *  slots. There is no undo worth the name, so every caller of this must
 *  have asked first. */
export async function createPhoneNumber(
  vapiKey: string,
  { assistantId, name }: { assistantId: string; name: string },
): Promise<VapiPhoneNumber> {
  const body = await vapiRequest(vapiKey, "POST", "/phone-number", {
    provider: "vapi",
    assistantId,
    name: label(name),
  });

  const number = toPhoneNumber(body);
  if (!number) {
    // Worth being loud about: a number may now exist and be billing,
    // with nothing on our side recording it. The Vapi dashboard is the
    // only place that can settle it.
    throw new Error(
      "Vapi reported a new number but returned a record this deployment could not read. Check " +
        "the Vapi dashboard before asking for another one -- one may already have been issued.",
    );
  }
  return number;
}
