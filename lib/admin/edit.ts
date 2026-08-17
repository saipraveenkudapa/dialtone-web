import "server-only";

import { currentPlatformAdmin } from "@/lib/admin/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizePhoneToE164 } from "@/lib/phone";
import { parseDollarsToCents, parsePercentToBasisPoints } from "@/lib/money";
import { WEEKDAYS } from "@/lib/provisioning/constants";
import {
  AssistantSecretWriteError,
  provisionAssistantForLocation,
} from "@/lib/provisioning/assistant";
import { LocationReadError } from "@/lib/provisioning/go-live";
import {
  ProvisioningError,
  findAssistantForLocation,
  getAssistant,
  tagAssistantForLocation,
  type VapiAssistant,
} from "@/lib/vapi/provision";
import type { DraftHours } from "@/lib/provisioning/draft";
import type { HoursRow } from "@/lib/agent/hours";
import type { LocationRow } from "@/lib/supabase/types";

/* Editing a restaurant that already exists, from the operator console.
 *
 * The product this backs: the owner phones the operator ("we're opening
 * an hour earlier on Tuesdays", "the carbonara is 24 now", "send the
 * transfers to my mobile"), and the operator makes the change while they
 * are still on the line. lib/provisioning/create-restaurant.ts writes a
 * restaurant once; this file changes one that is already answering the
 * phone, which is a different and sharper problem.
 *
 * THREE FACTS THIS FILE IS BUILT AROUND
 * -------------------------------------
 *
 * 1. MOST of this database is read live, per call. lib/agent/auth.ts's
 *    locationForSecret does `select("*")` on every single tool call, and
 *    app/api/agent/menu/route.ts and hours/route.ts query Postgres per
 *    call. So a price, a tax rate, a promise time, the seat count, the
 *    hours and the whole menu take effect on the NEXT CALL with nothing
 *    to rebuild. That is the product's central promise and this file
 *    keeps it by doing nothing clever: one UPDATE, and the phone is
 *    already right.
 *
 * 2. SIX columns are not. lib/vapi/provision.ts's buildAssistantPayload
 *    is a snapshot: it inlines the greeting into `firstMessage`, the
 *    system prompt (which interpolates the name twice, the address, the
 *    current time in the location's timezone, and the order types) into
 *    `model.messages`, and the fallback number into the native
 *    transferCall destination. None of it is re-read on a call -- there
 *    is no assistant-request hook in the payload. So editing
 *
 *        name, address, timezone, order_types, greeting_text,
 *        fallback_human_number
 *
 *    without re-pushing the assistant leaves the PHONE saying the old
 *    thing while this screen says the new one, silently, forever. Every
 *    save below that touches one of those re-syncs through the existing
 *    lib/provisioning/assistant.ts path and REPORTS WHAT HAPPENED. See
 *    SYNCED_COLUMNS and syncAssistant.
 *
 *    fallback_human_number and order_types are the dangerous pair,
 *    because they are baked AND read live -- so a stale assistant does
 *    not fail loudly, it disagrees with itself mid-call. The agent says
 *    "one moment" and the native transfer dials the old number.
 *
 * 3. A re-sync ROTATES THE TOOL SECRET, and it cannot not. Only the
 *    SHA-256 is stored (lib/agent/auth.ts), so the plaintext needed to
 *    rebuild the nine tool headers does not exist after provisioning;
 *    provisionAssistantForLocation mints a fresh one every run. That
 *    makes AssistantSecretWriteError -- Vapi accepted the rebuild, the
 *    hash write did not land, so the assistant answers and then 401s on
 *    every tool call -- a live possibility on an ordinary greeting edit
 *    rather than a provisioning-day edge case. It gets its own outcome
 *    and its own sentence, pointing at the go-live panel's repair.
 *
 * ORDER OF OPERATIONS: POSTGRES FIRST, VAPI SECOND
 * ------------------------------------------------
 * Deliberately the opposite of provisionAssistantForLocation's own
 * internal order, and for the mirror-image reason. The column is what
 * every live route reads. A failed rebuild after a successful write
 * leaves "screen and tools right, assistant prompt stale", which one
 * button repairs. The reverse leaves the assistant asserting something
 * no column says, with no clean rollback. So a failed re-sync NEVER
 * rolls the column back and NEVER reports plain success: it comes back
 * ok:true with `phone` naming the failure, and a message that says the
 * data is saved and the phone is not.
 *
 * AUTHORIZATION
 * -------------
 * Every exported mutation begins with currentPlatformAdmin(), before a
 * single argument is looked at. A "use server" export is a live HTTP
 * endpoint the moment it compiles -- an action id can be POSTed to
 * without ever loading /admin -- so the route not being drawn is not a
 * permission. The action layer checks too; this module holds the
 * service-role key, which bypasses RLS on every table for every tenant,
 * and it does not get to depend on its caller having remembered. That is
 * lib/provisioning/create-restaurant.ts's and go-live.ts's posture,
 * copied.
 *
 * WHAT MAY CROSS THE BROWSER BOUNDARY
 * -----------------------------------
 * Content, and selectors. Never an authorization.
 *
 *   * locationId is the only id that decides WHOSE data is touched, and
 *     it is uuid-shape-checked before it reaches PostgREST.
 *   * No org id, user id, membership, assistant id, tool secret,
 *     twilio number, timestamp or is_live flag is accepted from anywhere.
 *     The org row is found through the location's own org_id, read here.
 *   * A child row id (an hours row, a holiday, a category, a menu item)
 *     is a SELECTOR and proves nothing. Each one is proved to belong to
 *     this location by a read filtered on location_id BEFORE anything is
 *     written, and every write then carries `.eq("location_id", ...)`
 *     as well, so even a row that moved between the two cannot be
 *     redirected at another tenant.
 *   * menu_items.category_id is the sharpest of those. The
 *     app.sync_menu_item_location trigger re-derives location_id FROM
 *     THE CATEGORY, so an item moved into a category owned by another
 *     restaurant silently becomes that restaurant's item. The target
 *     category is proved to belong to this location first, server-side,
 *     every time.
 *
 * WHAT NEVER REACHES A LOG OR A RESPONSE
 * --------------------------------------
 * No PostgrestError text on any path -- location id and SQLSTATE only,
 * because these patches carry somebody's mobile number
 * (fallback_human_number, order_sms_to) and their email. No
 * agent_secret_hash and no stripe_customer_id in a response body:
 * getEditableRecord reports both as presence, never as value. A hash in
 * a response body is still a secret in a response body.
 */

/* ── results ───────────────────────────────────────────────────────── */

/** What happened to the assistant, as a fact the UI can render rather
 *  than a sentence it has to parse.
 *
 *  `state` is deliberately five values and not a boolean: "there was
 *  nothing to push" and "the push failed" are opposite things to tell an
 *  operator, and "the push worked but its secret did not save" is worse
 *  than either. */
export type PhoneSync =
  /** Nothing edited was baked into the assistant. The next call already
   *  reads the new value out of Postgres. */
  | { state: "not-needed" }
  /** This restaurant has never been provisioned, so there is nothing on
   *  the phone to update. The go-live panel builds it from these values. */
  | { state: "no-assistant" }
  /** Rebuilt. The screen and the phone agree. */
  | { state: "updated" }
  /** Saved here; the assistant still carries the old value. Recoverable
   *  by pressing resyncAssistant, with nothing to retype. */
  | { state: "failed"; reason: string }
  /** Vapi accepted the rebuild and saving its fresh tool secret did not
   *  land. The assistant will answer the phone and then be unable to
   *  read the menu, take an order or transfer. Repair on the go-live
   *  panel. */
  | { state: "secret-lost"; reason: string };

/** Every mutation in this file answers in exactly this shape.
 *
 *  `ok: true` means THE DATABASE WAS WRITTEN. It does not mean the phone
 *  agrees -- `phone` is the only authority on that, and a caller that
 *  renders the message and drops `phone` is rendering a half-truth. */
export type EditResult =
  | { ok: true; message: string; phone: PhoneSync }
  | { ok: false; error: string };

/** A pure validator's answer. Same shape and same discipline as
 *  lib/provisioning/draft.ts: no database, no network, no `server-only`
 *  behaviour, so the whole of "is this describable" is unit-testable
 *  without standing up Supabase. */
export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function bad<T>(error: string): Checked<T> {
  return { ok: false, error };
}

/* ── the pure validators ───────────────────────────────────────────── */

/* Every range below is read from the CHECK constraint that actually
   enforces it, not guessed:

     tax_rate_bps            between 0 and 2000     20260812000100
     seats                   > 0                    20260812000100
     reservation_slot_minutes between 30 and 240    20260812000100
     max_party_size          between 1 and 40       20260812000100
     order_types             in (pickup,delivery,both)
     pickup/delivery_promise_minutes between 5 and 180  20260812000600
     recording_retention_days between 1 and 365     20260807000100
     order_delivery          in (sms,email,both)    20260807000100
     plan                    in (trial,starter,growth)
     day_of_week             between 0 and 6        20260807000100
     hours                   is_closed or both times present
     price_cents             >= 0                   20260807000100

   The point of doing it here as well as in Postgres is the sentence: an
   operator on the phone to a restaurant gets "Sales tax must be between
   0% and 20%", not `new row violates check constraint
   "locations_tax_rate_bps_check"`. Where draft.ts already writes a
   sentence for the same rule, it is copied VERBATIM, so the words an
   operator reads creating a restaurant and editing one are the same. */

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Deliberately loose, exactly as draft.ts's is: this is not the
// validator that decides whether an address can receive mail. All it has
// to catch is a half-typed one.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A whole number from a string a human typed. Rejects "12.5", "" and
 *  "abc" rather than letting Number() coerce them into something the
 *  database constraint then rejects with a Postgres error nobody can
 *  read -- and rejects anything wider than nine digits, because int4
 *  overflow (SQLSTATE 22003) is the same unreadable failure by another
 *  route. */
function wholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** The RFC shape. Not /^[0-9a-f-]{36}$/i, which accepts thirty-six
 *  dashes and reaches PostgREST as a malformed uuid cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** Every IANA zone this runtime knows, for the timezone picker.
 *
 *  Empty only on a runtime without Intl.supportedValuesOf, in which case
 *  the UI must fall back to a hand-written list -- isValidTimezone below
 *  is still the authority either way. */
export const TIMEZONES: string[] = (() => {
  const supported = (
    Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  ).supportedValuesOf;
  if (typeof supported !== "function") return [];
  try {
    return supported.call(Intl, "timeZone");
  } catch {
    return [];
  }
})();

/** Is this a zone Intl can actually format in?
 *
 *  This is the single most important validation in the file and it is
 *  not obvious why. locations.timezone has NO check constraint, and
 *  every agent route hands it straight to Intl.DateTimeFormat -- hours,
 *  availability, order, reservation, cancel, change. Intl throws
 *  RangeError on an id it does not know, and no route under
 *  app/api/agent/ catches exceptions, so a typo does not become a
 *  validation error: it becomes a framework 500, which Vapi discards,
 *  which the caller hears as dead air. A timezone text box is a dead-air
 *  generator; this is why the UI must render a select.
 *
 *  Shape-checked before probing so that a UTC offset ("+05:30"), which
 *  some engines accept and which would silently detach this restaurant
 *  from its own daylight-saving rules, is refused. */
export function isValidTimezone(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(trimmed)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return true;
  } catch {
    return false;
  }
}

/* ── section 1: the business ───────────────────────────────────────── */

export type BusinessInput = {
  /** organizations.name -- the billing entity, NOT the name the agent
   *  speaks. Renaming one does not rename the other. */
  orgName: string;
  /** organizations.plan. Records what they are on; tells Stripe nothing. */
  plan: string;
  /** locations.name. Spoken by the agent, twice, from the baked prompt. */
  name: string;
  timezone: string;
  address: string;
  businessPhone: string;
  carrierName: string;
};

export type BusinessPatch = {
  orgName: string;
  plan: "trial" | "starter" | "growth";
  name: string;
  timezone: string;
  address: string | null;
  businessPhone: string | null;
  carrierName: string | null;
};

export function validateBusiness(input: BusinessInput): Checked<BusinessPatch> {
  const orgName = input.orgName.trim();
  if (!orgName) return bad("Enter the organization's name.");
  if (orgName.length > 120) return bad("That organization name is too long. Try something shorter.");

  const plan = input.plan.trim();
  if (plan !== "trial" && plan !== "starter" && plan !== "growth") {
    return bad("Choose trial, starter, or growth.");
  }

  const name = input.name.trim();
  if (!name) return bad("Enter the restaurant's name.");
  if (name.length > 120) return bad("That name is too long. Try something shorter.");

  const timezone = input.timezone.trim();
  if (!timezone) return bad("Choose a timezone.");
  if (!isValidTimezone(timezone)) {
    return bad(
      "That is not a timezone this system knows. Pick one from the list -- an unknown zone " +
        "makes the assistant fail mid-call rather than say the wrong time.",
    );
  }

  const addressRaw = input.address.trim();
  if (addressRaw.length > 300) return bad("That address is too long. Try something shorter.");
  // Null and "" are the same fact to buildSystemPrompt, which prints
  // "not on file" for both. Stored as null so the column has one way of
  // saying it.
  const address = addressRaw || null;

  const businessPhoneRaw = input.businessPhone.trim();
  let businessPhone: string | null = null;
  if (businessPhoneRaw) {
    businessPhone = normalizePhoneToE164(businessPhoneRaw);
    if (!businessPhone) {
      return bad("That display phone is not a number we can dial. Leave it blank or fix it.");
    }
  }

  const carrierRaw = input.carrierName.trim();
  if (carrierRaw.length > 80) return bad("That carrier name is too long. Try something shorter.");
  const carrierName = carrierRaw || null;

  return {
    ok: true,
    value: { orgName, plan, name, timezone, address, businessPhone, carrierName },
  };
}

/* ── section 2: answering the phone ────────────────────────────────── */

export type AnsweringInput = {
  greetingText: string;
  fallbackNumber: string;
};

export type AnsweringPatch = {
  greetingText: string;
  fallbackNumber: string;
};

/** Vapi speaks firstMessage verbatim and it is the first thing a caller
 *  hears; long enough to be a sentence or two, short enough that nobody
 *  pastes a menu into it. */
export const GREETING_MAX = 400;

export function validateAnswering(input: AnsweringInput): Checked<AnsweringPatch> {
  const greetingText = input.greetingText.trim();
  if (greetingText.length > GREETING_MAX) {
    return bad(`That greeting is too long -- keep it under ${GREETING_MAX} characters.`);
  }

  // Blank is refused rather than accepted, unlike every other optional
  // field here. This column is what catches an allergy question and a
  // catering call, and it is what the kill switch dials; emptying it
  // from an edit form turns those into "No transfer number is set up"
  // mid-call (app/api/agent/transfer/route.ts) and blocks go-live. An
  // operator changing a working restaurant's transfer number always has
  // the replacement in hand -- there is no reason to pass through
  // "none", and every reason not to offer it as a two-keystroke
  // accident.
  const fallbackNumber = normalizePhoneToE164(input.fallbackNumber);
  if (!fallbackNumber) {
    return bad(
      "Enter a valid fallback number, e.g. (510) 555-0100 -- this is where catering and " +
        "allergy calls get transferred, and where every call goes while the kill switch is on.",
    );
  }

  return { ok: true, value: { greetingText, fallbackNumber } };
}

/* ── section 3: money & service ────────────────────────────────────── */

export type ServiceInput = {
  /** Typed as a percentage, e.g. "8.75". Stored as whole basis points. */
  taxPercent: string;
  orderTypes: string;
  pickupPromiseMinutes: string;
  deliveryPromiseMinutes: string;
  seats: string;
  maxPartySize: string;
  reservationSlotMinutes: string;
};

export type ServicePatch = {
  taxRateBps: number;
  orderTypes: "pickup" | "delivery" | "both";
  pickupPromiseMinutes: number;
  deliveryPromiseMinutes: number;
  seats: number;
  maxPartySize: number;
  reservationSlotMinutes: number;
};

/** seats has no upper bound in the database -- `check (seats > 0)` and
 *  nothing else -- so this is the file's own ceiling, and it exists for
 *  a mechanical reason rather than a taste one: an int4 column takes
 *  2147483647, and a fat-fingered seat count that large is an
 *  availability sweep that never refuses a booking. */
export const SEATS_MAX = 100_000;

export function validateService(input: ServiceInput): Checked<ServicePatch> {
  const taxRateBps = parsePercentToBasisPoints(input.taxPercent.trim());
  if (taxRateBps === null) return bad("Enter the sales tax rate as a plain percentage, e.g. 8.75.");
  if (taxRateBps < 0 || taxRateBps > 2000) return bad("Sales tax must be between 0% and 20%.");

  const orderTypes = input.orderTypes.trim();
  if (orderTypes !== "pickup" && orderTypes !== "delivery" && orderTypes !== "both") {
    return bad("Choose pickup, delivery, or both.");
  }

  const pickupPromiseMinutes = wholeNumber(input.pickupPromiseMinutes);
  if (pickupPromiseMinutes === null || pickupPromiseMinutes < 5 || pickupPromiseMinutes > 180) {
    return bad("Pickup promise time must be between 5 and 180 minutes.");
  }

  const deliveryPromiseMinutes = wholeNumber(input.deliveryPromiseMinutes);
  if (deliveryPromiseMinutes === null || deliveryPromiseMinutes < 5 || deliveryPromiseMinutes > 180) {
    return bad("Delivery promise time must be between 5 and 180 minutes.");
  }

  const seats = wholeNumber(input.seats);
  if (seats === null || seats < 1) return bad("Seats must be a whole number greater than 0.");
  if (seats > SEATS_MAX) {
    return bad(
      `That is more than ${SEATS_MAX.toLocaleString("en-US")} seats -- check the number. A seat ` +
        "count this large means the assistant never refuses a booking.",
    );
  }

  const maxPartySize = wholeNumber(input.maxPartySize);
  if (maxPartySize === null || maxPartySize < 1 || maxPartySize > 40) {
    return bad("Max party size must be between 1 and 40.");
  }

  const reservationSlotMinutes = wholeNumber(input.reservationSlotMinutes);
  if (reservationSlotMinutes === null || reservationSlotMinutes < 30 || reservationSlotMinutes > 240) {
    return bad("Reservation length must be between 30 and 240 minutes.");
  }

  return {
    ok: true,
    value: {
      taxRateBps,
      orderTypes,
      pickupPromiseMinutes,
      deliveryPromiseMinutes,
      seats,
      maxPartySize,
      reservationSlotMinutes,
    },
  };
}

/* ── section 4: where orders go ────────────────────────────────────── */

export type OrderRoutingInput = {
  orderDelivery: string;
  orderSmsTo: string;
  orderEmailTo: string;
};

export type OrderRoutingPatch = {
  orderDelivery: "sms" | "email" | "both";
  orderSmsTo: string | null;
  orderEmailTo: string | null;
};

export function validateOrderRouting(input: OrderRoutingInput): Checked<OrderRoutingPatch> {
  const orderDelivery = input.orderDelivery.trim();
  if (orderDelivery !== "sms" && orderDelivery !== "email" && orderDelivery !== "both") {
    return bad("Choose text, email, or both.");
  }

  // The single most consequential un-validated column in the schema.
  // lib/agent/notify.ts hands this straight to Twilio as `To`; anything
  // that is not E.164 is rejected, sendOrderSms returns false,
  // staff_notified comes back false, and every order ends with the agent
  // saying "let me have someone confirm that" instead of goodbye. It
  // fails quietly into a degraded call, never loudly, which is exactly
  // why it is normalized here and refused rather than stored as typed.
  const smsRaw = input.orderSmsTo.trim();
  let orderSmsTo: string | null = null;
  if (smsRaw) {
    orderSmsTo = normalizePhoneToE164(smsRaw);
    if (!orderSmsTo) {
      return bad(
        "That kitchen text number is not a number we can send to. Fix it, or clear it -- a " +
          "number Twilio rejects means no ticket reaches the kitchen and nothing says so.",
      );
    }
  }

  const emailRaw = input.orderEmailTo.trim();
  let orderEmailTo: string | null = null;
  if (emailRaw) {
    if (!EMAIL.test(emailRaw)) return bad("That kitchen email does not look like an email address.");
    if (emailRaw.length > 200) return bad("That kitchen email is too long.");
    orderEmailTo = emailRaw.toLowerCase();
  }

  return { ok: true, value: { orderDelivery, orderSmsTo, orderEmailTo } };
}

/* ── section 5: recording & retention ──────────────────────────────── */

export type RecordingInput = {
  recordingEnabled: boolean;
  recordingRetentionDays: string;
};

export type RecordingPatch = {
  recordingEnabled: boolean;
  recordingRetentionDays: number;
};

export function validateRecording(input: RecordingInput): Checked<RecordingPatch> {
  const recordingRetentionDays = wholeNumber(input.recordingRetentionDays);
  if (
    recordingRetentionDays === null ||
    recordingRetentionDays < 1 ||
    recordingRetentionDays > 365
  ) {
    return bad("Keep recordings for between 1 and 365 days.");
  }
  return {
    ok: true,
    value: { recordingEnabled: input.recordingEnabled, recordingRetentionDays },
  };
}

/* ── section 6: hours ──────────────────────────────────────────────── */

/** Exactly what the form sends, and exactly what /admin/new's form
 *  sends -- the same seven rows, so one shape and one set of sentences
 *  serve creating and editing. */
export type HoursInput = DraftHours[];

export type HoursPatchRow = {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean;
};

/** All seven days, or nothing.
 *
 *  A missing weekday row is not a gap, it is a closed day:
 *  lib/agent/hours.ts's hoursOnDate defaults to `is_closed: true`, so a
 *  restaurant that loses its Tuesday row is told to callers as shut all
 *  Tuesday. The seven are therefore written together, in one statement,
 *  and this refuses anything short of seven.
 *
 *  `close > open` is enforced HERE and only here. There is no such
 *  constraint in the schema, and the consequence of letting one through
 *  is worse than a bad row: openAt returns
 *  {state:"unknown", reason:"crosses_midnight"}, and every agent route
 *  deliberately lets `unknown` through as OPEN -- so a restaurant with
 *  a 22:00-02:00 row becomes one that takes orders at three in the
 *  morning, with nothing anywhere reporting an error. */
export function validateHours(rows: HoursInput): Checked<HoursPatchRow[]> {
  if (rows.length !== 7) return bad("Set hours for all seven days.");

  const out: HoursPatchRow[] = [];
  for (let day = 0; day < 7; day++) {
    const row = rows.find((h) => h.dayOfWeek === day);
    if (!row) return bad(`Set hours for ${WEEKDAYS[day]}, or mark it closed.`);

    if (row.closed) {
      out.push({ day_of_week: day, open_time: null, close_time: null, is_closed: true });
      continue;
    }

    const open = row.open.trim();
    const close = row.close.trim();
    if (!TIME.test(open) || !TIME.test(close)) {
      return bad(`Set both an open and a close time for ${WEEKDAYS[day]}, or mark it closed.`);
    }
    if (close <= open) {
      return bad(
        `${WEEKDAYS[day]}'s close time must be after its open time. Hours that cross midnight ` +
          "are not supported yet -- use the latest closing time this system can represent for now.",
      );
    }
    out.push({ day_of_week: day, open_time: open, close_time: close, is_closed: false });
  }

  return { ok: true, value: out };
}

/** The seven days as one comparable string.
 *
 *  The week's answer to locations.updated_at. `hours` carries no
 *  timestamp of its own and the grid writes all seven rows in one
 *  upsert, so without this a tab that was opened before somebody else
 *  changed Tuesday puts the old Tuesday back -- silently, and live on
 *  the next call, because hours are read per call.
 *
 *  A missing row is part of the signature (`none`, not "closed"): a
 *  weekday with no row is read by lib/agent/hours.ts as shut all day,
 *  which is a different fact from a row that says closed, and one of
 *  them appearing is exactly the kind of change a stale tab must not
 *  overwrite. Times are cut to HH:MM because Postgres hands a `time`
 *  back as "09:00:00" and the form holds "09:00". */
export function hoursSignature(
  rows: {
    day_of_week: number;
    open_time: string | null;
    close_time: string | null;
    is_closed: boolean;
  }[],
): string {
  const cut = (value: string | null) => (value ? value.slice(0, 5) : "");
  return [0, 1, 2, 3, 4, 5, 6]
    .map((day) => {
      const row = rows.find((r) => r.day_of_week === day);
      if (!row) return `${day}:none`;
      return row.is_closed
        ? `${day}:closed`
        : `${day}:${cut(row.open_time)}-${cut(row.close_time)}`;
    })
    .join("|");
}

/* ── section 7: holidays and one-off closures ──────────────────────── */

export type HolidayInput = {
  /** The date the override applies to, "YYYY-MM-DD". */
  date: string;
  closed: boolean;
  /** "HH:MM". Ignored when closed. */
  open: string;
  close: string;
};

export type HolidayPatch = {
  date: string;
  is_closed: boolean;
  open_time: string | null;
  close_time: string | null;
};

/** holiday_hours has NO check constraints beyond its unique date -- not
 *  even the "an open day needs both ends" rule that `hours` carries. So
 *  the two hazards below are refused here or nowhere:
 *
 *    * is_closed = false with no times. openAt then returns
 *      unknown/no_hours_configured, which every route treats as open. A
 *      "we close early on Christmas Eve" row entered wrong becomes "open
 *      24 hours on Christmas Eve".
 *    * close <= open, which is the crosses_midnight trapdoor again.
 *
 *  The date is checked against the calendar, not just the shape: "2026-
 *  02-30" passes /^\d{4}-\d{2}-\d{2}$/ and is refused by Postgres with a
 *  sentence nobody can read. */
export function validateHoliday(input: HolidayInput): Checked<HolidayPatch> {
  const date = input.date.trim();
  if (!DATE.test(date)) return bad("Enter the date as YYYY-MM-DD.");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    return bad("That is not a real date.");
  }

  if (input.closed) {
    return { ok: true, value: { date, is_closed: true, open_time: null, close_time: null } };
  }

  const open = input.open.trim();
  const close = input.close.trim();
  if (!TIME.test(open) || !TIME.test(close)) {
    return bad(
      "Set both an open and a close time for that date, or mark it closed. A date with neither " +
        "reads as open all day, not as closed.",
    );
  }
  if (close <= open) {
    return bad(
      "That date's close time must be after its open time. Hours that cross midnight are not " +
        "supported yet -- use the latest closing time this system can represent for now.",
    );
  }

  return { ok: true, value: { date, is_closed: false, open_time: open, close_time: close } };
}

/* ── section 8: the menu ───────────────────────────────────────────── */

export type CategoryInput = {
  name: string;
  sortOrder: string;
};

export type CategoryPatch = {
  name: string;
  sort_order: number;
};

/** sort_order has no constraint either; this ceiling only keeps an int4
 *  overflow out of the write path. Ties are resolved by nothing, so two
 *  categories on the same number are read out in a different order on
 *  different calls -- the UI should hand out distinct numbers. */
export const SORT_ORDER_MAX = 9_999;

export function validateCategory(input: CategoryInput): Checked<CategoryPatch> {
  const name = input.name.trim();
  if (!name) return bad("Every menu category needs a name.");
  if (name.length > 80) return bad(`The category name "${name.slice(0, 20)}…" is too long.`);

  const sortOrder = wholeNumber(input.sortOrder);
  if (sortOrder === null || sortOrder > SORT_ORDER_MAX) {
    return bad(`Sort order must be a whole number between 0 and ${SORT_ORDER_MAX}.`);
  }

  return { ok: true, value: { name, sort_order: sortOrder } };
}

export type MenuItemInput = {
  /** The category this item sits in. A selector -- proved to belong to
   *  this location, server-side, before anything is written. */
  categoryId: string;
  name: string;
  description: string;
  /** Typed in dollars, e.g. "22.00". Stored as whole cents. */
  priceDollars: string;
  allergenNote: string;
  sortOrder: string;
  /** "" | "reopen" | "close". */
  soldOutUntil: string;
  /** The restaurant nominated this dish. At most three per location,
   *  refused by a database trigger rather than by this form. */
  staffPick: boolean;
};

export type MenuItemPatch = {
  category_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  allergen_note: string | null;
  sort_order: number;
  sold_out_until: "reopen" | "close" | null;
  is_staff_pick: boolean;
};

export function validateSoldOut(raw: string): Checked<"reopen" | "close" | null> {
  const value = raw.trim();
  if (value === "") return { ok: true, value: null };
  if (value === "reopen" || value === "close") return { ok: true, value };
  return bad("Sold out until must be “when we restock” or “end of service”.");
}

export function validateMenuItem(input: MenuItemInput): Checked<MenuItemPatch> {
  if (!UUID.test(input.categoryId.trim())) return bad("Choose a category for this item.");
  const categoryId = input.categoryId.trim();

  const name = input.name.trim();
  if (!name) return bad("Every menu item needs a name.");
  if (name.length > 120) return bad(`The item name "${name.slice(0, 20)}…" is too long.`);

  // Read ALOUD to callers as what the dish comes with (lib/agent/menu.ts
  // sends it as `ingredients`), so a wrong one is a spoken falsehood
  // about food, not a cosmetic slip.
  const descriptionRaw = input.description.trim();
  if (descriptionRaw.length > 500) return bad(`The description on "${name}" is too long.`);
  const description = descriptionRaw || null;

  const price_cents = parseDollarsToCents(input.priceDollars.trim());
  if (price_cents === null) {
    return bad(
      `"${input.priceDollars.trim()}" is not a plain dollar amount with at most two decimal ` +
        `places -- fix the price on "${name}", e.g. "12.99".`,
    );
  }

  // Reference for staff only. lib/agent/menu.ts deliberately leaves this
  // out of the agent's payload: an allergy question is transferred to a
  // person, never answered from a column.
  const allergenRaw = input.allergenNote.trim();
  if (allergenRaw.length > 300) return bad(`The allergen note on "${name}" is too long.`);
  const allergen_note = allergenRaw || null;

  const sort_order = wholeNumber(input.sortOrder);
  if (sort_order === null || sort_order > SORT_ORDER_MAX) {
    return bad(`Sort order must be a whole number between 0 and ${SORT_ORDER_MAX}.`);
  }

  const soldOut = validateSoldOut(input.soldOutUntil);
  if (!soldOut.ok) return bad(soldOut.error);

  return {
    ok: true,
    value: {
      category_id: categoryId,
      name,
      description,
      price_cents,
      allergen_note,
      sort_order,
      sold_out_until: soldOut.value,
      // Already a boolean -- nothing to coerce. The cap itself is
      // enforced by menu_items_staff_pick_cap (SQLSTATE 23514), not
      // here: this form only carries the operator's intent.
      is_staff_pick: input.staffPick,
    },
  };
}

/** The same flattening lib/agent/orders.ts's matchItem does before it
 *  compares a spoken name to a menu row. Duplicated rather than imported
 *  because that one is module-private; if it changes, this must.
 *
 *  Why the editor cares: two rows whose names normalise the same make
 *  `exact.length > 1` permanently, so every caller who says that dish
 *  gets `ambiguous_item` and the agent reads back two identical names --
 *  a question the caller cannot answer. A duplicate is refused here
 *  because there is nowhere later it can be. */
export function normaliseItemName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/* ── which columns are baked into the assistant ────────────────────── */

/** The six. Traced through lib/vapi/provision.ts's buildAssistantPayload
 *  and lib/agent/prompt.ts, not guessed:
 *
 *    greeting_text          -> firstMessage (buildGreeting; falls back to
 *                              a line built from `name`)
 *    name                   -> {{business_name}}, twice, in the system
 *                              prompt, and the greeting fallback
 *    address                -> {{address}}
 *    timezone               -> {{current_datetime}}, which is no longer a
 *                              date but the Liquid template Vapi renders
 *                              per call -- the zone name is interpolated
 *                              INTO that template, so this column is
 *                              still baked into the prompt and still
 *                              needs a push when it changes
 *    order_types            -> {{takeout_delivery_settings}}
 *    fallback_human_number  -> nativeTransferTool's destination number
 *
 *  Nothing else in SYSTEM_PROMPT_TEMPLATE is interpolated. In
 *  particular the menu, the tax rate, the promise minutes, the seat
 *  count, the slot length and the max party size are NOT here: every one
 *  of those is queried from Postgres inside the call, so they land on
 *  the next call with nothing to push.
 *
 *  `hours` was the near miss, and is not one any more. The prompt used
 *  to carry {{hours_today}}, a frozen snapshot of the day the assistant
 *  was built; that line is gone, replaced by an instruction to call
 *  get_hours, and app/api/agent/hours/route.ts queries Postgres (with
 *  holiday_hours) per call. So an hours edit takes effect on the next
 *  call and does NOT drag a rebuild along with it -- there is now no
 *  stale copy of the hours anywhere to refresh, at any price, let alone
 *  at the cost of rotating the tool secret. saveHours therefore returns
 *  phone: "not-needed", and the UI must say the edit is live rather than
 *  claim a push it did not do. */
export const SYNCED_COLUMNS = [
  "name",
  "address",
  "timezone",
  "order_types",
  "greeting_text",
  "fallback_human_number",
] as const;

export type SyncedColumn = (typeof SYNCED_COLUMNS)[number];

/** Does this patch touch anything the phone carries a copy of? */
export function touchesAssistant(patch: Record<string, unknown>): boolean {
  return SYNCED_COLUMNS.some((column) => column in patch);
}

/* ── the gate, and the reads behind it ─────────────────────────────── */

/* Byte-identical to create-restaurant.ts's and go-live.ts's refusal. A
   non-admin, a malformed id and a location that does not exist are told
   apart by nobody. */
const NOT_FOUND_TEXT = "Not found.";
const NOT_FOUND: EditResult = { ok: false, error: NOT_FOUND_TEXT };

const WRITE_FAILED = "That did not save. Nothing was changed.";

/** Staff, and a location id that could be one. Returns the refusal to
 *  hand back, or null to proceed. Nothing observable happens on the
 *  refusing path: no service-role client, no Vapi request, no log line
 *  that could confirm a location exists. */
async function gate(locationId: string): Promise<EditResult | null> {
  const admin = await currentPlatformAdmin();
  if (!admin) return NOT_FOUND;
  if (!UUID.test(locationId)) return NOT_FOUND;
  return null;
}

/** A refusal that reports the sentence a pure validator wrote, plus the
 *  one fact the validator cannot know. */
function refuse(error: string): EditResult {
  return { ok: false, error: `${error} Nothing was saved.` };
}

function ok(message: string, phone: PhoneSync = { state: "not-needed" }): EditResult {
  return { ok: true, message, phone };
}

async function loadLocation(locationId: string): Promise<LocationRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("locations")
    .select("*")
    .eq("id", locationId)
    .maybeSingle();

  if (error) {
    console.error("[admin-edit] could not read the location", { locationId, code: error.code });
    throw new LocationReadError();
  }
  return (data as LocationRow | null) ?? null;
}

/** The row, for a mutation. "There is no such restaurant" and "the
 *  database would not answer" are different facts and neither is an
 *  exception a server action may throw at a browser. */
async function rowForWrite(
  locationId: string,
): Promise<{ row: LocationRow } | { refusal: EditResult }> {
  try {
    const row = await loadLocation(locationId);
    return row ? { row } : { refusal: NOT_FOUND };
  } catch (err) {
    if (err instanceof LocationReadError) {
      return { refusal: { ok: false, error: `${err.message} Nothing was changed.` } };
    }
    throw err;
  }
}

/** Prove a child row belongs to this restaurant.
 *
 *  This is the whole cross-tenant defence for hours rows, holidays,
 *  categories and menu items, and it is a fresh read filtered on
 *  location_id rather than anything the browser was handed. Posting
 *  another restaurant's menu item id at this restaurant's editor fails
 *  here, before any statement that could change it is built.
 *
 *  "unreadable" is deliberately not "no": a select that failed is not
 *  evidence the row belongs to somebody else, and it must refuse without
 *  claiming it. */
async function ownedByLocation(
  table: "hours" | "holiday_hours" | "menu_categories" | "menu_items",
  id: string,
  locationId: string,
): Promise<"yes" | "no" | "unreadable"> {
  if (!UUID.test(id)) return "no";

  const { data, error } = await supabaseAdmin()
    .from(table)
    .select("id")
    .eq("id", id)
    .eq("location_id", locationId)
    .maybeSingle();

  if (error) {
    console.error("[admin-edit] ownership read failed", { locationId, table, code: error.code });
    return "unreadable";
  }
  return data ? "yes" : "no";
}

/** The refusal for a child id that is not this restaurant's.
 *
 *  Same sentence for "no such row" and "somebody else's row", for the
 *  same reason the gate uses one sentence: an operator poking at ids
 *  must not be able to learn which of the two it was. */
const NO_SUCH_ROW = "That is not on this restaurant's record any more. Reload the page.";
const OWNERSHIP_UNREADABLE =
  "Could not confirm that row belongs to this restaurant, so nothing was changed. Try again.";

/** The item, proved to be this restaurant's, with the one column a
 *  caller needs to know before it decides what to check: its name. Same
 *  read and same refusals as requireOwned -- a select filtered on
 *  location_id, and one sentence for "no such row" and "somebody else's
 *  row" alike. */
async function ownedMenuItem(
  itemId: string,
  locationId: string,
): Promise<{ row: { id: string; name: string } } | { refusal: EditResult }> {
  if (!UUID.test(itemId)) return { refusal: { ok: false, error: NO_SUCH_ROW } };

  const { data, error } = await supabaseAdmin()
    .from("menu_items")
    .select("id, name")
    .eq("id", itemId)
    .eq("location_id", locationId)
    .maybeSingle();

  if (error) {
    console.error("[admin-edit] ownership read failed", {
      locationId,
      table: "menu_items",
      code: error.code,
    });
    return { refusal: { ok: false, error: OWNERSHIP_UNREADABLE } };
  }
  if (!data) return { refusal: { ok: false, error: NO_SUCH_ROW } };
  return { row: data as { id: string; name: string } };
}

async function requireOwned(
  table: "hours" | "holiday_hours" | "menu_categories" | "menu_items",
  id: string,
  locationId: string,
): Promise<EditResult | null> {
  const owned = await ownedByLocation(table, id, locationId);
  if (owned === "yes") return null;
  return owned === "no"
    ? { ok: false, error: NO_SUCH_ROW }
    : { ok: false, error: OWNERSHIP_UNREADABLE };
}

/* ── the writes ────────────────────────────────────────────────────── */

/** What a location write did, and the two ways it can fail. `tail` is
 *  the same fact worded to follow a sentence that has already reported
 *  something else landing -- see the companion in saveLocationSection. */
type LocationWrite = { ok: true } | { ok: false; error: string; tail: string };

/** Somebody else moved this restaurant between the render this form was
 *  seeded from and this click.
 *
 *  Not a hypothetical: the whole premise of this console is several
 *  operators editing restaurants that are already answering the phone,
 *  and a section submits every one of its columns, not just the one that
 *  was typed in. Without this guard a stale tab silently reverts a
 *  column it never touched -- and if that column is one of the six, the
 *  revert is BAKED INTO THE ASSISTANT by the rebuild that follows. */
const STALE =
  "This restaurant changed while this page was open — another operator, or another card on this " +
  "page — so this save would have put that change back. Reload the page and make the change " +
  "again. Nothing was saved.";
const STALE_TAIL =
  "this restaurant changed while this page was open, so it would have put that change back. " +
  "Reload the page and try again.";
const WRITE_FAILED_TAIL = "the write was refused, so nothing else changed.";

/** One row, one patch, one message. Every location write lands through
 *  here so a failed one reads the same way whichever column it was, and
 *  so the log line is the same shape everywhere: the location id and the
 *  SQLSTATE, never the patch. fallback_human_number and order_sms_to are
 *  somebody's personal number and have no business in a log.
 *
 *  `seenUpdatedAt` is the value of locations.updated_at the form that is
 *  saving was rendered from, and the write carries it as a filter. The
 *  locations_touch trigger sets updated_at on every update, so a row
 *  that moved since matches nothing and the statement applies to ZERO
 *  rows rather than overwriting the other operator's work. Compare-and-
 *  set, in one statement, with no lock to hold and nothing to reconcile:
 *  changedColumns says what to write, this says whether it may. */
async function updateLocation(
  locationId: string,
  patch: Record<string, unknown>,
  seenUpdatedAt: string,
): Promise<LocationWrite> {
  if (typeof seenUpdatedAt !== "string" || seenUpdatedAt.trim() === "") {
    return { ok: false, error: STALE, tail: STALE_TAIL };
  }

  const { data, error } = await supabaseAdmin()
    .from("locations")
    .update(patch)
    .eq("id", locationId)
    .eq("updated_at", seenUpdatedAt)
    // Returned so "how many rows did that touch" is a fact rather than
    // an assumption. Zero is the whole point of the filter above.
    .select("id");

  if (error) {
    console.error("[admin-edit] locations update failed", {
      locationId,
      code: error.code,
      columns: Object.keys(patch),
    });
    return { ok: false, error: WRITE_FAILED, tail: WRITE_FAILED_TAIL };
  }
  if (!data || data.length === 0) {
    return { ok: false, error: STALE, tail: STALE_TAIL };
  }
  return { ok: true };
}

/** Only the columns that actually differ.
 *
 *  Two reasons, and the second is the important one. It keeps a save
 *  that changed the tax rate from rotating the tool secret because
 *  `name` was re-submitted unchanged; and it makes "nothing was
 *  changed" literally true rather than approximately, which is what the
 *  tests on a refused write assert. */
function changedColumns<T extends Record<string, unknown>>(
  current: Record<string, unknown>,
  next: T,
): Partial<T> {
  const patch: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(next)) {
    if (current[column] !== value) patch[column] = value;
  }
  return patch as Partial<T>;
}

/* ── pushing an edit to the phone ──────────────────────────────────── */

const NO_KEY =
  "This deployment has no VAPI_PRIVATE_KEY set, so the assistant could not be rebuilt.";

/** This deployment's own public origin, from server-side configuration.
 *
 *  Every one of the assistant's nine tools carries a `server.url` built
 *  from this, and a rebuild rewrites all nine. So it decides where a
 *  live restaurant's agent sends get_menu, place_order and transfer for
 *  as long as that assistant answers the phone -- which is why it may
 *  NOT come from the request.
 *
 *  The Origin header is whatever host the operator happened to have the
 *  console open on: a Vercel preview build, a staging domain, an old
 *  custom domain, or any value on a hand-rolled POST. Trusting it makes
 *  an ordinary greeting edit silently repoint a paying restaurant's
 *  tools at a deployment that is not serving it, and the only symptom is
 *  orders that stop arriving. Provisioning a restaurant once from the
 *  request's origin was already a risk; this screen makes the act a
 *  routine one, so it is closed here.
 *
 *  TWILIO_WEBHOOK_BASE_URL is the fallback rather than a new required
 *  variable because it is already this deployment's canonical public
 *  base -- the one Twilio signs against, so it is set wherever webhooks
 *  work at all. DIALTONE_PUBLIC_ORIGIN overrides it for a deployment
 *  where the two genuinely differ. */
export function configuredOrigin(): string | null {
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const raw =
    process.env.DIALTONE_PUBLIC_ORIGIN ||
    process.env.TWILIO_WEBHOOK_BASE_URL ||
    (vercel ? `https://${vercel}` : "");
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Vapi has nothing for this restaurant at all. Building one is the
 *  go-live panel's act, not an edit's: it is the only path that also
 *  points the phone number at what it built. */
const ASSISTANT_GONE =
  "Vapi has no assistant for this restaurant any more, so there was nothing to rebuild — this " +
  "record names one Vapi does not have. Repair it on the go-live panel, which builds one and " +
  "points the number at it.";

/** Two candidates, and this screen must not guess. Reconnecting the
 *  record to the assistant Vapi actually holds is go-live's repair, and
 *  it does it without touching Vapi or the tool secret. */
const TWO_ASSISTANTS =
  "Vapi has an assistant tagged for this restaurant that is not the one this record names, so a " +
  "rebuild from here could push to the one the phone number is not using and take the other off " +
  "the air. Nothing was pushed — reconnect them on the go-live panel first.";

/** provisionAssistantForLocation built a SECOND assistant rather than
 *  updating the one on file. The guards above make this unreachable; it
 *  is reported rather than trusted because the cost of being wrong is a
 *  live restaurant whose number still rings an assistant whose secret
 *  has just been rotated away from it. */
const SECOND_ASSISTANT =
  "Vapi built a second assistant instead of updating the one on file, so this restaurant's " +
  "number may still be pointed at the old one — which can no longer authenticate a single tool " +
  "call. Repair this restaurant on the go-live panel before it takes another call.";

const NO_ORIGIN_CONFIGURED =
  "This deployment does not say what its own public address is, so the assistant's nine tools " +
  "would have nowhere to call back to. Set DIALTONE_PUBLIC_ORIGIN (or TWILIO_WEBHOOK_BASE_URL) " +
  "before pushing anything to a phone.";

/** Vapi's error as one finished sentence. Never carries the key --
 *  ProvisioningError names the variable, never its value. */
function vapiSentence(err: unknown): string {
  const raw =
    err instanceof ProvisioningError || err instanceof Error
      ? err.message
      : "Vapi could not be reached.";
  return /[.!?]$/.test(raw) ? raw : `${raw}.`;
}

/** Rebuild this restaurant's assistant from the row as it stands NOW.
 *
 *  Runs after the write, never before, and never rolls it back. Uses the
 *  one existing push primitive: provisionAssistantForLocation, which
 *  PATCHes the assistant Vapi already has tagged for this location --
 *  system prompt, greeting, tools and all -- and only creates one when
 *  there is none. go-live.ts's repairAssistant is NOT that primitive: it
 *  returns "nothing to repair" and pushes nothing when the record is
 *  healthy, which is precisely the state every edit is made from.
 *
 *  It mints a fresh tool secret each run, unavoidably: only the SHA-256
 *  is stored, so the plaintext the nine tool headers need does not exist
 *  afterwards. That is why "secret-lost" is a real outcome here.
 *
 *  And it is only allowed to push at an assistant that is BOTH tagged
 *  for this location and the one this record names. upsertAssistant
 *  builds a new assistant when its search comes back empty, which is
 *  right on provisioning day and is how an ordinary greeting edit could
 *  otherwise take a live restaurant off the air -- see the long note in
 *  the body. Anything ambiguous is a "failed" pointing at the go-live
 *  panel, which is the only place that also re-points the phone number.
 *
 *  Never throws. Every failure is a PhoneSync the caller reports. */
async function syncAssistant(location: LocationRow, base: string): Promise<PhoneSync> {
  if (!location.vapi_assistant_id) return { state: "no-assistant" };

  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    console.error("[admin-edit] VAPI_PRIVATE_KEY is not configured");
    return { state: "failed", reason: NO_KEY };
  }

  if (!location.fallback_human_number) {
    return {
      state: "failed",
      reason:
        "This restaurant has no fallback number, so its assistant has nowhere to transfer a " +
        "catering or allergy call and cannot be rebuilt.",
    };
  }

  // Every tool's server.url is rebuilt from this, and a wrong one fails
  // silently -- as an agent that mysteriously refuses to take an order,
  // months later. Same rule runRepair applies, for the same reason. The
  // value is the deployment's OWN configured address; `base` is only the
  // host the operator happens to be looking at, and it is checked
  // against it rather than used as it.
  const configured = configuredOrigin();
  if (!configured) {
    console.error("[admin-edit] no public origin is configured", { locationId: location.id });
    return { state: "failed", reason: NO_ORIGIN_CONFIGURED };
  }

  let asked: string | null = null;
  if (base) {
    try {
      asked = new URL(base).origin;
    } catch {
      asked = base;
    }
    if (asked !== configured) {
      // Not a refusal about permissions -- it is a refusal to rebuild a
      // live restaurant's tool URLs from a console whose own address is
      // not the one this deployment serves callers from.
      return {
        state: "failed",
        reason:
          `This console is open on ${asked}, but this deployment answers callers at ` +
          `${configured}. Rebuilding from here would point this restaurant's tools at the wrong ` +
          "server, so nothing was pushed. Open the console on the deployment itself and save " +
          "again.",
      };
    }
  }

  const origin = new URL(configured);
  if (origin.protocol !== "https:" || /^(localhost|127\.|\[?::1)/.test(origin.hostname)) {
    return {
      state: "failed",
      reason:
        `The assistant cannot be rebuilt from ${origin.origin} — Vapi has to be able to reach ` +
        "the tools over https from the internet.",
    };
  }

  /* WHICH assistant this rebuild is going to land on, decided before it
   * is pushed rather than by upsertAssistant's own fallback.
   *
   * provisionAssistantForLocation -> upsertAssistant looks the assistant
   * up by metadata.dialtone_location_id and CREATES ONE when the search
   * comes back empty. That is right on provisioning day and wrong here.
   * An assistant that was cloned, restored or edited in the Vapi
   * dashboard loses the tag while carrying on answering the phone (see
   * getAssistant's own header) -- and on that restaurant a greeting edit
   * would POST a second assistant, move vapi_assistant_id and
   * agent_secret_hash onto it, and leave the phone NUMBER bound to the
   * first. The first keeps answering with a secret whose hash no longer
   * exists, so lib/agent/auth.ts 401s all nine tools: the agent greets
   * the caller and can then neither read the menu, take an order, nor
   * transfer. Nothing on either screen would say so.
   *
   * go-live.ts's runRepair guards the identical primitive the identical
   * way, and this is that guard, minus the parts only provisioning
   * needs. */
  let tagged: VapiAssistant | null;
  try {
    tagged = await findAssistantForLocation(vapiKey, location.id);
  } catch (err) {
    return { state: "failed", reason: vapiSentence(err) };
  }

  if (!tagged) {
    // Nothing carries the tag. Before treating that as "build one", ask
    // whether the assistant this record NAMES is simply untagged -- the
    // difference between a PATCH of one metadata key and a second
    // assistant built on top of a live one.
    let named: VapiAssistant | null;
    try {
      named = await getAssistant(vapiKey, location.vapi_assistant_id);
    } catch (err) {
      // Could not ask is not evidence of absence, and absence is what
      // would send this down the build-a-new-one path.
      return { state: "failed", reason: vapiSentence(err) };
    }
    if (!named) return { state: "failed", reason: ASSISTANT_GONE };
    try {
      await tagAssistantForLocation(vapiKey, named, location.id);
    } catch (err) {
      return { state: "failed", reason: vapiSentence(err) };
    }
  } else if (tagged.id !== location.vapi_assistant_id) {
    // Vapi holds a tagged assistant that is not the one this record
    // names, so a push here would rebuild an assistant the phone number
    // may not be pointed at -- and rotate the secret out from under the
    // one that is. Reconnecting the two is the go-live panel's job and
    // it does it without touching Vapi.
    return { state: "failed", reason: TWO_ASSISTANTS };
  }

  const { data: hoursData, error: hoursError } = await supabaseAdmin()
    .from("hours")
    .select("day_of_week, open_time, close_time, is_closed")
    .eq("location_id", location.id);

  if (hoursError) {
    console.error("[admin-edit] could not read the hours for a rebuild", {
      locationId: location.id,
      code: hoursError.code,
    });
    return { state: "failed", reason: "This restaurant's hours could not be read." };
  }

  let created = false;
  try {
    ({ created } = await provisionAssistantForLocation({
      location,
      hours: (hoursData ?? []) as HoursRow[],
      base: origin.origin,
      vapiKey,
    }));
  } catch (err) {
    if (err instanceof AssistantSecretWriteError) {
      // Vapi took the rebuild; the hash write did not land. The
      // assistant will answer and then 401 on every tool call. Nothing
      // is deleted here -- `created` is false on this path (an existing
      // assistant was PATCHed), and deleting the assistant a restaurant
      // is answering on to tidy up a failed write is far worse than the
      // state being repaired. go-live.ts's repair is the destination.
      console.error("[admin-edit] the assistant rebuilt but its tool secret did not save", {
        locationId: location.id,
      });
      return {
        state: "secret-lost",
        reason:
          "The assistant was rebuilt, but saving its new tool secret failed — it will answer " +
          "the phone and then be unable to read the menu or take an order.",
      };
    }
    console.error(
      "[admin-edit] could not rebuild the assistant",
      err instanceof Error ? err.message : "unknown",
    );
    return { state: "failed", reason: vapiSentence(err) };
  }

  // The guards above should have made this impossible. If it happened
  // anyway, a new assistant now carries this restaurant's tag and its
  // fresh secret while the phone number is still bound to the old one --
  // reported as a failure, never as "the phone changed with the screen".
  if (created) {
    console.error("[admin-edit] a rebuild created a second assistant", {
      locationId: location.id,
    });
    return { state: "failed", reason: SECOND_ASSISTANT };
  }

  return { state: "updated" };
}

/** The sentence the operator reads, built from what was saved and what
 *  happened to the phone. One place, so no caller can accidentally
 *  report a rebuild that did not happen. */
function withPhone(saved: string, phone: PhoneSync): EditResult {
  switch (phone.state) {
    case "not-needed":
      return ok(saved, phone);
    case "updated":
      return ok(
        `${saved} The assistant was rebuilt with it, so the phone changed with the screen.`,
        phone,
      );
    case "no-assistant":
      return ok(
        `${saved} There is no assistant yet, so there is nothing on the phone to update — the ` +
          "go-live panel builds it from these values.",
        phone,
      );
    case "failed":
      return ok(
        `${saved} The assistant could NOT be rebuilt: ${phone.reason} The phone is still on the ` +
          "old value until this is pushed again.",
        phone,
      );
    case "secret-lost":
      return ok(
        `${saved} ${phone.reason} Repair the assistant on the go-live panel now.`,
        phone,
      );
  }
}

/** A write in the same save that has ALREADY landed by the time this
 *  runs -- today only saveBusiness's organizations row.
 *
 *  It exists so no sentence in this file can be false. Without it a save
 *  that renamed only the organization reports "Nothing to save", and one
 *  whose location write then failed reports "Nothing was changed" over a
 *  row that has already changed. */
type Companion = {
  landed: boolean;
  /** When this section itself had nothing to write. */
  alone: string;
  /** Opens the refusal, so the blanket sentence is never told over a
   *  write that did happen. */
  butNot: string;
};

/** Write a location patch, then push it to the phone if it has to be
 *  pushed. The spine of five of the six section saves. */
async function saveLocationSection(
  locationId: string,
  current: LocationRow,
  next: Record<string, unknown>,
  base: string | null,
  saved: string,
  /** locations.updated_at as the form that is saving was rendered from.
   *  The write is conditional on it; see updateLocation. */
  seenUpdatedAt: string,
  companion: Companion | null = null,
): Promise<EditResult> {
  const patch = changedColumns(current as unknown as Record<string, unknown>, next);

  if (Object.keys(patch).length === 0) {
    return ok(
      companion?.landed
        ? companion.alone
        : "Nothing to save — those values are already what is on file.",
    );
  }

  const written = await updateLocation(locationId, patch, seenUpdatedAt);
  if (!written.ok) {
    return {
      ok: false,
      error: companion?.landed
        ? `${companion.butNot} ${written.tail}`
        : written.error,
    };
  }

  if (!touchesAssistant(patch)) return ok(saved);

  if (!base) {
    // A section that can rebuild was called without an origin. Refusing
    // after the write would be a lie (it saved); claiming a push that
    // never happened would be worse.
    return withPhone(saved, {
      state: "failed",
      reason: "This deployment's own address was not available to rebuild from.",
    });
  }

  // Re-read rather than patching the old row in memory: the assistant is
  // built from the whole row, and another operator may have moved a
  // column this section does not own.
  const reread = await rowForWrite(locationId);
  if ("refusal" in reread) {
    return withPhone(saved, {
      state: "failed",
      reason: "This restaurant could not be re-read to rebuild the assistant from.",
    });
  }

  return withPhone(saved, await syncAssistant(reread.row, base));
}

/* ── the record, for the editor to render ──────────────────────────── */

/** The location, minus its secret.
 *
 *  agent_secret_hash is replaced by a boolean on the way out. A hash in
 *  a response body is still a secret in a response body, and the class-B
 *  facts panel only ever needed to say "set" or "not set". */
export type EditableLocation = Omit<LocationRow, "agent_secret_hash"> & {
  twilio_number_sid: string | null;
  created_at: string;
  updated_at: string;
  tool_secret_on_file: boolean;
};

/** The billing entity. Its id is not returned -- nothing the browser
 *  sends may name an org, so nothing needs to know one. stripe_customer_id
 *  is presence only, for the same reason as the hash. */
export type EditableOrg = {
  name: string;
  plan: string;
  stripe_customer_on_file: boolean;
};

export type EditableHoursRow = {
  id: string;
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean;
};

export type EditableHoliday = {
  id: string;
  date: string;
  is_closed: boolean;
  open_time: string | null;
  close_time: string | null;
};

export type EditableCategory = {
  id: string;
  name: string;
  sort_order: number;
};

export type EditableItem = {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  allergen_note: string | null;
  sort_order: number;
  sold_out_until: "reopen" | "close" | null;
  /** The restaurant nominated this dish. At most three true per
   *  location, held by menu_items_staff_pick_cap. */
  is_staff_pick: boolean;
};

export type EditableRecord = {
  location: EditableLocation;
  org: EditableOrg;
  hours: EditableHoursRow[];
  holidays: EditableHoliday[];
  categories: EditableCategory[];
  items: EditableItem[];
};

/** Everything the editor renders, in one read.
 *
 *  Returns null for a caller who is not staff and for a location that
 *  does not exist -- the page turns both into notFound(). Throws
 *  LocationReadError when the row could not be READ, which is a
 *  different fact and deserves the error boundary rather than a 404: a
 *  transient Postgres error must not delete a restaurant from the
 *  console. */
export async function getEditableRecord(locationId: string): Promise<EditableRecord | null> {
  const admin = await currentPlatformAdmin();
  if (!admin) return null;
  if (!UUID.test(locationId)) return null;

  const supabase = supabaseAdmin();

  const location = await supabase
    .from("locations")
    .select("*, organizations(name, plan, stripe_customer_id)")
    .eq("id", locationId)
    .maybeSingle();

  if (location.error) {
    console.error("[admin-edit] could not read the record", {
      locationId,
      code: location.error.code,
    });
    throw new LocationReadError();
  }
  if (!location.data) return null;

  const [hours, holidays, categories, items] = await Promise.all([
    supabase
      .from("hours")
      .select("id, day_of_week, open_time, close_time, is_closed")
      .eq("location_id", locationId)
      .order("day_of_week"),
    supabase
      .from("holiday_hours")
      .select("id, date, is_closed, open_time, close_time")
      .eq("location_id", locationId)
      .order("date"),
    supabase
      .from("menu_categories")
      .select("id, name, sort_order")
      .eq("location_id", locationId)
      .order("sort_order"),
    supabase
      .from("menu_items")
      .select(
        "id, category_id, name, description, price_cents, allergen_note, sort_order, sold_out_until, is_staff_pick",
      )
      .eq("location_id", locationId)
      .order("sort_order"),
  ]);

  for (const [what, result] of [
    ["hours", hours],
    ["holidays", holidays],
    ["categories", categories],
    ["items", items],
  ] as const) {
    if (result.error) {
      console.error("[admin-edit] could not read part of the record", {
        locationId,
        what,
        code: result.error.code,
      });
      throw new LocationReadError();
    }
  }

  const row = location.data as LocationRow & {
    twilio_number_sid: string | null;
    created_at: string;
    updated_at: string;
    organizations: { name: string; plan: string; stripe_customer_id: string | null } | null;
  };
  const { agent_secret_hash, organizations, ...rest } = row;

  return {
    location: { ...rest, tool_secret_on_file: agent_secret_hash !== null },
    org: {
      name: organizations?.name ?? "",
      plan: organizations?.plan ?? "trial",
      stripe_customer_on_file: Boolean(organizations?.stripe_customer_id),
    },
    hours: (hours.data ?? []) as EditableHoursRow[],
    holidays: (holidays.data ?? []) as EditableHoliday[],
    categories: (categories.data ?? []) as EditableCategory[],
    items: (items.data ?? []) as EditableItem[],
  };
}

/* ══ the mutations ═════════════════════════════════════════════════ */

/* ── 1. the business ───────────────────────────────────────────────── */

/** Name, timezone, address, display phone, carrier, and the
 *  organization's own name and plan.
 *
 *  Two tables, and the order is chosen so that the failure mode is the
 *  harmless one. The organization row goes first: nothing on a call
 *  reads organizations.name or organizations.plan, so a failure there
 *  leaves the world untouched and refuses outright. The location row
 *  goes second, and only that one can drag a rebuild along.
 *
 *  org_id is read off the location row here. It is never accepted from
 *  a caller -- an org id from a browser is an authorization, and no
 *  authorization crosses that boundary. */
export async function saveBusiness({
  locationId,
  input,
  base,
  seenUpdatedAt,
}: {
  locationId: string;
  input: BusinessInput;
  /** The origin the console is open on. Checked against this
   *  deployment's own configured address before anything is pushed --
   *  never used as the address itself. */
  base: string;
  /** locations.updated_at as this form was rendered from. */
  seenUpdatedAt: string;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const checked = validateBusiness(input);
  if (!checked.ok) return refuse(checked.error);
  const value = checked.value;

  const read = await rowForWrite(locationId);
  if ("refusal" in read) return read.refusal;
  const location = read.row;

  const org = await supabaseAdmin()
    .from("organizations")
    .select("id, name, plan")
    .eq("id", location.org_id)
    .maybeSingle();

  if (org.error) {
    console.error("[admin-edit] could not read the organization", {
      locationId,
      code: org.error.code,
    });
    return { ok: false, error: "Could not read the organization. Nothing was changed." };
  }
  if (!org.data) return NOT_FOUND;

  const orgRow = org.data as { id: string; name: string; plan: string };
  const orgPatch = changedColumns(orgRow, { name: value.orgName, plan: value.plan });

  // Whether the organization row moved is carried the rest of the way,
  // not dropped. This section spans two tables and the sentence it
  // returns has to be true of both: an org-only change is a save, not
  // "nothing to save", and a location write that fails after this one
  // landed is not "nothing was changed".
  const orgLanded = Object.keys(orgPatch).length > 0;

  if (orgLanded) {
    const { error } = await supabaseAdmin()
      .from("organizations")
      .update(orgPatch)
      .eq("id", orgRow.id);
    if (error) {
      console.error("[admin-edit] organizations update failed", {
        locationId,
        code: error.code,
        columns: Object.keys(orgPatch),
      });
      return { ok: false, error: WRITE_FAILED };
    }
  }

  return saveLocationSection(
    locationId,
    location,
    {
      name: value.name,
      timezone: value.timezone,
      address: value.address,
      business_phone: value.businessPhone,
      carrier_name: value.carrierName,
    },
    base,
    "Saved.",
    seenUpdatedAt,
    {
      landed: orgLanded,
      alone:
        "Saved. The organization is the billing entity — nothing the assistant says changed, so " +
        "there was nothing to push to the phone.",
      butNot: "The organization's name and plan were saved. The restaurant's own details were not:",
    },
  );
}

/* ── 2. answering the phone ────────────────────────────────────────── */

/** The greeting and the transfer destination -- both baked, so this
 *  section rebuilds every time either moves.
 *
 *  The fallback number is the highest-stakes field in the editor. The
 *  column is what app/api/agent/transfer/route.ts reads and tells the
 *  model; the BAKED copy is what Vapi's own transferCall actually dials.
 *  Saved without a rebuild, the agent says "one moment, connecting you"
 *  and the call moves to the old number, with nothing anywhere reporting
 *  an error. That is the sentence go-live.ts's setFallbackNumber already
 *  writes and has no button for; this is the button. */
export async function saveAnswering({
  locationId,
  input,
  base,
  seenUpdatedAt,
}: {
  locationId: string;
  input: AnsweringInput;
  base: string;
  seenUpdatedAt: string;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const checked = validateAnswering(input);
  if (!checked.ok) return refuse(checked.error);

  const read = await rowForWrite(locationId);
  if ("refusal" in read) return read.refusal;

  return saveLocationSection(
    locationId,
    read.row,
    {
      greeting_text: checked.value.greetingText,
      fallback_human_number: checked.value.fallbackNumber,
    },
    base,
    `Saved. Transfers, allergy hand-offs and the kill switch now dial ${checked.value.fallbackNumber}.`,
    seenUpdatedAt,
  );
}

/* ── 3. money & service ────────────────────────────────────────────── */

/** Tax, order types, promise times, seats, party size, slot length.
 *
 *  Six of the seven are read live inside the call -- place_order reads
 *  tax_rate_bps, order/route.ts reads the promise minutes,
 *  availability and book_table read seats, the slot and the max party --
 *  so they land on the next call with nothing to push.
 *
 *  order_types is the exception and the trap. It is enforced live by
 *  app/api/agent/order/route.ts AND baked into the prompt's "Order type
 *  available" line, so without a rebuild the two halves disagree: the
 *  agent keeps saying "pickup only" while the route would have accepted
 *  delivery (lost orders, no error anywhere), or the agent offers
 *  delivery and place_order refuses it with the caller on the line. */
export async function saveService({
  locationId,
  input,
  base,
  seenUpdatedAt,
}: {
  locationId: string;
  input: ServiceInput;
  base: string;
  seenUpdatedAt: string;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const checked = validateService(input);
  if (!checked.ok) return refuse(checked.error);
  const value = checked.value;

  const read = await rowForWrite(locationId);
  if ("refusal" in read) return read.refusal;

  return saveLocationSection(
    locationId,
    read.row,
    {
      tax_rate_bps: value.taxRateBps,
      order_types: value.orderTypes,
      pickup_promise_minutes: value.pickupPromiseMinutes,
      delivery_promise_minutes: value.deliveryPromiseMinutes,
      seats: value.seats,
      max_party_size: value.maxPartySize,
      reservation_slot_minutes: value.reservationSlotMinutes,
    },
    base,
    "Saved. The next call uses these.",
    seenUpdatedAt,
  );
}

/* ── 4. where orders go ────────────────────────────────────────────── */

/** The kitchen ticket's destination.
 *
 *  Nothing baked; nothing to push. Note for whoever writes the screen:
 *  lib/agent/notify.ts sends to order_sms_to and nothing else. No email
 *  sender exists in this repo, and order_delivery is read by nothing at
 *  all -- so a screen that offers "email" as a routing choice is
 *  asserting a delivery that does not happen. Save the columns, and say
 *  plainly that only the text is sent today. */
export async function saveOrderRouting({
  locationId,
  input,
  seenUpdatedAt,
}: {
  locationId: string;
  input: OrderRoutingInput;
  seenUpdatedAt: string;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const checked = validateOrderRouting(input);
  if (!checked.ok) return refuse(checked.error);
  const value = checked.value;

  const read = await rowForWrite(locationId);
  if ("refusal" in read) return read.refusal;

  return saveLocationSection(
    locationId,
    read.row,
    {
      order_delivery: value.orderDelivery,
      order_sms_to: value.orderSmsTo,
      order_email_to: value.orderEmailTo,
    },
    null,
    value.orderSmsTo
      ? `Saved. Order tickets are texted to ${value.orderSmsTo}.`
      : "Saved. There is no kitchen number on file, so no ticket is sent when an order is taken.",
    seenUpdatedAt,
  );
}

/* ── 5. recording & retention ──────────────────────────────────────── */

/** Recording, on the forwarded line.
 *
 *  Honest note for the screen: recording_enabled is read by exactly one
 *  file, app/api/twilio/voice/route.ts -- the straight-to-a-person path.
 *  buildAssistantPayload carries no recording config at all, so on a
 *  Vapi-answered number this toggle changes nothing. And nothing in this
 *  repo reads recording_retention_days: there is no purge job and
 *  recording_expires_at is never written from it. Both are saved
 *  faithfully; neither may be presented as a control that is doing
 *  something it is not. */
export async function saveRecording({
  locationId,
  input,
  seenUpdatedAt,
}: {
  locationId: string;
  input: RecordingInput;
  seenUpdatedAt: string;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const checked = validateRecording(input);
  if (!checked.ok) return refuse(checked.error);

  const read = await rowForWrite(locationId);
  if ("refusal" in read) return read.refusal;

  return saveLocationSection(
    locationId,
    read.row,
    {
      recording_enabled: checked.value.recordingEnabled,
      recording_retention_days: checked.value.recordingRetentionDays,
    },
    null,
    "Saved.",
    seenUpdatedAt,
  );
}

/* ── 6. hours ──────────────────────────────────────────────────────── */

/** All seven days, in one statement.
 *
 *  One upsert on the (location_id, day_of_week) unique index rather than
 *  seven updates: the seven rows are one fact about a restaurant, and a
 *  half-written week is a restaurant that is shut on Tuesday because a
 *  round trip failed. It also means a location whose rows were never
 *  created gets them, which is what a missing weekday actually needs --
 *  lib/agent/hours.ts reads a missing row as closed all day.
 *
 *  No rebuild. The prompt's frozen "Hours today" line is a snapshot the
 *  model is explicitly told not to trust -- it is ordered to call
 *  get_hours -- and app/api/agent/hours/route.ts queries Postgres, with
 *  holiday_hours, on every call. Rebuilding here would rotate the tool
 *  secret to refresh a line nobody reads. */
export async function saveHours({
  locationId,
  input,
  seenSignature,
}: {
  locationId: string;
  input: HoursInput;
  /** hoursSignature() of the seven rows this grid was rendered from. The
   *  upsert replaces the whole week, so it is only allowed to when the
   *  week it is replacing is the one the operator was looking at. */
  seenSignature: string;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const checked = validateHours(input);
  if (!checked.ok) return refuse(checked.error);

  // The location has to exist before rows are written against its id:
  // the FK would catch it, but as SQLSTATE 23503 rather than a sentence.
  const read = await rowForWrite(locationId);
  if ("refusal" in read) return read.refusal;

  const onFile = await supabaseAdmin()
    .from("hours")
    .select("day_of_week, open_time, close_time, is_closed")
    .eq("location_id", locationId);

  if (onFile.error) {
    console.error("[admin-edit] could not read the hours before writing them", {
      locationId,
      code: onFile.error.code,
    });
    return { ok: false, error: WRITE_FAILED };
  }

  const week = (onFile.data ?? []) as Parameters<typeof hoursSignature>[0];
  if (hoursSignature(week) !== seenSignature) {
    return {
      ok: false,
      error:
        "Somebody else changed this restaurant's hours while this page was open, so saving the " +
        "week shown here would have put their change back. Reload the page and make the change " +
        "again. Nothing was saved.",
    };
  }

  const rows = checked.value.map((row) => ({ location_id: locationId, ...row }));

  const { error } = await supabaseAdmin()
    .from("hours")
    .upsert(rows, { onConflict: "location_id,day_of_week" });

  if (error) {
    console.error("[admin-edit] hours upsert failed", { locationId, code: error.code });
    return { ok: false, error: WRITE_FAILED };
  }

  return ok("Saved. The assistant reads the hours fresh on every call, so this is live now.");
}

/* ── 7. holidays ───────────────────────────────────────────────────── */

/** Add or edit one date's override.
 *
 *  Per row rather than per section, because holidays are independent
 *  facts of variable count -- Thanksgiving and a private party in March
 *  have nothing to do with each other, and one bad date must not block
 *  the other.
 *
 *  `holidayId` is a selector. Null means "add"; a value is proved to
 *  belong to this location before anything is written, and the UPDATE
 *  carries the location filter as well. */
export async function saveHoliday({
  locationId,
  holidayId,
  input,
}: {
  locationId: string;
  holidayId: string | null;
  input: HolidayInput;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const checked = validateHoliday(input);
  if (!checked.ok) return refuse(checked.error);
  const value = checked.value;

  if (holidayId !== null) {
    const notOurs = await requireOwned("holiday_hours", holidayId, locationId);
    if (notOurs) return notOurs;

    const { error } = await supabaseAdmin()
      .from("holiday_hours")
      .update(value)
      .eq("id", holidayId)
      .eq("location_id", locationId);

    if (error) return holidayWriteError(locationId, error.code);
    return ok(`Saved. ${value.date} is live on the next call.`);
  }

  const read = await rowForWrite(locationId);
  if ("refusal" in read) return read.refusal;

  const { error } = await supabaseAdmin()
    .from("holiday_hours")
    .insert({ location_id: locationId, ...value });

  if (error) return holidayWriteError(locationId, error.code);
  return ok(`Saved. ${value.date} is live on the next call.`);
}

/** 23505 is the (location_id, date) unique index doing its job, and it
 *  is the one Postgres code here with a useful sentence behind it. Every
 *  other code is the house's one sentence -- the error's text is never
 *  shown and never logged. */
function holidayWriteError(locationId: string, code: string): EditResult {
  console.error("[admin-edit] holiday write failed", { locationId, code });
  return code === "23505"
    ? {
        ok: false,
        error: "There is already an entry for that date. Edit that one instead of adding a second.",
      }
    : { ok: false, error: WRITE_FAILED };
}

export async function deleteHoliday({
  locationId,
  holidayId,
}: {
  locationId: string;
  holidayId: string;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const notOurs = await requireOwned("holiday_hours", holidayId, locationId);
  if (notOurs) return notOurs;

  const { error } = await supabaseAdmin()
    .from("holiday_hours")
    .delete()
    .eq("id", holidayId)
    .eq("location_id", locationId);

  if (error) {
    console.error("[admin-edit] holiday delete failed", { locationId, code: error.code });
    return { ok: false, error: "That did not delete. Nothing was changed." };
  }

  return ok("Removed. That date follows the weekly hours again from the next call.");
}

/* ── 8. the menu ───────────────────────────────────────────────────── */

/* The live-read exception, and the product's central promise:
   app/api/agent/menu/route.ts queries Postgres on every call and is
   never cached into the prompt, and public.place_order re-reads the
   price and the sold-out state in the same statement that builds the
   line. So a price saved here is what the agent quotes on the very next
   call. Nothing in this section rebuilds anything. */

export async function createMenuCategory({
  locationId,
  input,
}: {
  locationId: string;
  input: CategoryInput;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const checked = validateCategory(input);
  if (!checked.ok) return refuse(checked.error);

  const read = await rowForWrite(locationId);
  if ("refusal" in read) return read.refusal;

  const { error } = await supabaseAdmin()
    .from("menu_categories")
    .insert({ location_id: locationId, ...checked.value });

  if (error) {
    console.error("[admin-edit] category insert failed", { locationId, code: error.code });
    return { ok: false, error: WRITE_FAILED };
  }

  return ok(`Added “${checked.value.name}”. The next call reads it.`);
}

export async function saveMenuCategory({
  locationId,
  categoryId,
  input,
}: {
  locationId: string;
  categoryId: string;
  input: CategoryInput;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const checked = validateCategory(input);
  if (!checked.ok) return refuse(checked.error);

  const notOurs = await requireOwned("menu_categories", categoryId, locationId);
  if (notOurs) return notOurs;

  const { error } = await supabaseAdmin()
    .from("menu_categories")
    .update(checked.value)
    .eq("id", categoryId)
    .eq("location_id", locationId);

  if (error) {
    console.error("[admin-edit] category update failed", { locationId, code: error.code });
    return { ok: false, error: WRITE_FAILED };
  }

  return ok("Saved. The next call reads it.");
}

/** Removing a category takes its items with it -- menu_items.category_id
 *  is `on delete cascade`. The sentence says so, because an operator who
 *  meant to rename a section and deleted twelve dishes finds out on the
 *  next call. */
export async function deleteMenuCategory({
  locationId,
  categoryId,
}: {
  locationId: string;
  categoryId: string;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const notOurs = await requireOwned("menu_categories", categoryId, locationId);
  if (notOurs) return notOurs;

  const { error } = await supabaseAdmin()
    .from("menu_categories")
    .delete()
    .eq("id", categoryId)
    .eq("location_id", locationId);

  if (error) {
    console.error("[admin-edit] category delete failed", { locationId, code: error.code });
    return { ok: false, error: "That did not delete. Nothing was changed." };
  }

  return ok("Removed, along with every item that was in it.");
}

/** Two names that normalise the same are a permanent `ambiguous_item`
 *  for every caller who says that dish. `exceptId` lets an item keep its
 *  own name while being edited. */
async function duplicateName(
  locationId: string,
  name: string,
  exceptId: string | null,
): Promise<{ duplicate: boolean } | { unreadable: true }> {
  const { data, error } = await supabaseAdmin()
    .from("menu_items")
    .select("id, name")
    .eq("location_id", locationId);

  if (error) {
    console.error("[admin-edit] could not read the menu for a name check", {
      locationId,
      code: error.code,
    });
    return { unreadable: true };
  }

  const needle = normaliseItemName(name);
  const rows = (data ?? []) as { id: string; name: string }[];
  return {
    duplicate: rows.some((row) => row.id !== exceptId && normaliseItemName(row.name) === needle),
  };
}

const DUPLICATE_ITEM =
  "This restaurant already has an item by that name. Two items with the same name make the " +
  "assistant ask which one the caller meant and then read back two identical names, which is a " +
  "question nobody can answer.";

/** The target category is proved to belong to THIS location, server-side,
 *  every time an item is written.
 *
 *  This is not defence in depth, it is the only defence. The
 *  app.sync_menu_item_location trigger re-derives location_id FROM THE
 *  CATEGORY on insert and on any update of category_id -- so an item
 *  posted with another restaurant's category id does not fail, it
 *  silently becomes that restaurant's item, appearing on their menu and
 *  in their agent's mouth on the next call. */
async function categoryOfThisLocation(
  categoryId: string,
  locationId: string,
): Promise<EditResult | null> {
  return requireOwned("menu_categories", categoryId, locationId);
}

export async function createMenuItem({
  locationId,
  input,
}: {
  locationId: string;
  input: MenuItemInput;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const checked = validateMenuItem(input);
  if (!checked.ok) return refuse(checked.error);
  const value = checked.value;

  const wrongCategory = await categoryOfThisLocation(value.category_id, locationId);
  if (wrongCategory) return wrongCategory;

  const dup = await duplicateName(locationId, value.name, null);
  if ("unreadable" in dup) {
    return { ok: false, error: "Could not check the rest of the menu just now. Nothing was saved." };
  }
  if (dup.duplicate) return { ok: false, error: `${DUPLICATE_ITEM} Nothing was saved.` };

  // location_id is passed as well as derived: the trigger overwrites it
  // from the category, which has already been proved to be this
  // location's, so the two agree by construction.
  const { error } = await supabaseAdmin()
    .from("menu_items")
    .insert({ location_id: locationId, ...value });

  if (error) {
    console.error("[admin-edit] item insert failed", { locationId, code: error.code });
    // 23514 here is the staff-pick cap, the same constraint
    // saveMenuItem's own 23514 branch below maps. AddItemForm hardcodes
    // staffPick: false today, so a real caller cannot reach this yet --
    // but createItemAction takes the flag from the client regardless,
    // and the two writers of this table must stay symmetric rather than
    // depend on which form happens to expose the checkbox.
    if (error.code === "23514") {
      return refuse(
        "This restaurant already has three staff picks. Unmark one first.",
      );
    }
    return { ok: false, error: WRITE_FAILED };
  }

  return ok(`Added “${value.name}”. The next call quotes it.`);
}

export async function saveMenuItem({
  locationId,
  itemId,
  input,
}: {
  locationId: string;
  itemId: string;
  input: MenuItemInput;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const checked = validateMenuItem(input);
  if (!checked.ok) return refuse(checked.error);
  const value = checked.value;

  // The row itself, not just "is it ours": its name decides whether the
  // duplicate check below has anything to check.
  const current = await ownedMenuItem(itemId, locationId);
  if ("refusal" in current) return current.refusal;

  const wrongCategory = await categoryOfThisLocation(value.category_id, locationId);
  if (wrongCategory) return wrongCategory;

  /* Only when the name actually MOVED.
   *
   * Twins are routine rather than exotic: app.publish_menu_import
   * appends items with no name check at all, and the owner's own
   * MenuStore has none either -- so importing the same PDF twice, or a
   * menu that prints "Side Salad" under both Lunch and Dinner, leaves
   * two rows that normalise the same. Checking an UNTOUCHED name would
   * make the one screen built to fix a restaurant's data the one screen
   * that cannot touch the rows most likely to need fixing: no price
   * edit, no description fix, no category move, and a red sentence under
   * a field the operator never typed in, blaming them for a collision
   * they did not create.
   *
   * Note this check is advisory either way -- two concurrent adds both
   * pass their read and both insert. Only a unique index on
   * (location_id, lower(btrim(name))) would make it an invariant, and
   * would turn the race into a loud 23505. */
  if (normaliseItemName(value.name) !== normaliseItemName(current.row.name)) {
    const dup = await duplicateName(locationId, value.name, itemId);
    if ("unreadable" in dup) {
      return {
        ok: false,
        error: "Could not check the rest of the menu just now. Nothing was saved.",
      };
    }
    if (dup.duplicate) return { ok: false, error: `${DUPLICATE_ITEM} Nothing was saved.` };
  }

  /* sold_out_until is NOT written here, and the omission is the point.
   *
   * The edit row has no control for it -- it is its own one-click action
   * because the kitchen runs out of a dish mid-service -- so every value
   * this save could carry for it is a copy of whatever the page was
   * rendered with, which may be minutes old. Writing it back puts a dish
   * the owner marked sold out at seven back on sale at ten past, silently
   * and live on the very next call, as a side effect of fixing a
   * description. setMenuItemSoldOut is the only writer with a control
   * behind it and stays the only writer. */
  const { sold_out_until, ...columns } = value;
  void sold_out_until;

  const { error } = await supabaseAdmin()
    .from("menu_items")
    .update(columns)
    .eq("id", itemId)
    .eq("location_id", locationId);

  if (error) {
    console.error("[admin-edit] item update failed", { locationId, code: error.code });
    // 23514 here is the staff-pick cap, the only check constraint this
    // write can violate. Anything else keeps the generic refusal.
    if (error.code === "23514") {
      return refuse(
        "This restaurant already has three staff picks. Unmark one first.",
      );
    }
    return { ok: false, error: WRITE_FAILED };
  }

  return ok(`Saved. The next call quotes ${dollars(value.price_cents)} for “${value.name}”.`);
}

export async function deleteMenuItem({
  locationId,
  itemId,
}: {
  locationId: string;
  itemId: string;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const notOurs = await requireOwned("menu_items", itemId, locationId);
  if (notOurs) return notOurs;

  const { error } = await supabaseAdmin()
    .from("menu_items")
    .delete()
    .eq("id", itemId)
    .eq("location_id", locationId);

  if (error) {
    console.error("[admin-edit] item delete failed", { locationId, code: error.code });
    return { ok: false, error: "That did not delete. Nothing was changed." };
  }

  return ok("Removed. The assistant stops offering it on the next call.");
}

/** The fastest-moving field on the whole record: the kitchen runs out of
 *  branzino at seven and the agent must stop selling it on the next
 *  call.
 *
 *  Neither value expires on its own -- there is no job that clears
 *  'reopen' or 'close' -- so a human has to unset it, and the UI must
 *  say so rather than implying tomorrow fixes it. */
export async function setMenuItemSoldOut({
  locationId,
  itemId,
  until,
}: {
  locationId: string;
  itemId: string;
  /** "" to put it back on sale. */
  until: string;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const checked = validateSoldOut(until);
  if (!checked.ok) return refuse(checked.error);

  const notOurs = await requireOwned("menu_items", itemId, locationId);
  if (notOurs) return notOurs;

  const { error } = await supabaseAdmin()
    .from("menu_items")
    .update({ sold_out_until: checked.value })
    .eq("id", itemId)
    .eq("location_id", locationId);

  if (error) {
    console.error("[admin-edit] sold-out update failed", { locationId, code: error.code });
    return { ok: false, error: WRITE_FAILED };
  }

  if (checked.value === null) return ok("Back on sale from the next call.");
  return ok(
    checked.value === "reopen"
      ? "Marked sold out until the kitchen restocks. Nothing clears this by itself — put it back " +
          "on sale here when it returns."
      : "Marked sold out for the rest of service. Nothing clears this by itself — put it back on " +
          "sale here tomorrow.",
  );
}

/** Cents as the operator typed them back. Display only, and never
 *  re-entering storage, so toFixed is safe here in a way it is not on
 *  the parse side (see lib/money.ts's header). */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/* ── pushing an edit that did not push ─────────────────────────────── */

/** "Update the phone". The retry behind a failed re-sync, with nothing
 *  to retype.
 *
 *  Writes no column: it rebuilds the assistant from the row exactly as
 *  it stands. That makes it safe to press twice, and it is the only
 *  thing that can close the gap after a rebuild failed -- go-live.ts's
 *  Repair assistant deliberately pushes NOTHING when the record is
 *  healthy ("Nothing to repair — this record already points at the
 *  assistant Vapi has"), which is the state a stale-prompt restaurant is
 *  always in. */
export async function resyncAssistant({
  locationId,
  base,
}: {
  locationId: string;
  base: string;
}): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const read = await rowForWrite(locationId);
  if ("refusal" in read) return read.refusal;

  const phone = await syncAssistant(read.row, base);

  switch (phone.state) {
    case "updated":
      return ok(
        "The assistant was rebuilt from what is on file, so the phone now matches the screen.",
        phone,
      );
    case "no-assistant":
      return ok(
        "There is no assistant yet, so there is nothing on the phone to update — the go-live " +
          "panel builds it from these values.",
        phone,
      );
    case "secret-lost":
      return ok(`${phone.reason} Repair the assistant on the go-live panel now.`, phone);
    case "failed":
      return { ok: false, error: `${phone.reason} The phone is still on the old value.` };
    case "not-needed":
      // syncAssistant never returns this; the switch is exhaustive so
      // that adding a state is a compile error rather than a silent
      // fall-through into a claim nobody checked.
      return ok("Nothing to push.", phone);
  }
}
