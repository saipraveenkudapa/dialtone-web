import { describe, expect, it } from "vitest";
import { shapeMenu, suggestAlternative } from "./menu";

import type { MenuCategoryWithItems } from "@/lib/data";
import type { PickLabel } from "@/lib/supabase/types";

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
  extra: {
    description?: string | null;
    allergen_note?: string | null;
    pick_label?: PickLabel | null;
  } = {},
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
    pick_label: null,
    sort_order: 1,
    updated_at: "2026-08-12T00:00:00Z",
    ...extra,
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

describe("what a dish comes with", () => {
  // The description is the only field on a menu item a person actually
  // wrote or confirmed -- typed in the editor (whose placeholder for the
  // box is literally "Black pepper, pecorino") or moved there, line by
  // line, from an import somebody signed off. Handing it to the agent as
  // `ingredients` is what lets it describe a dish at all.
  it("carries the description a person wrote, as ingredients", () => {
    const pepe = item("i9", "Cacio e Pepe", 2200, null, {
      description: "Black pepper, pecorino",
    });
    const menu = shapeMenu(category([pepe]));
    expect(menu.categories[0].items[0].ingredients).toBe("Black pepper, pecorino");
  });

  // Not `null`, not `""` -- the key is not there at all. get_menu is
  // fetched live on every call that mentions food and sits in the latency
  // budget, and today every one of Nonna Rosa's fourteen items has an
  // empty description: a null per item, on every call, forever, buys
  // nothing. `toHaveProperty` rather than a truthiness check, because
  // `{ingredients: undefined}` would pass the latter and still be a key
  // on the wire.
  it("says nothing at all when nobody wrote anything", () => {
    const menu = shapeMenu(categories);
    expect(menu.categories[0].items[0]).not.toHaveProperty("ingredients");
    expect(JSON.stringify(menu)).not.toContain("ingredients");
  });

  it("treats a whitespace-only description as nothing written", () => {
    const blank = item("i9", "Affogato", 900, null, { description: "   " });
    const menu = shapeMenu(category([blank]));
    expect(menu.categories[0].items[0]).not.toHaveProperty("ingredients");
  });

  it("trims what it does send", () => {
    const padded = item("i9", "Affogato", 900, null, {
      description: "  Espresso, fior di latte  ",
    });
    const menu = shapeMenu(category([padded]));
    expect(menu.categories[0].items[0].ingredients).toBe("Espresso, fior di latte");
  });

  // The one that costs a restaurant money if it ever goes the other way.
  // allergen_note is staff reference text on the row right next to the
  // description; the schema comment on it says outright that the agent
  // must never answer from it, and the prompt transfers every allergy
  // question to a person. If it ever reached this payload, a model would
  // have an allergen claim in its context on every call, and "never
  // answer an allergy question" would be the only thing standing between
  // that claim and a caller with coeliac disease. It must not be in the
  // bytes at all.
  it("never carries the allergen note, not under any key", () => {
    const risky = item("i9", "Lasagne Verdi", 2600, null, {
      description: "Spinach pasta, ragù, besciamella",
      allergen_note: "Contains gluten, dairy and egg",
    });
    const menu = shapeMenu(category([risky]));
    const wire = JSON.stringify(menu);
    expect(wire).not.toContain("allergen");
    expect(wire).not.toContain("gluten");
    expect(menu.categories[0].items[0].ingredients).toBe(
      "Spinach pasta, ragù, besciamella",
    );
  });

  // A sold-out item is still described: "what's in the squid ink one?"
  // is a fair question about a dish the caller cannot have tonight, and
  // an agent that goes quiet on it sounds like it does not know its own
  // menu.
  it("still describes an item that is sold out", () => {
    const out = item("i9", "Squid Ink Tonnarelli", 2900, "close", {
      description: "Squid ink, chilli, breadcrumb",
    });
    const menu = shapeMenu(category([out]));
    expect(menu.categories[0].items[0].sold_out).toBe(true);
    expect(menu.categories[0].items[0].ingredients).toBe("Squid ink, chilli, breadcrumb");
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

describe("picks in the agent payload", () => {
  // The whole point of the change this file was rewritten for: the
  // payload carries the WORDS, and the prompt no longer names a phrase.
  // A third kind of pick later is one entry in PICK_PHRASE and costs the
  // prompt nothing.
  it("carries the spoken phrase for a pick that is on offer", () => {
    const menu = shapeMenu(
      category([item("i1", "Bucatini", 1800, null, { pick_label: "best_seller" })]),
    );
    expect(menu.categories[0].items[0].pick).toBe("a best seller");
  });

  it("carries the other kind, worded so it can be spoken as it stands", () => {
    const menu = shapeMenu(
      category([item("i1", "Bucatini", 1800, null, { pick_label: "chefs_special" })]),
    );
    expect(menu.categories[0].items[0].pick).toBe("the chef's special");
  });

  // The sentence the prompt builds is "it is <pick>", so each phrase
  // carries its own article: "it is a best seller", "it is the chef's
  // special". A phrase without one would leave the agent to invent the
  // determiner, and the obvious invention -- "the restaurant's chef's
  // special" -- is a double possessive no host would say out loud.
  it("reads naturally after the words the prompt puts in front of it", () => {
    for (const label of ["best_seller", "chefs_special"] as const) {
      const menu = shapeMenu(category([item("i1", "Bucatini", 1800, null, { pick_label: label })]));
      const spoken = `it is ${menu.categories[0].items[0].pick}`;
      expect(spoken).toMatch(/^it is (a|the) /);
      expect(spoken).not.toContain("'s chef's");
    }
  });

  it("leaves the key off an ordinary item entirely", () => {
    const menu = shapeMenu(category([item("i1", "Cacio e Pepe", 1800, null, { pick_label: null })]));
    // Absent, not null and not "": this payload is fetched on every call
    // that mentions food and sits in the latency budget.
    expect("pick" in menu.categories[0].items[0]).toBe(false);
  });

  it("suppresses a pick that is sold out until reopen", () => {
    const menu = shapeMenu(category([
      item("i1", "Bucatini", 1800, "reopen", { pick_label: "best_seller" }),
    ]));
    // Praising a dish and refusing it in the same breath is worse than
    // saying nothing. The label was set weeks ago; sold-out was set this
    // afternoon, and the fresher fact wins.
    expect("pick" in menu.categories[0].items[0]).toBe(false);
    expect(menu.categories[0].items[0].sold_out).toBe(true);
  });

  it("suppresses a pick that is sold out until close", () => {
    const menu = shapeMenu(category([
      item("i1", "Bucatini", 1800, "close", { pick_label: "chefs_special" }),
    ]));
    expect("pick" in menu.categories[0].items[0]).toBe(false);
  });

  // A value the map has no phrase for is not a value the agent can say.
  // The column's own check constraint refuses one, and validateMenuItem
  // refuses one before that -- but a payload built from a row that got
  // past both would otherwise put `undefined` on the wire.
  it("says nothing at all about a label it has no words for", () => {
    const menu = shapeMenu(
      category([
        item("i1", "Bucatini", 1800, null, {
          pick_label: "house_favourite" as unknown as PickLabel,
        }),
      ]),
    );
    expect("pick" in menu.categories[0].items[0]).toBe(false);
  });
});
