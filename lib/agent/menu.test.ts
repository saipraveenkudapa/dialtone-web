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
});
