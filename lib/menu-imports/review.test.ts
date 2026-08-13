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
  publishArrays,
  publishBlocker,
  readExtraction,
  reviewCounts,
  toPublishItems,
  usedCategories,
  type PublishItem,
  type ReviewDraft,
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
    const added = blankItem("c0", "h1");
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
