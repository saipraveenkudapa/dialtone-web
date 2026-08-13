import { describe, expect, it } from "vitest";
import { normalizeExtraction } from "@/lib/menu-imports/extraction";
import {
  MAX_PUBLISH_ITEMS,
  blankItem,
  draftFromExtraction,
  itemBlocker,
  itemCents,
  itemEdited,
  itemFlags,
  nextPosition,
  publishArrays,
  publishBlocker,
  readExtraction,
  restoreItem,
  reviewCounts,
  toPublishItems,
  usedCategories,
  type PublishItem,
  type ReviewDraft,
  type ReviewItem,
} from "@/lib/menu-imports/review";

/* The human gate, as data.
 *
 * The tests that matter here are the refusals. A review screen that
 * quietly turned an unread price into $0.00, or let a menu go live with
 * one item nobody had looked at, would be indistinguishable from a screen
 * that worked -- right up until a caller was quoted the wrong number. */

const FILES = [
  { index: 0, filename: "front.jpg", source_type: "image" as const },
  { index: 1, filename: "back.jpg", source_type: "image" as const },
];

/** A model's answer, put through the real normaliser -- so these tests
 *  read the same shape the database stores. */
function extractionOf(categories: unknown[]) {
  const extraction = normalizeExtraction(
    { document_kind: "menu", note: "", language: "Italian", categories },
    { file: FILES[0], files: FILES, model: "claude-opus-5", readAt: "2026-08-13T00:00:00.000Z" },
  );
  if (!extraction) throw new Error("fixture did not normalize");
  return extraction;
}

const item = (over: Record<string, unknown> = {}) => ({
  name: "Bruschetta",
  name_confidence: "confident",
  price_as_printed: "9.00",
  price_confidence: "confident",
  description: "Tomato and basil",
  description_confidence: "confident",
  ingredients: [],
  ingredients_confidence: "confident",
  file_index: 0,
  ...over,
});

const category = (name: string, items: unknown[], confidence = "confident") => ({
  name,
  name_confidence: confidence,
  items,
});

function draftOf(categories: unknown[]): ReviewDraft {
  return draftFromExtraction(extractionOf(categories));
}

const confirmAll = (draft: ReviewDraft): ReviewDraft => ({
  ...draft,
  items: draft.items.map((i) => ({ ...i, confirmed: true })),
});

describe("readExtraction", () => {
  it("opens a stored extraction", () => {
    const stored = JSON.parse(JSON.stringify(extractionOf([category("Antipasti", [item()])])));
    expect(readExtraction(stored)?.categories[0].items[0].name).toBe("Bruschetta");
  });

  it("refuses a row written by some other version rather than half-showing it", () => {
    expect(readExtraction(null)).toBeNull();
    expect(readExtraction({})).toBeNull();
    expect(readExtraction({ schema_version: 2, document: {}, categories: [], files: [] })).toBeNull();
    expect(readExtraction({ schema_version: 1, categories: [], files: [] })).toBeNull();
  });
});

describe("the draft a person works on", () => {
  it("arrives with nothing confirmed -- that is the whole point", () => {
    const draft = draftOf([category("Antipasti", [item(), item({ name: "Olive" })])]);
    expect(draft.items).toHaveLength(2);
    expect(draft.items.every((i) => !i.confirmed)).toBe(true);
    expect(reviewCounts(draft).unconfirmed).toBe(2);
  });

  it("leaves a price the model could not read empty, never zero", () => {
    const draft = draftOf([
      category("Secondi", [item({ price_as_printed: "market price", price_confidence: "unknown" })]),
    ]);
    expect(draft.items[0].price).toBe("");
    expect(itemCents(draft.items[0])).toBeNull();
    expect(itemBlocker(draft.items[0])).toMatch(/Type this item's price/);
    expect(itemFlags(draft.items[0])[0]).toContain("market price");
  });

  it("cannot confirm an item whose price is not a plain amount", () => {
    const draft = draftOf([category("Pizze", [item()])]);
    const typed = { ...draft.items[0], price: "10-14" };
    expect(itemBlocker(typed)).toMatch(/not a plain amount/);
    expect(itemBlocker({ ...typed, price: "12.50" })).toBeNull();
    expect(itemBlocker({ ...typed, price: "12.505" })).toMatch(/not a plain amount/);
    expect(itemBlocker({ ...typed, name: "  " })).toMatch(/needs a name|Give this item a name/);
  });

  it("refuses a price nobody could have meant", () => {
    const draft = draftOf([category("Pizze", [item()])]);
    expect(itemBlocker({ ...draft.items[0], price: "10001.00" })).toMatch(/over \$10,000/);
  });

  it("flags what the model was unsure about, and only that", () => {
    const draft = draftOf([
      category("Pizze", [
        item({ name_confidence: "unsure" }),
        item({ name: "Margherita", price_confidence: "unsure" }),
        item({ name: "Diavola" }),
      ]),
    ]);
    expect(itemFlags(draft.items[0])).toEqual(["The name was hard to read."]);
    expect(itemFlags(draft.items[1])[0]).toMatch(/price was hard to read/);
    expect(itemFlags(draft.items[2])).toEqual([]);
  });

  it("knows when a person has changed what the model proposed", () => {
    const draft = draftOf([category("Antipasti", [item()])]);
    const original = draft.items[0];
    expect(itemEdited(original)).toBe(false);
    // The same money, typed differently, is not a correction.
    expect(itemEdited({ ...original, price: "9" })).toBe(false);
    expect(itemEdited({ ...original, price: "9.50" })).toBe(true);
    expect(itemEdited({ ...original, name: "Bruschette" })).toBe(true);
  });

  it("gives an item a person adds no model to check, and counts it as done", () => {
    const added = blankItem("c0", "h1", 0);
    expect(added.origin).toBe("human");
    expect(added.confirmed).toBe(true);
    expect(added.said).toBeNull();
    expect(itemFlags(added)).toEqual([]);
    expect(itemEdited(added)).toBe(false);
    // Confirmed is not the same as publishable: it still needs a price.
    expect(itemBlocker(added)).toMatch(/Give this item a name/);
  });

  it("drops a section every item was removed from", () => {
    const draft = draftOf([
      category("Antipasti", [item()]),
      category("Dolci", [item({ name: "Tiramisu" })]),
    ]);
    const emptied = { ...draft, items: draft.items.filter((i) => i.categoryKey !== "c1") };
    expect(usedCategories(emptied).map((c) => c.name)).toEqual(["Antipasti"]);
  });
});

/* Taking an item out and putting it back.
 *
 * The one action on this screen that can quietly change the order of a
 * menu. The order matters twice: it is the order somebody reads the list
 * in while checking it against the photograph, and it is the sort_order
 * the assistant later reads the menu to a caller in. Ordering the list by
 * key put "c0i10" before "c0i2", so every section of eleven items or more
 * came back reordered -- which is why these fixtures are long. */
describe("remove and put back", () => {
  /** A section long enough that a string sort over "c0i2"/"c0i10" is
   *  wrong: twelve dishes, named for their place on the card. */
  const longSection = () =>
    draftOf([
      category(
        "Antipasti",
        Array.from({ length: 12 }, (_, i) =>
          item({ name: `Dish ${i}`, price_as_printed: `${i + 5}.00` }),
        ),
      ),
    ]);

  /** What the screen does when somebody presses Remove. */
  const without = (draft: ReviewDraft, key: string): ReviewItem[] =>
    draft.items.filter((i) => i.key !== key);

  it("numbers every row in the order the card printed it", () => {
    const draft = draftOf([
      category("Antipasti", [item(), item({ name: "Olive" })]),
      category("Dolci", [item({ name: "Tiramisu" })]),
    ]);
    // One run of numbers across the whole menu, not one per section, so
    // any two rows can be compared.
    expect(draft.items.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it("puts a row back exactly where it was, on a section keys sort wrong", () => {
    const draft = longSection();
    const card = draft.items.map((i) => i.name);
    // "c0i10" sorts before "c0i2": the two rows a key sort swaps.
    expect("c0i10".localeCompare("c0i2", "en")).toBeLessThan(0);

    const taken = draft.items[2];
    expect(taken.key).toBe("c0i2");
    expect(restoreItem(without(draft, taken.key), taken).map((i) => i.name)).toEqual(card);
  });

  it("moves nothing else when a row goes back in", () => {
    const draft = longSection();
    const taken = draft.items[10];
    const left = without(draft, taken.key);
    const back = restoreItem(left, taken);
    // Every other row is the same object in the same relative order.
    expect(back.filter((i) => i.key !== taken.key)).toEqual(left);
    expect(back.map((i) => i.position)).toEqual(
      [...back].map((i) => i.position).sort((a, b) => a - b),
    );
  });

  it("gets the card back however many rows are taken out, in any order", () => {
    const draft = longSection();
    const card = draft.items.map((i) => i.name);
    const takenKeys = ["c0i2", "c0i10", "c0i0", "c0i11", "c0i7"];
    const taken = takenKeys.map((k) => draft.items.find((i) => i.key === k)!);

    let items = draft.items.filter((i) => !takenKeys.includes(i.key));
    // Put back newest-first, which is the order the removed list offers.
    for (const item of [...taken].reverse()) items = restoreItem(items, item);

    expect(items.map((i) => i.name)).toEqual(card);
  });

  it("publishes a put-back menu in the order shown on the screen", () => {
    const draft = confirmAll(longSection());
    const taken = draft.items[2];
    const restored = { ...draft, items: restoreItem(without(draft, taken.key), taken) };
    expect(toPublishItems(restored).map((i) => i.name)).toEqual(
      draft.items.map((i) => i.name),
    );
  });

  it("puts a row a person added back where they added it, not among the model's", () => {
    const draft = longSection();
    const added = blankItem("c0", "h1", nextPosition(draft.items, []));
    const withAdded = [...draft.items, added];
    expect(restoreItem(draft.items, added)).toEqual(withAdded);
    // And it stays at the end after a round trip through Remove.
    expect(restoreItem(draft.items, added).map((i) => i.key).at(-1)).toBe("h1");
  });

  it("gives an added row a place past one still sitting in the removed pile", () => {
    const draft = longSection();
    const removed = [draft.items[3]];
    const kept = without(draft, "c0i3");
    const added = blankItem("c0", "h1", nextPosition(kept, removed));
    // Past the whole card, removed rows included, so putting that row
    // back afterwards cannot land on top of the added one.
    expect(added.position).toBe(12);
    const items = restoreItem([...kept, added], removed[0]);
    expect(items.map((i) => i.key).at(-1)).toBe("h1");
    expect(items.map((i) => i.name)).toEqual([...draft.items.map((i) => i.name), ""]);
  });
});

describe("publishBlocker", () => {
  it("blocks while a single item is unconfirmed, and says how many", () => {
    const draft = draftOf([category("Antipasti", [item(), item({ name: "Olive" })])]);
    expect(publishBlocker(draft)).toBe("2 items still have to be confirmed.");

    const one = { ...draft, items: [{ ...draft.items[0], confirmed: true }, draft.items[1]] };
    expect(publishBlocker(one)).toBe("1 item still has to be confirmed.");

    expect(publishBlocker(confirmAll(draft))).toBeNull();
  });

  it("blocks a confirmed item whose price stopped being an amount", () => {
    const draft = confirmAll(draftOf([category("Antipasti", [item()])]));
    const broken = { ...draft, items: [{ ...draft.items[0], price: "ask" }] };
    expect(publishBlocker(broken)).toMatch(/Bruschetta: "ask" is not a plain amount/);
  });

  it("blocks a menu with nothing left in it", () => {
    const draft = draftOf([category("Antipasti", [item()])]);
    expect(publishBlocker({ ...draft, items: [] })).toMatch(/nothing left to publish/);
  });
});

describe("publishArrays -- the gate, on the server", () => {
  const line = (over: Partial<PublishItem> = {}): PublishItem => ({
    category: "Antipasti",
    name: "Bruschetta",
    price: "9.00",
    description: "Tomato and basil",
    confirmed: true,
    ...over,
  });

  it("turns dollars into integer cents, once", () => {
    const result = publishArrays([
      line({ price: "9" }),
      line({ name: "Olive", price: "6.05" }),
      line({ name: "Focaccia", price: "0" }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrays.itemPricesCents).toEqual([900, 605, 0]);
    // Not a float in sight: every one of these is an integer.
    expect(result.arrays.itemPricesCents.every(Number.isInteger)).toBe(true);
  });

  it("refuses the whole publish when one item is unconfirmed", () => {
    const result = publishArrays([line(), line({ name: "Olive", confirmed: false })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Olive");
    expect(result.error).toContain("has not been confirmed");
  });

  it("refuses a price that is not a plain amount rather than dropping the item", () => {
    for (const price of ["", "market price", "10-14", "$9.00", "12.505", "-3", "9,50"]) {
      const result = publishArrays([line({ price })]);
      expect(result.ok, `price ${JSON.stringify(price)} must be refused`).toBe(false);
    }
  });

  it("refuses a nameless item and a sectionless one", () => {
    expect(publishArrays([line({ name: "   " })]).ok).toBe(false);
    expect(publishArrays([line({ category: "  " })]).ok).toBe(false);
  });

  it("refuses an empty list, and one past what a menu can hold", () => {
    expect(publishArrays([]).ok).toBe(false);
    const many = Array.from({ length: MAX_PUBLISH_ITEMS + 1 }, (_, n) =>
      line({ name: `Item ${n}` }),
    );
    expect(publishArrays(many).ok).toBe(false);
  });

  it("files items under sections by index, folding names that differ only in case", () => {
    const result = publishArrays([
      line({ category: "Antipasti" }),
      line({ category: "Pizze", name: "Margherita", price: "16.50" }),
      line({ category: "antipasti", name: "Olive", price: "6.00" }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrays.categoryNames).toEqual(["Antipasti", "Pizze"]);
    expect(result.arrays.itemCategory).toEqual([0, 1, 0]);
    expect(result.arrays.itemNames).toEqual(["Bruschetta", "Margherita", "Olive"]);
  });

  it("stores an empty description as an empty string, for the function to null out", () => {
    const result = publishArrays([line({ description: "   " })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.arrays.itemDescriptions).toEqual([""]);
  });

  it("sends nothing but names, prices and descriptions -- no ingredients", () => {
    const result = publishArrays([line()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.arrays).sort()).toEqual([
      "categoryNames",
      "itemCategory",
      "itemDescriptions",
      "itemNames",
      "itemPricesCents",
    ]);
  });
});

describe("toPublishItems", () => {
  it("keeps the card's own order: sections as printed, items within them", () => {
    const draft = confirmAll(
      draftOf([
        category("Antipasti", [item(), item({ name: "Olive", price_as_printed: "6.00" })]),
        category("Dolci", [item({ name: "Tiramisu", price_as_printed: "11.00" })]),
      ]),
    );
    expect(toPublishItems(draft).map((i) => `${i.category}/${i.name}`)).toEqual([
      "Antipasti/Bruschetta",
      "Antipasti/Olive",
      "Dolci/Tiramisu",
    ]);
  });

  it("carries a renamed section through to every item under it", () => {
    const draft = confirmAll(draftOf([category("Antipsti", [item()])]));
    const renamed = {
      ...draft,
      categories: draft.categories.map((c) => ({ ...c, name: "Antipasti" })),
    };
    expect(toPublishItems(renamed)[0].category).toBe("Antipasti");
  });

  it("hands the unconfirmed flag through, so the server can refuse it", () => {
    const draft = draftOf([category("Antipasti", [item()])]);
    expect(toPublishItems(draft)[0].confirmed).toBe(false);
    expect(publishArrays(toPublishItems(draft)).ok).toBe(false);
  });
});
