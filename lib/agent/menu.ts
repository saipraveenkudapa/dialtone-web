import { matchesSpokenName } from "@/lib/agent/orders";
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
 *  the sale when something runs out. `itemName` ultimately comes from the
 *  JSON body of a request made by an external voice platform, so its
 *  shape is not ours to assume -- `unknown` here (rather than `string`)
 *  is the honest type, and a non-string is treated the same as no item
 *  at all instead of throwing out of `.trim()`.
 *
 *  Matching is `matchesSpokenName` (lib/agent/orders.ts), the same
 *  predicate that turns a spoken word into an order line. It used to be
 *  an exact, whole-name comparison, and the two had drifted: a caller who
 *  says "wings" gets an order line, because Buffalo Wings is the only
 *  item whose words that matches -- but asking about "wings" when they
 *  were sold out returned no alternative at all, because nothing on the
 *  menu is literally named "wings". So the prompt's "do not just say no,
 *  offer the closest thing that is available" had nothing behind it at
 *  the exact moment it exists for. Callers say words, not menu titles;
 *  one matcher, used by both, is the only way that keeps being true.
 *
 *  An available item that ALSO answers what the caller said is the best
 *  suggestion there is -- "we're out of the buffalo wings, but the
 *  boneless are still going" -- so those are preferred over anything else
 *  in the category. The item named outright is excluded either way: an
 *  in-stock item offered as its own alternative is a non-answer. */
export function suggestAlternative(menu: AgentMenu, itemName: unknown) {
  if (typeof itemName !== "string") return null;
  const spoken = itemName.trim();
  if (spoken === "") return null;
  const needle = spoken.toLowerCase();

  const offerable = (i: AgentMenuItem) => !i.sold_out && i.name.toLowerCase() !== needle;

  for (const category of menu.categories) {
    const matched = category.items.filter((i) => matchesSpokenName(i.name, spoken));
    if (matched.length === 0) continue;
    const available = matched.find(offerable) ?? category.items.find(offerable);
    return available?.name ?? null;
  }
  return null;
}
