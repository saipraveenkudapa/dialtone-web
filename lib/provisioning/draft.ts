/* What an operator types into "Create a new restaurant", and the one
 * place it is checked.
 *
 * Pure: no database, no network, no `server-only`. Every rule that used
 * to live inline in app/onboarding/actions.ts's four step handlers is
 * here instead, so the whole of "is this restaurant describable" can be
 * unit-tested without standing up Supabase -- and so the server action
 * that does the writing has nothing left to decide by the time it runs.
 *
 * Two conversions happen here and nowhere else, because both are the
 * kind of thing that is silently wrong rather than loudly broken:
 *   * dollars typed by a human -> integer cents (lib/money.ts, exact,
 *     no float multiply)
 *   * a percentage typed by a human -> integer basis points, the unit
 *     locations.tax_rate_bps actually stores
 */

import { parseDollarsToCents, parsePercentToBasisPoints } from "@/lib/money";
import { normalizePhoneToE164 } from "@/lib/phone";
import { WEEKDAYS } from "@/lib/provisioning/constants";

export type DraftHours = {
  /** 0 = Sunday .. 6 = Saturday, matching the `hours` table. */
  dayOfWeek: number;
  closed: boolean;
  /** "HH:MM". Ignored when closed. */
  open: string;
  close: string;
};

export type DraftMenuItem = {
  name: string;
  description: string;
  /** Typed in dollars, e.g. "22.00". Stored as whole cents. */
  priceDollars: string;
};

export type DraftMenuCategory = {
  name: string;
  items: DraftMenuItem[];
};

/** Exactly what the form sends. Strings throughout -- these are the
 *  values a human typed, before anything has decided they are numbers. */
export type RestaurantDraft = {
  name: string;
  address: string;
  timezone: string;
  businessPhone: string;
  fallbackNumber: string;
  ownerEmail: string;
  hours: DraftHours[];
  taxPercent: string;
  orderTypes: string;
  pickupPromiseMinutes: string;
  deliveryPromiseMinutes: string;
  seats: string;
  maxPartySize: string;
  reservationSlotMinutes: string;
  menu: DraftMenuCategory[];
};

/** The same restaurant, in the units and shapes the database columns
 *  hold. Money is integer cents, tax is integer basis points, phone
 *  numbers are E.164. */
export type ValidRestaurant = {
  name: string;
  address: string;
  timezone: string;
  businessPhone: string | null;
  fallbackNumber: string;
  ownerEmail: string;
  hours: {
    day_of_week: number;
    open_time: string | null;
    close_time: string | null;
    is_closed: boolean;
  }[];
  taxRateBps: number;
  orderTypes: "pickup" | "delivery" | "both";
  pickupPromiseMinutes: number;
  deliveryPromiseMinutes: number;
  seats: number;
  maxPartySize: number;
  reservationSlotMinutes: number;
  menu: {
    name: string;
    items: { name: string; description: string | null; priceCents: number }[];
  }[];
};

export type DraftValidation =
  | { ok: true; value: ValidRestaurant }
  | { ok: false; error: string };

function fail(error: string): DraftValidation {
  return { ok: false, error };
}

/** A whole number inside a range, from a string a human typed. Rejects
 *  "12.5", "" and "abc" rather than letting Number() coerce them into a
 *  value the database constraint would then reject with a Postgres
 *  error nobody can read. */
function wholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

// Deliberately loose. This is not the validator that decides whether an
// address can receive mail -- Supabase is, when it creates the user, and
// it rejects far more than this does. All this has to catch is the
// operator hitting Start with a half-typed address, before anything is
// written.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateRestaurantDraft(draft: RestaurantDraft): DraftValidation {
  // ── business ───────────────────────────────────────────────────────

  const name = draft.name.trim();
  if (!name) return fail("Enter the restaurant's name.");
  if (name.length > 120) return fail("That name is too long. Try something shorter.");

  const address = draft.address.trim();
  if (!address) return fail("Enter the restaurant's address.");

  const timezone = draft.timezone.trim();
  if (!timezone) return fail("Choose a timezone.");

  const ownerEmail = draft.ownerEmail.trim().toLowerCase();
  if (!ownerEmail) return fail("Enter the owner's email -- it is the username they sign in with.");
  if (!EMAIL.test(ownerEmail)) return fail("That owner email does not look like an email address.");

  // Vapi's native transferCall destination 400s on anything that is not
  // E.164, so this is normalized once, here, and every later reader
  // (the assistant payload, the operator console) can trust the shape.
  const fallbackNumber = normalizePhoneToE164(draft.fallbackNumber);
  if (!fallbackNumber) {
    return fail(
      "Enter a valid fallback number, e.g. (510) 555-0100 -- this is where catering and " +
        "allergy calls get transferred, and the assistant cannot be created without one.",
    );
  }

  const businessPhoneRaw = draft.businessPhone.trim();
  let businessPhone: string | null = null;
  if (businessPhoneRaw) {
    businessPhone = normalizePhoneToE164(businessPhoneRaw);
    if (!businessPhone) return fail("That display phone is not a number we can dial. Leave it blank or fix it.");
  }

  // ── hours ──────────────────────────────────────────────────────────

  if (draft.hours.length !== 7) return fail("Set hours for all seven days.");

  const hours: ValidRestaurant["hours"] = [];
  for (let day = 0; day < 7; day++) {
    const row = draft.hours.find((h) => h.dayOfWeek === day);
    if (!row) return fail(`Set hours for ${WEEKDAYS[day]}, or mark it closed.`);

    if (row.closed) {
      hours.push({ day_of_week: day, open_time: null, close_time: null, is_closed: true });
      continue;
    }

    const open = row.open.trim();
    const close = row.close.trim();
    if (!TIME.test(open) || !TIME.test(close)) {
      return fail(`Set both an open and a close time for ${WEEKDAYS[day]}, or mark it closed.`);
    }
    if (close <= open) {
      return fail(
        `${WEEKDAYS[day]}'s close time must be after its open time. Hours that cross midnight ` +
          "are not supported yet -- use the latest closing time this system can represent for now.",
      );
    }
    hours.push({ day_of_week: day, open_time: open, close_time: close, is_closed: false });
  }

  // ── money & service ────────────────────────────────────────────────

  const taxRateBps = parsePercentToBasisPoints(draft.taxPercent.trim());
  if (taxRateBps === null) return fail("Enter the sales tax rate as a plain percentage, e.g. 8.75.");
  if (taxRateBps < 0 || taxRateBps > 2000) return fail("Sales tax must be between 0% and 20%.");

  const orderTypes = draft.orderTypes.trim();
  if (orderTypes !== "pickup" && orderTypes !== "delivery" && orderTypes !== "both") {
    return fail("Choose pickup, delivery, or both.");
  }

  const pickupPromiseMinutes = wholeNumber(draft.pickupPromiseMinutes);
  if (pickupPromiseMinutes === null || pickupPromiseMinutes < 5 || pickupPromiseMinutes > 180) {
    return fail("Pickup promise time must be between 5 and 180 minutes.");
  }

  const deliveryPromiseMinutes = wholeNumber(draft.deliveryPromiseMinutes);
  if (deliveryPromiseMinutes === null || deliveryPromiseMinutes < 5 || deliveryPromiseMinutes > 180) {
    return fail("Delivery promise time must be between 5 and 180 minutes.");
  }

  const seats = wholeNumber(draft.seats);
  if (seats === null || seats < 1) return fail("Seats must be a whole number greater than 0.");

  const maxPartySize = wholeNumber(draft.maxPartySize);
  if (maxPartySize === null || maxPartySize < 1 || maxPartySize > 40) {
    return fail("Max party size must be between 1 and 40.");
  }

  const reservationSlotMinutes = wholeNumber(draft.reservationSlotMinutes);
  if (reservationSlotMinutes === null || reservationSlotMinutes < 30 || reservationSlotMinutes > 240) {
    return fail("Reservation length must be between 30 and 240 minutes.");
  }

  // ── menu ───────────────────────────────────────────────────────────
  //
  // A menu is not required to create the restaurant: an operator with the
  // business details in hand and the menu still in an email should be
  // able to press Start, and the owner or the operator fills the menu in
  // afterwards from /dashboard/menu. What IS required is that anything
  // typed here is right -- the assistant quotes these prices to a caller
  // within seconds of the number going live.
  const menu: ValidRestaurant["menu"] = [];
  for (const category of draft.menu) {
    const categoryName = category.name.trim();
    if (!categoryName) return fail("Every menu category needs a name.");
    if (categoryName.length > 80) return fail(`The category name "${categoryName.slice(0, 20)}…" is too long.`);

    const items: ValidRestaurant["menu"][number]["items"] = [];
    for (const item of category.items) {
      const itemName = item.name.trim();
      if (!itemName) return fail(`Every item in "${categoryName}" needs a name.`);
      if (itemName.length > 120) return fail(`The item name "${itemName.slice(0, 20)}…" is too long.`);

      const priceCents = parseDollarsToCents(item.priceDollars.trim());
      if (priceCents === null) {
        return fail(
          `"${item.priceDollars}" is not a plain dollar amount with at most two decimal places ` +
            `-- fix the price on "${itemName}", e.g. "12.99".`,
        );
      }

      const description = item.description.trim();
      items.push({ name: itemName, description: description || null, priceCents });
    }

    menu.push({ name: categoryName, items });
  }

  return {
    ok: true,
    value: {
      name,
      address,
      timezone,
      businessPhone,
      fallbackNumber,
      ownerEmail,
      hours,
      taxRateBps,
      orderTypes,
      pickupPromiseMinutes,
      deliveryPromiseMinutes,
      seats,
      maxPartySize,
      reservationSlotMinutes,
      menu,
    },
  };
}
