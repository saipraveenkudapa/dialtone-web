import { matchesSpokenName } from "@/lib/agent/orders";
import type { MenuCategoryWithItems } from "@/lib/data";
import type { PickLabel } from "@/lib/supabase/types";

export type AgentMenuItem = {
  name: string;
  price: string;
  sold_out: boolean;
  /** What the dish generally comes with, read to callers off
   *  `menu_items.description` -- the editor's own placeholder for that
   *  box is "Black pepper, pecorino".
   *
   *  Text a model wrote can reach this column: an import pre-fills the
   *  editable description box with the extraction's own words
   *  (lib/menu-imports/review.ts, `draftFromExtraction`), and publishing
   *  passes those strings straight through as p_item_descriptions. What
   *  keeps unread words out of a caller's ear is not the column, it is
   *  the per-item `confirmed` flag, which `publishArrays` in that same
   *  file checks on every row, server-side. The invariant is "not
   *  without a per-item confirmation", not "no model text here". Relax
   *  that gate -- auto-confirm the rows the model was sure about, say --
   *  and a hallucinated description is spoken aloud as what the dish
   *  contains.
   *
   *  Optional, and genuinely absent rather than `null` or `""`, on the
   *  items that have nothing to say: this payload is fetched live on
   *  every call that mentions food and sits in the latency budget, so a
   *  menu whose descriptions are all empty (Nonna Rosa's is, today) pays
   *  nothing at all for this field.
   *
   *  `allergen_note` is NOT here and must never be. It is reference text
   *  for staff; an allergy question is transferred to a person, never
   *  answered from a column -- see the hard rule in lib/agent/prompt.ts,
   *  and the same reasoning on menu_imports.raw_extraction. */
  ingredients?: string;

  /** WHAT THE AGENT SAYS about a dish the restaurant nominated -- the
   *  words, not a flag. The prompt's rule is now one line that speaks
   *  whatever arrives here, so a third kind of pick is one entry in
   *  PICK_PHRASE below and costs the prompt nothing at all.
   *
   *  Absent rather than empty on ordinary items, for the same latency
   *  reason `ingredients` is, and absent on a pick that is SOLD OUT:
   *  praising a dish and then refusing it in the same breath is worse
   *  than saying nothing. Suppressing it here rather than in the prompt
   *  means the agent is never holding a contradiction it has to reason
   *  its way out of mid-call. */
  pick?: string;
};

/** The two kinds of pick, in the words a caller hears.
 *
 *  DETERMINERS INCLUDED, and that is the whole design of these strings.
 *  The prompt says the agent may say once that a dish "is that pick", so
 *  the sentence it builds is `it is ` + this value: "it is one of our
 *  best sellers", "it is the chef's special". A bare "best seller" or
 *  "chef's special" would leave the agent to supply the determiner
 *  itself, and its most obvious form for the second is the double
 *  possessive "the restaurant's chef's special". No host says that out
 *  loud.
 *
 *  THE TWO ARE NOT SYMMETRIC, because the two claims are not the same
 *  claim, and each of them is only safe for its own reason.
 *
 *  "one of our best sellers" is a statement of fact about sales, and it
 *  is PARTITIVE BY CONSTRUCTION rather than by an article. What the
 *  restaurant asserted is that a dish sells well -- one of several -- not
 *  that it outsells everything else on the menu. The prompt orders a
 *  paraphrase of this string ("a phrase, not a name, so say it in the
 *  caller's language"), so whatever limit the claim carries has to be
 *  the kind that survives being reworded. "a best seller" is not: few
 *  languages have a natural indefinite for it, so the fluent form a model
 *  reaches for is a definite superlative -- "es el plato mas vendido",
 *  "our star dish" -- which upgrades a modest claim into one the
 *  restaurant never made. "one of" translates as the partitive it is
 *  ("uno de nuestros platos mas vendidos") because there is nothing else
 *  it can be. Nothing in the prompt would catch the inflation either: it
 *  forbids inventing a special, a deal, a discount, an item, a price, a
 *  time or a policy, and a popularity claim is none of those. Two dishes
 *  may both be best sellers, and a caller told about both has been told
 *  nothing contradictory.
 *
 *  "the chef's special" is definite on purpose -- a kitchen has one --
 *  and that is only true because the database makes it true.
 *  menu_items_one_chefs_special_idx admits one per location, so the
 *  agent's two-picks-per-call allowance cannot be spent naming two
 *  different dishes "the chef's special" to the same caller. Drop that
 *  index and this string has to lose its article.
 *
 *  English, and the agent does NOT repeat it in English. This is the
 *  opposite kind of string from an item name: a name is a thing on a
 *  ticket and is spoken exactly as it arrives, while this is a concept a
 *  Spanish caller should hear in Spanish, said the way a native speaker
 *  would say it. The prompt rule says which of the two kinds this is, in
 *  as many words, because the never-translate rule for names would
 *  otherwise capture it by proximity.
 *
 *  Not read from the database and not built from the column value: a
 *  code that has no phrase here is a code the agent cannot say, so the
 *  lookup below simply omits the key rather than putting `undefined` on
 *  the wire. */
export const PICK_PHRASE: Record<PickLabel, string> = {
  best_seller: "one of our best sellers",
  chefs_special: "the chef's special",
};

export type AgentMenu = {
  categories: { name: string; items: AgentMenuItem[] }[];
  sold_out: string[];
};

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The menu as the agent should hear it: names, spoken prices, and an
 *  explicit sold-out flag, plus what a dish comes with where somebody
 *  wrote it down. Sold-out items are still included so the agent
 *  can say "we're out of that" instead of "we don't have that" -- the
 *  second sounds like the caller misremembered the restaurant. */
export function shapeMenu(categories: MenuCategoryWithItems[]): AgentMenu {
  const soldOut: string[] = [];

  const shaped = categories.map((category) => ({
    name: category.name,
    items: category.items.map((item) => {
      const isOut = item.sold_out_until !== null;
      if (isOut) soldOut.push(item.name);
      const ingredients = item.description?.trim();
      const pick = isOut || !item.pick_label ? undefined : PICK_PHRASE[item.pick_label];
      return {
        name: item.name,
        price: dollars(item.price_cents),
        sold_out: isOut,
        // Spread, not `ingredients: ... ?? undefined`: an explicit
        // `undefined` property is a key in the object, and this shape is
        // JSON.stringify'd onto the wire on every call.
        ...(ingredients ? { ingredients } : {}),
        ...(pick ? { pick } : {}),
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
