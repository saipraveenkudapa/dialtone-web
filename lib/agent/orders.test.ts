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
});
