import type { MenuCategoryWithItems } from "@/lib/data";

export type AgentMenuItem = { name: string; price: string; sold_out: boolean };
export type AgentMenu = {
  categories: { name: string; items: AgentMenuItem[] }[];
  sold_out: string[];
};

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The menu as the agent should hear it: names, spoken prices, and an
 *  explicit sold-out flag. Sold-out items are still included so the agent
 *  can say "we're out of that" instead of "we don't have that" -- the
 *  second sounds like the caller misremembered the restaurant. */
export function shapeMenu(categories: MenuCategoryWithItems[]): AgentMenu {
  const soldOut: string[] = [];

  const shaped = categories.map((category) => ({
    name: category.name,
    items: category.items.map((item) => {
      const isOut = item.sold_out_until !== null;
      if (isOut) soldOut.push(item.name);
      return {
        name: item.name,
        price: dollars(item.price_cents),
        sold_out: isOut,
      };
    }),
  }));

  return { categories: shaped, sold_out: soldOut };
}

/** The nearest available item in the same category, which is what saves
 *  the sale when something runs out. */
export function suggestAlternative(menu: AgentMenu, itemName: string) {
  const needle = itemName.trim().toLowerCase();

  for (const category of menu.categories) {
    const match = category.items.some((i) => i.name.toLowerCase() === needle);
    if (!match) continue;
    const available = category.items.find(
      (i) => !i.sold_out && i.name.toLowerCase() !== needle,
    );
    return available?.name ?? null;
  }
  return null;
}
