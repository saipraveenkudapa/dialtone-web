import { describe, expect, it } from "vitest";
import {
  buildOrderLines,
  matchItem,
  normaliseOrderType,
  normaliseQuantity,
  priceOrder,
  MAX_ITEM_QUANTITY,
  MAX_ORDER_LINES,
  type PricedItem,
} from "./orders";

const items: PricedItem[] = [
  { id: "i1", name: "Bucatini Amatriciana", price_cents: 2400, sold_out_until: null },
  { id: "i2", name: "Lasagne Verdi", price_cents: 2600, sold_out_until: null },
  { id: "i3", name: "Squid Ink Tonnarelli", price_cents: 2900, sold_out_until: "close" },
];

describe("matching spoken item names", () => {
  it("matches exactly, ignoring case and spacing", () => {
    expect(matchItem(items, "  lasagne verdi ")?.id).toBe("i2");
  });

  it("matches a partial name the way a caller would say it", () => {
    expect(matchItem(items, "bucatini")?.id).toBe("i1");
  });

  it("returns null rather than guessing between two matches", () => {
    const ambiguous: PricedItem[] = [
      { id: "a", name: "Cheese Pizza", price_cents: 1200, sold_out_until: null },
      { id: "b", name: "Cheese Bread", price_cents: 800, sold_out_until: null },
    ];
    expect(matchItem(ambiguous, "cheese")).toBeNull();
  });

  it("returns null for something not on the menu", () => {
    expect(matchItem(items, "chicken tikka")).toBeNull();
  });

  it("matches a word prefix the way a caller would shorten a name", () => {
    const menu: PricedItem[] = [
      { id: "m1", name: "Margherita", price_cents: 1800, sold_out_until: null },
    ];
    expect(matchItem(menu, "marg")?.id).toBe("m1");
  });

  it("does not match a needle that only appears mid-word (cola vs chocolate)", () => {
    const menu: PricedItem[] = [
      { id: "c1", name: "Chocolate Cake", price_cents: 900, sold_out_until: null },
    ];
    expect(matchItem(menu, "cola")).toBeNull();
  });

  it("does not match a needle that only appears mid-word (apple vs pineapple)", () => {
    const menu: PricedItem[] = [
      { id: "c2", name: "Pineapple Upside-Down Cake", price_cents: 950, sold_out_until: null },
    ];
    expect(matchItem(menu, "apple")).toBeNull();
  });

  it("does not match a needle that only appears mid-word (melon vs watermelon)", () => {
    const menu: PricedItem[] = [
      { id: "c3", name: "Watermelon Salad", price_cents: 700, sold_out_until: null },
    ];
    expect(matchItem(menu, "melon")).toBeNull();
  });

  it("still returns null rather than guessing when a word-prefix match is ambiguous", () => {
    const ambiguous: PricedItem[] = [
      { id: "p1", name: "Margherita Pizza", price_cents: 1400, sold_out_until: null },
      { id: "p2", name: "Marganza Sandwich", price_cents: 1100, sold_out_until: null },
    ];
    expect(matchItem(ambiguous, "marg")).toBeNull();
  });

  it("does not let a short word prefix-match into a longer unrelated word (ham vs hamburger)", () => {
    const menu: PricedItem[] = [
      { id: "h1", name: "Hamburger", price_cents: 1000, sold_out_until: null },
    ];
    expect(matchItem(menu, "ham")).toBeNull();
  });

  it("does not let a short word prefix-match into a longer unrelated word (pie vs pierogi)", () => {
    const menu: PricedItem[] = [
      { id: "pr1", name: "Pierogi", price_cents: 1100, sold_out_until: null },
    ];
    expect(matchItem(menu, "pie")).toBeNull();
  });

  it("still matches a short word exactly against an item actually named that word", () => {
    const menu: PricedItem[] = [
      { id: "hc1", name: "Ham & Cheese", price_cents: 900, sold_out_until: null },
    ];
    expect(matchItem(menu, "ham")?.id).toBe("hc1");
  });

  it("still allows a longer word to prefix-match (marg for Margherita)", () => {
    const menu: PricedItem[] = [
      { id: "m2", name: "Margherita", price_cents: 1800, sold_out_until: null },
    ];
    expect(matchItem(menu, "marg")?.id).toBe("m2");
  });
});

describe("pricing", () => {
  it("adds tax in integer cents", () => {
    const totals = priceOrder(
      [
        { item: items[0], quantity: 2 },
        { item: items[1], quantity: 1 },
      ],
      875,
    );
    expect(totals.subtotal_cents).toBe(7400);
    expect(totals.tax_cents).toBe(648); // 7400 * 0.0875 = 647.5, rounded
    expect(totals.total_cents).toBe(8048);
  });

  it("handles a zero tax rate", () => {
    const totals = priceOrder([{ item: items[1], quantity: 1 }], 0);
    expect(totals).toEqual({
      subtotal_cents: 2600,
      tax_cents: 0,
      total_cents: 2600,
    });
  });

  it("rounds down, not just up, when the tax has a fractional part below one half", () => {
    // 1000 * 433 / 10_000 = 43.3 cents -- Math.round and Math.ceil disagree
    // here (43 vs 44), unlike the exact-half-cent case above, so this
    // catches a mutation that always rounds up and would overcharge most
    // orders.
    const item: PricedItem = { id: "t1", name: "Test Item", price_cents: 1000, sold_out_until: null };
    const totals = priceOrder([{ item, quantity: 1 }], 433);
    expect(totals.tax_cents).toBe(43);
    expect(totals.total_cents).toBe(1043);
  });
});

describe("quantity validation", () => {
  it("rejects a zero quantity rather than silently zeroing out a line", () => {
    expect(() => priceOrder([{ item: items[0], quantity: 0 }], 0)).toThrow();
  });

  it("rejects a negative quantity rather than silently shrinking the subtotal", () => {
    expect(() => priceOrder([{ item: items[0], quantity: -1 }], 0)).toThrow();
  });

  it("rejects a fractional quantity rather than producing fractional cents", () => {
    expect(() => priceOrder([{ item: items[0], quantity: 1.5 }], 0)).toThrow();
  });

  it("still accepts an ordinary positive integer quantity", () => {
    expect(() => priceOrder([{ item: items[0], quantity: 3 }], 0)).not.toThrow();
  });
});

describe("normaliseQuantity", () => {
  it("accepts an ordinary positive integer count", () => {
    expect(normaliseQuantity(3)).toBe(3);
  });

  it("rejects zero rather than treating it as a sane count", () => {
    expect(normaliseQuantity(0)).toBeNull();
  });

  it("rejects a negative count", () => {
    expect(normaliseQuantity(-1)).toBeNull();
  });

  it("rejects a fractional count", () => {
    expect(normaliseQuantity(1.5)).toBeNull();
  });

  it("accepts a numeric string, the way a loosely-typed tool payload might send it", () => {
    expect(normaliseQuantity("4")).toBe(4);
  });

  it("rejects a value that is not a number at all", () => {
    expect(normaliseQuantity("two")).toBeNull();
    expect(normaliseQuantity(undefined)).toBeNull();
    expect(normaliseQuantity(null)).toBeNull();
    expect(normaliseQuantity({})).toBeNull();
  });
});

describe("buildOrderLines", () => {
  it("builds a priced line for each requested item, defaulting quantity to one", () => {
    const result = buildOrderLines(items, [{ name: "lasagne verdi" }, { name: "bucatini", quantity: 2 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.lines).toEqual([
      { item: items[1], quantity: 1 },
      { item: items[0], quantity: 2 },
    ]);
  });

  it("accepts a numeric-string quantity the way a loosely-typed payload might send it", () => {
    const result = buildOrderLines(items, [{ name: "bucatini", quantity: "3" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.lines).toEqual([{ item: items[0], quantity: 3 }]);
  });

  it("reports unknown_item for something not on the menu, rather than throwing", () => {
    const result = buildOrderLines(items, [{ name: "chicken tikka" }]);
    expect(result).toEqual({ ok: false, reason: "unknown_item", item: "chicken tikka" });
  });

  it("reports sold_out for an item flagged out, even though get_menu already said so once", () => {
    const result = buildOrderLines(items, [{ name: "squid ink tonnarelli" }]);
    expect(result).toEqual({ ok: false, reason: "sold_out", item: "Squid Ink Tonnarelli" });
  });

  it("reports bad_quantity for a quantity that cannot be understood, rather than crashing on NaN", () => {
    const result = buildOrderLines(items, [{ name: "bucatini", quantity: "two" }]);
    expect(result).toEqual({ ok: false, reason: "bad_quantity", item: "bucatini" });
  });

  it("reports bad_quantity for a zero or negative quantity", () => {
    expect(buildOrderLines(items, [{ name: "bucatini", quantity: 0 }])).toEqual({
      ok: false,
      reason: "bad_quantity",
      item: "bucatini",
    });
    expect(buildOrderLines(items, [{ name: "bucatini", quantity: -1 }])).toEqual({
      ok: false,
      reason: "bad_quantity",
      item: "bucatini",
    });
  });

  it("reports bad_quantity for a fractional quantity", () => {
    const result = buildOrderLines(items, [{ name: "bucatini", quantity: 1.5 }]);
    expect(result).toEqual({ ok: false, reason: "bad_quantity", item: "bucatini" });
  });

  it("stops at the first item that fails rather than checking the rest", () => {
    const result = buildOrderLines(items, [{ name: "chicken tikka" }, { name: "bucatini", quantity: "two" }]);
    expect(result).toEqual({ ok: false, reason: "unknown_item", item: "chicken tikka" });
  });

  it("hands priceOrder lines it will never throw on, because every quantity already passed normaliseQuantity", () => {
    const result = buildOrderLines(items, [{ name: "bucatini", quantity: 2 }, { name: "lasagne verdi" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // priceOrder's own guard throws on a bad quantity as a last resort;
    // this is the route's actual call path, and it must not throw here.
    expect(() => priceOrder(result.lines, 0)).not.toThrow();
  });
});

describe("reading the order type a caller asked for", () => {
  it("takes the two values the tool contract defines", () => {
    expect(normaliseOrderType("pickup")).toBe("pickup");
    expect(normaliseOrderType("delivery")).toBe("delivery");
  });

  // The bug this replaced: `body.type === "delivery" ? ... : "pickup"`
  // turned every one of these into a PICKUP order and dropped the
  // address with it, so a caller who asked for delivery was told to come
  // and collect.
  it("reads a capitalised or padded delivery as delivery, not as pickup", () => {
    expect(normaliseOrderType("Delivery")).toBe("delivery");
    expect(normaliseOrderType("DELIVERY")).toBe("delivery");
    expect(normaliseOrderType("  delivery  ")).toBe("delivery");
  });

  it("reads a capitalised or padded pickup as pickup", () => {
    expect(normaliseOrderType("Pickup")).toBe("pickup");
    expect(normaliseOrderType(" PICKUP ")).toBe("pickup");
  });

  it("defaults an absent type to pickup, the ordinary case", () => {
    expect(normaliseOrderType(undefined)).toBe("pickup");
    expect(normaliseOrderType(null)).toBe("pickup");
    expect(normaliseOrderType("   ")).toBe("pickup");
  });

  // Refusing and asking is one more question; guessing is a driver sent
  // to an address nobody gave, or a caller waiting at home for food
  // sitting on a pickup shelf.
  it("returns null for a value it cannot recognise rather than guessing pickup", () => {
    expect(normaliseOrderType("takeaway")).toBeNull();
    expect(normaliseOrderType("dine-in")).toBeNull();
    expect(normaliseOrderType("drop it off")).toBeNull();
    expect(normaliseOrderType("")).toBe("pickup");
  });

  it("returns null for a value that is not a string at all", () => {
    expect(normaliseOrderType(1)).toBeNull();
    expect(normaliseOrderType({ type: "delivery" })).toBeNull();
    expect(normaliseOrderType(["delivery"])).toBeNull();
  });
});

describe("the size of a phone order", () => {
  it("takes an order right up to the line limit", () => {
    const requested = Array.from({ length: MAX_ORDER_LINES }, () => ({ name: "bucatini" }));
    expect(buildOrderLines(items, requested).ok).toBe(true);
  });

  it("refuses one line past the limit, before touching any of them", () => {
    const requested = Array.from({ length: MAX_ORDER_LINES + 1 }, () => ({ name: "bucatini" }));
    expect(buildOrderLines(items, requested)).toEqual({
      ok: false,
      reason: "too_many_items",
      item: undefined,
    });
  });

  it("takes a quantity right up to the per-item limit", () => {
    const result = buildOrderLines(items, [{ name: "bucatini", quantity: MAX_ITEM_QUANTITY }]);
    expect(result.ok).toBe(true);
  });

  // A transcript reads "fifty thousand" when someone says "fifteen" down
  // a bad line. Unbounded, that priced and printed as a five-figure
  // ticket; now it is a sentence the agent can say.
  it("refuses one past the per-item limit, and names the item it refused", () => {
    const result = buildOrderLines(items, [{ name: "bucatini", quantity: MAX_ITEM_QUANTITY + 1 }]);
    expect(result).toEqual({
      ok: false,
      reason: "too_many_of_item",
      item: "Bucatini Amatriciana",
    });
  });

  it("refuses a wildly mis-heard quantity", () => {
    const result = buildOrderLines(items, [{ name: "lasagne verdi", quantity: 50000 }]);
    expect(result).toEqual({
      ok: false,
      reason: "too_many_of_item",
      item: "Lasagne Verdi",
    });
  });

  // The limits are duplicated in
  // supabase/migrations/20260812000400_place_order.sql (c_max_lines,
  // c_max_qty), which is the authority. If they drift, this route starts
  // asking the database for orders it will refuse -- so the values are
  // pinned here rather than left implicit.
  it("keeps the limits the database enforces", () => {
    expect(MAX_ORDER_LINES).toBe(40);
    expect(MAX_ITEM_QUANTITY).toBe(50);
  });
});
