import { describe, expect, it } from "vitest";
import { matchItem, priceOrder, type PricedItem } from "./orders";

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
