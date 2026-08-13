import { describe, expect, it } from "vitest";
import { validateRestaurantDraft, type RestaurantDraft } from "./draft";

/** A draft that passes, so every test below can change exactly one thing
 *  and know that is what it is testing. */
function draft(overrides: Partial<RestaurantDraft> = {}): RestaurantDraft {
  return {
    name: "Nonna Rosa",
    address: "1412 Telegraph Ave, Oakland, CA",
    timezone: "America/Los_Angeles",
    businessPhone: "(510) 555-0119",
    fallbackNumber: "(510) 555-0100",
    ownerEmail: "owner@nonnarosa.test",
    hours: Array.from({ length: 7 }, (_, day) => ({
      dayOfWeek: day,
      closed: day === 1,
      open: "11:00",
      close: "21:00",
    })),
    taxPercent: "8.75",
    orderTypes: "both",
    pickupPromiseMinutes: "25",
    deliveryPromiseMinutes: "45",
    seats: "40",
    maxPartySize: "8",
    reservationSlotMinutes: "90",
    menu: [
      {
        name: "Pasta",
        items: [{ name: "Cacio e Pepe", description: "black pepper, pecorino", priceDollars: "22.00" }],
      },
    ],
    ...overrides,
  };
}

function value(d: RestaurantDraft) {
  const result = validateRestaurantDraft(d);
  if (!result.ok) throw new Error(`expected a valid draft, got: ${result.error}`);
  return result.value;
}

function error(d: RestaurantDraft) {
  const result = validateRestaurantDraft(d);
  if (result.ok) throw new Error("expected the draft to be refused, but it passed");
  return result.error;
}

describe("validateRestaurantDraft", () => {
  it("accepts a complete restaurant", () => {
    expect(validateRestaurantDraft(draft()).ok).toBe(true);
  });

  // ── money ──────────────────────────────────────────────────────────
  //
  // The whole reason this validator exists rather than trusting the
  // form: a price is quoted to a caller within seconds of the number
  // going live, and a wrong one comes out of the owner's pocket.

  it("stores a menu price as integer cents, never a float", () => {
    const menu = value(
      draft({ menu: [{ name: "Pasta", items: [{ name: "Cacio e Pepe", description: "", priceDollars: "19.99" }] }] }),
    ).menu;
    expect(menu[0].items[0].priceCents).toBe(1999);
    expect(Number.isInteger(menu[0].items[0].priceCents)).toBe(true);
  });

  it("refuses a price finer than a cent rather than guessing which way to round it", () => {
    expect(
      error(draft({ menu: [{ name: "Pasta", items: [{ name: "X", description: "", priceDollars: "12.505" }] }] })),
    ).toContain("at most two decimal places");
  });

  it.each(["$22.00", "22,00", "-5", "twelve", ""])("refuses the price %j", (priceDollars) => {
    expect(
      error(draft({ menu: [{ name: "Pasta", items: [{ name: "X", description: "", priceDollars }] }] })),
    ).toContain("not a plain dollar amount");
  });

  it("stores sales tax as integer basis points, not a percentage", () => {
    expect(value(draft({ taxPercent: "8.75" })).taxRateBps).toBe(875);
    expect(value(draft({ taxPercent: "0" })).taxRateBps).toBe(0);
  });

  it("rounds a real-world rate finer than a basis point to the nearest one", () => {
    // 6.625% is a real California district rate. The column holds whole
    // basis points, so 662.5 has to land somewhere -- and the operator
    // is shown what landed.
    expect(value(draft({ taxPercent: "6.625" })).taxRateBps).toBe(663);
  });

  it("refuses a tax rate outside what the column's own check constraint allows", () => {
    expect(error(draft({ taxPercent: "25" }))).toContain("between 0% and 20%");
  });

  // ── phone numbers ──────────────────────────────────────────────────

  it("normalizes the fallback number to E.164, the only shape Vapi will dial", () => {
    expect(value(draft({ fallbackNumber: "(510) 555-0100" })).fallbackNumber).toBe("+15105550100");
    expect(value(draft({ fallbackNumber: "1-510-555-0100" })).fallbackNumber).toBe("+15105550100");
  });

  it("refuses to create a restaurant with no reachable fallback number", () => {
    // Without one there is nowhere to send an allergy call, and Vapi
    // rejects the assistant outright.
    expect(error(draft({ fallbackNumber: "" }))).toContain("fallback number");
    expect(error(draft({ fallbackNumber: "555-01" }))).toContain("fallback number");
  });

  it("treats the display phone as optional but still refuses a broken one", () => {
    expect(value(draft({ businessPhone: "" })).businessPhone).toBeNull();
    expect(error(draft({ businessPhone: "nope" }))).toContain("display phone");
  });

  // ── hours ──────────────────────────────────────────────────────────

  it("keeps a closed day as closed with no times, not as 00:00 to 00:00", () => {
    const monday = value(draft()).hours.find((h) => h.day_of_week === 1)!;
    expect(monday).toEqual({ day_of_week: 1, open_time: null, close_time: null, is_closed: true });
  });

  it("returns all seven days in weekday order whatever order they arrived in", () => {
    const shuffled = draft().hours.slice().reverse();
    expect(value(draft({ hours: shuffled })).hours.map((h) => h.day_of_week)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it("refuses a close time at or before its open time, naming the day", () => {
    const hours = draft().hours.map((h) =>
      h.dayOfWeek === 5 ? { ...h, closed: false, open: "21:00", close: "02:00" } : h,
    );
    expect(error(draft({ hours }))).toContain("Friday");
  });

  it("refuses an open day with a missing time rather than writing a row the DB check rejects", () => {
    const hours = draft().hours.map((h) => (h.dayOfWeek === 3 ? { ...h, closed: false, open: "" } : h));
    expect(error(draft({ hours }))).toContain("Wednesday");
  });

  // ── the owner's login ──────────────────────────────────────────────

  it("lowercases the owner email, so the operator's capitalisation is not a login problem", () => {
    expect(value(draft({ ownerEmail: "  Owner@Nonna.Test " })).ownerEmail).toBe("owner@nonna.test");
  });

  it("refuses a missing or malformed owner email", () => {
    expect(error(draft({ ownerEmail: "" }))).toContain("owner's email");
    expect(error(draft({ ownerEmail: "owner-at-nonna" }))).toContain("does not look like an email");
  });

  // ── service settings ───────────────────────────────────────────────

  it.each([
    ["pickupPromiseMinutes", "3", "Pickup promise"],
    ["pickupPromiseMinutes", "600", "Pickup promise"],
    ["deliveryPromiseMinutes", "0", "Delivery promise"],
    ["seats", "0", "Seats"],
    ["maxPartySize", "99", "Max party size"],
    ["reservationSlotMinutes", "10", "Reservation length"],
  ] as const)("refuses %s = %j", (field, bad, expected) => {
    expect(error(draft({ [field]: bad } as Partial<RestaurantDraft>))).toContain(expected);
  });

  it("refuses a decimal where the column holds a whole number", () => {
    expect(error(draft({ seats: "40.5" }))).toContain("Seats");
  });

  it("refuses an order type the column's check constraint would reject", () => {
    expect(error(draft({ orderTypes: "dine-in" }))).toContain("pickup, delivery, or both");
  });

  // ── the menu is optional, but what is typed must be right ──────────

  it("allows a restaurant with no menu yet -- it can still answer hours and take messages", () => {
    expect(value(draft({ menu: [] })).menu).toEqual([]);
  });

  it("refuses a category with no name", () => {
    expect(error(draft({ menu: [{ name: "   ", items: [] }] }))).toContain("category needs a name");
  });

  it("refuses an item with no name, naming the category it is in", () => {
    expect(
      error(draft({ menu: [{ name: "Pasta", items: [{ name: "", description: "", priceDollars: "9.00" }] }] })),
    ).toContain("Pasta");
  });

  it("keeps an empty description as null rather than an empty string", () => {
    const items = value(
      draft({ menu: [{ name: "Pasta", items: [{ name: "X", description: "  ", priceDollars: "9.00" }] }] }),
    ).menu[0].items;
    expect(items[0].description).toBeNull();
  });

  // ── the shape of a refusal ─────────────────────────────────────────

  it("refuses the whole draft on the first problem, so nothing is half-written", () => {
    const result = validateRestaurantDraft(draft({ name: "", taxPercent: "nope" }));
    expect(result).toEqual({ ok: false, error: expect.stringContaining("name") });
  });
});
