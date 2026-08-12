import { describe, expect, it } from "vitest";
import { shapeMenu, suggestAlternative } from "./menu";

import type { MenuCategoryWithItems } from "@/lib/data";

const category = (items: MenuCategoryWithItems["items"]) =>
  [
    {
      id: "c1",
      location_id: "l1",
      name: "Wings",
      sort_order: 1,
      created_at: "2026-08-12T00:00:00Z",
      items,
    },
  ] as MenuCategoryWithItems[];

const item = (
  id: string,
  name: string,
  price_cents: number,
  sold_out_until: "close" | "reopen" | null,
) =>
  ({
    id,
    category_id: "c1",
    location_id: "l1",
    name,
    description: null,
    price_cents,
    sold_out_until,
    allergen_note: null,
    sort_order: 1,
    updated_at: "2026-08-12T00:00:00Z",
  }) as MenuCategoryWithItems["items"][number];

const buffalo = item("i1", "Buffalo Wings", 1400, "close");
const boneless = item("i2", "Boneless Wings", 1200, null);
const categories = category([buffalo, boneless]);

describe("menu shaping", () => {
  it("speaks prices as dollars, not cents", () => {
    const menu = shapeMenu(categories);
    expect(menu.categories[0].items[1].price).toBe("$12.00");
  });

  it("marks sold out items and lists them", () => {
    const menu = shapeMenu(categories);
    expect(menu.categories[0].items[0].sold_out).toBe(true);
    expect(menu.sold_out).toEqual(["Buffalo Wings"]);
  });

  it("suggests the nearest available item in the same category", () => {
    const menu = shapeMenu(categories);
    expect(suggestAlternative(menu, "Buffalo Wings")).toBe("Boneless Wings");
  });

  it("suggests nothing when the whole category is out", () => {
    const allOut = shapeMenu(category([buffalo]));
    expect(suggestAlternative(allOut, "Buffalo Wings")).toBeNull();
  });

  it("treats a non-string item as if none was given, instead of throwing", () => {
    // The route hands this whatever `item` a request body contained,
    // typed and all -- a hostile or buggy voice-platform caller can send
    // a number, an object, or an array here just as easily as a string.
    const menu = shapeMenu(categories);
    expect(suggestAlternative(menu, 42)).toBeNull();
    expect(suggestAlternative(menu, { name: "Buffalo Wings" })).toBeNull();
    expect(suggestAlternative(menu, ["Buffalo Wings"])).toBeNull();
    expect(suggestAlternative(menu, null)).toBeNull();
  });
});

describe("suggesting an alternative for a word a caller actually said", () => {
  // The matcher here and the one that builds an order line were two
  // different matchers, and they had drifted: "wings" is enough to order
  // Buffalo Wings, but asking about "wings" when they were sold out
  // matched nothing at all, because no item is literally named "wings".
  it("matches a spoken word, not just the exact menu name", () => {
    const menu = shapeMenu(categories);
    expect(suggestAlternative(menu, "wings")).toBe("Boneless Wings");
  });

  it("prefers an available item that still answers what the caller asked for", () => {
    const soup = item("i3", "Minestrone", 900, null);
    const menu = shapeMenu(category([buffalo, soup, boneless]));
    // Minestrone comes first in the category and is available, but
    // "boneless wings" is what the caller will actually accept.
    expect(suggestAlternative(menu, "wings")).toBe("Boneless Wings");
  });

  it("falls back to anything available in the category when nothing else matches the words", () => {
    const soup = item("i3", "Minestrone", 900, null);
    const menu = shapeMenu(category([buffalo, soup]));
    expect(suggestAlternative(menu, "buffalo")).toBe("Minestrone");
  });

  it("never offers the item the caller just asked for back to them", () => {
    const menu = shapeMenu(category([boneless]));
    expect(suggestAlternative(menu, "Boneless Wings")).toBeNull();
  });

  it("treats a blank or whitespace item as no item at all", () => {
    const menu = shapeMenu(categories);
    expect(suggestAlternative(menu, "")).toBeNull();
    expect(suggestAlternative(menu, "   ")).toBeNull();
  });
});
