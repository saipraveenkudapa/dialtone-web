import { parseDollarsToCents } from "@/lib/money";
import {
  EXTRACTION_SCHEMA_VERSION,
  type Confidence,
  type ExtractedItem,
  type MenuExtraction,
} from "@/lib/menu-imports/extraction";

/* The human gate, as data.
 *
 * A model read a photograph and wrote what it thought it saw into
 * menu_imports.raw_extraction. This file turns that into a list a person
 * works through item by item, and turns their finished list back into the
 * arguments of public.publish_menu_import
 * (supabase/migrations/20260813170000_publish_menu_import.sql).
 *
 * Two rules shape everything here:
 *
 *   1. raw_extraction is read, never written. The record of what the
 *      model said is what makes a later argument about a price
 *      settleable, so corrections live in the draft below and end up in
 *      menu_items -- never back over the model's own answer.
 *
 *   2. Nothing leaves here unconfirmed. `publishArrays` refuses a list
 *      with a single unconfirmed item, and it refuses it on the server as
 *      well as in the browser, because the button being disabled is a
 *      courtesy and not a gate. */

/* ── reading what is stored ─────────────────────────────────────────── */

type RawRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is RawRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A stored extraction, if it is one this screen knows how to show.
 *
 *  Deliberately structural rather than exhaustive: normalizeExtraction
 *  already produced this shape and jsonb round-trips it faithfully, so
 *  the job here is to refuse a row written by some other version -- an
 *  older schema, a hand-edited row -- rather than to re-validate every
 *  field. Refusing means the screen says "this cannot be shown" instead
 *  of throwing halfway down a list of prices. */
export function readExtraction(raw: unknown): MenuExtraction | null {
  if (!isRecord(raw)) return null;
  if (raw.schema_version !== EXTRACTION_SCHEMA_VERSION) return null;
  if (!isRecord(raw.document)) return null;
  if (!Array.isArray(raw.categories)) return null;
  if (!Array.isArray(raw.files)) return null;
  return raw as unknown as MenuExtraction;
}

/* ── the draft a person works on ────────────────────────────────────── */

/** The field limits, matched by the CHECKs inside publish_menu_import.
 *  The screen refuses first so somebody sees a sentence; the function is
 *  the authority. */
export const MAX_ITEM_NAME = 120;
export const MAX_ITEM_DESCRIPTION = 280;
export const MAX_CATEGORY_NAME = 80;
export const MAX_PUBLISH_ITEMS = 500;
export const MAX_PUBLISH_CATEGORIES = 60;

/** Who put this row here. `model` means a model proposed it and a person
 *  is checking it; `human` means a person typed it because the model
 *  missed it. The distinction is the whole feature, so it is on the row
 *  rather than inferred. */
export type ReviewOrigin = "model" | "human";

/** Exactly what the model said about one item, kept beside the editable
 *  copy so the screen can show "was $18.00" next to a corrected price and
 *  so a later argument about what was proposed has an answer. */
export type ModelSaid = {
  name: string;
  priceKnown: boolean;
  /** The price as the card prints it -- "12.00", "market price", or null
   *  when nothing legible was there at all. */
  priceAsPrinted: string | null;
  /** Cents, only where the model read a plain amount. */
  priceCents: number | null;
  priceReason: string | null;
  description: string;
  ingredients: string[];
  unsure: {
    name: boolean;
    price: boolean;
    description: boolean;
    ingredients: boolean;
  };
};

export type ReviewItem = {
  /** Stable for React and for tests. */
  key: string;
  /** Where this row sits in the list, as the card printed it.
   *
   *  A number rather than something read back off the key, because keys
   *  are strings and "c0i10" sorts before "c0i2": ordering by key would
   *  reorder any section of eleven items or more the first time somebody
   *  put a row back. */
  position: number;
  categoryKey: string;
  origin: ReviewOrigin;
  /** Which uploaded file this was read from, so "go and look at it" names
   *  a photograph. -1 for an item a person added. */
  fileIndex: number;
  name: string;
  /** Dollars, as typed. Empty when the model could not read a price --
   *  never a guess, and never a zero standing in for one. */
  price: string;
  description: string;
  /** What the card printed, comma-joined and editable. Publishing writes
   *  this nowhere on its own: see INGREDIENTS_NOTE. */
  ingredients: string;
  confirmed: boolean;
  said: ModelSaid | null;
};

export type ReviewCategory = {
  key: string;
  name: string;
  origin: ReviewOrigin;
  unsureName: boolean;
  /** The heading the model read, for the same reason ModelSaid exists. */
  said: string | null;
};

export type ReviewDraft = {
  categories: ReviewCategory[];
  items: ReviewItem[];
};

/** Why the ingredients a model read off a card are shown but not
 *  published. Kept here as one string for the same reason
 *  INGREDIENTS_CAVEAT is kept in extraction.ts: it must not be said in
 *  one place and forgotten in another. */
export const INGREDIENTS_NOTE =
  "Ingredients are shown so you can check them against the card. They are not " +
  "written to the menu on their own and never become an allergen note — a printed " +
  "menu cannot know the fryer is shared or that a dish is finished in butter, and " +
  "the assistant still hands every allergy question to a person. If you want the " +
  "assistant to say them, put them in the description yourself.";

/** Dollars as printed, for the editable price box. Only ever filled from
 *  a price the model actually read: an unknown price arrives empty, so
 *  the person has to type it before the item can be confirmed. */
function priceBoxFor(item: ExtractedItem): string {
  if (!item.price.known) return "";
  return (item.price.cents / 100).toFixed(2);
}

const unsure = (confidence: Confidence | undefined) => confidence === "unsure";

/** The stored extraction, opened up as a list to work through. Category
 *  and item keys are positional so a re-render, a test and a screenshot
 *  all agree on which row is which. */
export function draftFromExtraction(extraction: MenuExtraction): ReviewDraft {
  const categories: ReviewCategory[] = [];
  const items: ReviewItem[] = [];

  extraction.categories.forEach((category, c) => {
    const categoryKey = `c${c}`;
    categories.push({
      key: categoryKey,
      name: category.name,
      origin: "model",
      unsureName: unsure(category.name_confidence),
      said: category.name,
    });

    category.items.forEach((item, i) => {
      items.push({
        key: `c${c}i${i}`,
        position: items.length,
        categoryKey,
        origin: "model",
        fileIndex: item.file_index,
        name: item.name,
        price: priceBoxFor(item),
        description: item.description?.text ?? "",
        ingredients: (item.ingredients?.values ?? []).join(", "),
        confirmed: false,
        said: {
          name: item.name,
          priceKnown: item.price.known,
          priceAsPrinted: item.price.as_printed,
          priceCents: item.price.known ? item.price.cents : null,
          priceReason: item.price.known ? null : item.price.reason,
          description: item.description?.text ?? "",
          ingredients: item.ingredients?.values ?? [],
          unsure: {
            name: unsure(item.name_confidence),
            price: item.price.known ? unsure(item.price.confidence) : true,
            description: unsure(item.description?.confidence),
            ingredients: unsure(item.ingredients?.confidence),
          },
        },
      });
    });
  });

  return { categories, items };
}

/** A row a person is adding because the model missed a dish.
 *
 *  It arrives confirmed. Every field on it was typed by the person adding
 *  it -- there is no model guess to check -- and the running count is
 *  meant to answer "what has nobody looked at yet?", which this is not.
 *  It is still subject to every other rule: publishing refuses it if the
 *  price does not parse, exactly like any other row. */
export function blankItem(
  categoryKey: string,
  key: string,
  position: number,
): ReviewItem {
  return {
    key,
    position,
    categoryKey,
    origin: "human",
    fileIndex: -1,
    name: "",
    price: "",
    description: "",
    ingredients: "",
    confirmed: true,
    said: null,
  };
}

/** The position the next added row takes: past everything the review is
 *  holding, the removed pile included, so a row somebody adds cannot land
 *  on top of one they put back afterwards. */
export function nextPosition(...lists: ReviewItem[][]): number {
  let highest = -1;
  for (const list of lists) {
    for (const item of list) {
      if (item.position > highest) highest = item.position;
    }
  }
  return highest + 1;
}

/** An item put back where it was.
 *
 *  An insertion, not a re-sort: the list is already in position order, so
 *  every other row stays exactly where the person checking it left it.
 *  Re-sorting the list by key did this wrong -- "c0i10" sorts before
 *  "c0i2", so one "put it back" on a section of eleven items moved item
 *  10 ahead of item 2, both in the list being read against the photograph
 *  and in the sort_order the assistant would then read the menu in. */
export function restoreItem(items: ReviewItem[], item: ReviewItem): ReviewItem[] {
  const at = items.findIndex((i) => i.position > item.position);
  const restored = [...items];
  restored.splice(at === -1 ? restored.length : at, 0, item);
  return restored;
}

/* ── what the screen has to say about one item ──────────────────────── */

/** The price this item would store, or null if what is typed is not a
 *  plain amount. The one conversion from dollars to cents; the server
 *  action runs the same function on the same string before the write. */
export function itemCents(item: ReviewItem): number | null {
  return parseDollarsToCents(item.price.trim());
}

/** Why this item cannot be confirmed yet, in a sentence, or null when it
 *  can. This is the rule that stops an unread price becoming a $0 dish. */
export function itemBlocker(item: ReviewItem): string | null {
  if (item.name.trim() === "") return "Give this item a name.";
  if (item.name.trim().length > MAX_ITEM_NAME) return "That name is too long.";
  if (item.description.trim().length > MAX_ITEM_DESCRIPTION) {
    return "That description is too long.";
  }
  if (item.price.trim() === "") {
    return "Type this item's price, in dollars, before confirming it.";
  }
  const cents = itemCents(item);
  if (cents === null) {
    return `"${item.price.trim()}" is not a plain amount. Type it as dollars, like 12.50.`;
  }
  if (cents > 1000000) return "That price looks wrong — it is over $10,000.";
  return null;
}

/** What the model was unsure about on this item, as sentences to show
 *  next to it. An unread price leads, because it is the one thing on this
 *  screen nobody may skip past. */
export function itemFlags(item: ReviewItem): string[] {
  const said = item.said;
  if (!said) return [];

  const flags: string[] = [];

  if (!said.priceKnown) {
    flags.push(
      said.priceAsPrinted
        ? `No price read — the card says "${said.priceAsPrinted}". Type what a caller should be quoted.`
        : "No price could be read. Type it from the card.",
    );
  } else if (said.unsure.price) {
    flags.push("The price was hard to read. Check it against the photo.");
  }

  if (said.unsure.name) flags.push("The name was hard to read.");
  if (said.unsure.description) flags.push("The description was hard to read.");
  if (said.unsure.ingredients) flags.push("The ingredients were hard to read.");

  return flags;
}

/** Has a person changed what the model proposed? Drives the "edited"
 *  mark, which is how somebody scanning the list sees their own work. */
export function itemEdited(item: ReviewItem): boolean {
  const said = item.said;
  if (!said) return false;
  if (item.name.trim() !== said.name.trim()) return true;
  if (item.description.trim() !== said.description.trim()) return true;
  if (item.ingredients.trim() !== said.ingredients.join(", ").trim()) return true;
  return itemCents(item) !== said.priceCents;
}

/* ── the running count ──────────────────────────────────────────────── */

export type ReviewCounts = {
  total: number;
  confirmed: number;
  /** The number the screen shouts. Publishing is blocked while it is
   *  anything but zero. */
  unconfirmed: number;
  /** Unconfirmed items the model itself flagged: what to look at first. */
  flagged: number;
  /** Items whose price the model could not read at all. */
  unpriced: number;
  edited: number;
};

export function reviewCounts(draft: ReviewDraft): ReviewCounts {
  let confirmed = 0;
  let flagged = 0;
  let unpriced = 0;
  let edited = 0;

  for (const item of draft.items) {
    if (item.confirmed) confirmed += 1;
    else if (itemFlags(item).length > 0) flagged += 1;
    if (item.said && !item.said.priceKnown) unpriced += 1;
    if (itemEdited(item)) edited += 1;
  }

  return {
    total: draft.items.length,
    confirmed,
    unconfirmed: draft.items.length - confirmed,
    flagged,
    unpriced,
    edited,
  };
}

/** Why this menu cannot go live yet, in a sentence, or null when it can.
 *
 *  One function so the disabled button, the sentence beside it and the
 *  server's own refusal all say the same thing. The order is the order
 *  somebody would fix them in. */
export function publishBlocker(draft: ReviewDraft): string | null {
  if (draft.items.length === 0) {
    return "There is nothing left to publish. Every item has been removed.";
  }

  const counts = reviewCounts(draft);
  if (counts.unconfirmed > 0) {
    return counts.unconfirmed === 1
      ? "1 item still has to be confirmed."
      : `${counts.unconfirmed} items still have to be confirmed.`;
  }

  for (const item of draft.items) {
    const blocker = itemBlocker(item);
    if (blocker) return `${item.name.trim() || "An item"}: ${blocker}`;
  }

  if (usedCategories(draft).length > MAX_PUBLISH_CATEGORIES) {
    return `That is more than ${MAX_PUBLISH_CATEGORIES} sections for one menu.`;
  }
  if (draft.items.length > MAX_PUBLISH_ITEMS) {
    return `That is more than ${MAX_PUBLISH_ITEMS} items for one menu. Publish it in parts.`;
  }

  return null;
}

/** The categories that will actually be created: the ones something is
 *  still filed under. A section whose every item was deleted is not a
 *  section of the menu. */
export function usedCategories(draft: ReviewDraft): ReviewCategory[] {
  const filed = new Set(draft.items.map((item) => item.categoryKey));
  return draft.categories.filter((category) => filed.has(category.key));
}

/* ── handing the finished list to the database ──────────────────────── */

export type PublishMode = "add" | "replace";

export const PUBLISH_MODES: PublishMode[] = ["add", "replace"];

export function isPublishMode(value: unknown): value is PublishMode {
  return value === "add" || value === "replace";
}

/** One line of a finished review, as it crosses from the browser to the
 *  server action. Prices are still the string the person typed: they
 *  become cents once, on the server, in `publishArrays`. */
export type PublishItem = {
  category: string;
  name: string;
  /** Dollars, as typed. */
  price: string;
  description: string;
  confirmed: boolean;
};

/** The arguments of public.publish_menu_import, in its own shape: four
 *  parallel arrays of items plus the sections they are filed under. */
export type PublishArrays = {
  categoryNames: string[];
  /** Zero-based index into categoryNames, per item. */
  itemCategory: number[];
  itemNames: string[];
  itemPricesCents: number[];
  itemDescriptions: string[];
};

export type PublishArraysResult =
  | { ok: true; arrays: PublishArrays }
  | { ok: false; error: string };

/** A finished review, checked and converted.
 *
 *  This is the gate, and it runs on the server. The Publish button being
 *  disabled while something is unconfirmed is a courtesy to whoever is
 *  reading the screen; this function is what makes it true, because a
 *  server action is a live HTTP endpoint and the list it is handed comes
 *  from a browser. An unconfirmed line, a blank name, a price that is not
 *  a plain amount -- each one refuses the whole publish, rather than
 *  being dropped quietly, because a menu missing the dish somebody
 *  thought they had published is its own kind of wrong price. */
export function publishArrays(items: PublishItem[]): PublishArraysResult {
  if (items.length === 0) {
    return { ok: false, error: "There is nothing to publish." };
  }
  if (items.length > MAX_PUBLISH_ITEMS) {
    return {
      ok: false,
      error: `That is more than ${MAX_PUBLISH_ITEMS} items for one menu. Publish it in parts.`,
    };
  }

  const categoryNames: string[] = [];
  const indexByName = new Map<string, number>();
  const itemCategory: number[] = [];
  const itemNames: string[] = [];
  const itemPricesCents: number[] = [];
  const itemDescriptions: string[] = [];

  for (const item of items) {
    const name = item.name.trim();
    const category = item.category.trim();

    if (!item.confirmed) {
      return {
        ok: false,
        error: `"${name || "An item"}" has not been confirmed yet. Every item has to be checked before the menu goes live.`,
      };
    }
    if (name === "") return { ok: false, error: "An item was left without a name." };
    if (name.length > MAX_ITEM_NAME) {
      return { ok: false, error: `"${name.slice(0, 40)}…" has too long a name.` };
    }
    if (category === "") {
      return { ok: false, error: `"${name}" is not under a section.` };
    }
    if (category.length > MAX_CATEGORY_NAME) {
      return { ok: false, error: "A section name is too long." };
    }

    const description = item.description.trim();
    if (description.length > MAX_ITEM_DESCRIPTION) {
      return { ok: false, error: `The description on "${name}" is too long.` };
    }

    // Dollars become cents here and nowhere else on this path.
    const cents = parseDollarsToCents(item.price.trim());
    if (cents === null) {
      return {
        ok: false,
        error: `"${name}" does not have a price a caller could be quoted. Type it as dollars, like 12.50.`,
      };
    }

    // Sections are matched case-insensitively for the same reason the SQL
    // does it: "Pizze" and "pizze" are one section of one menu.
    const folded = category.toLocaleLowerCase();
    let index = indexByName.get(folded);
    if (index === undefined) {
      index = categoryNames.length;
      indexByName.set(folded, index);
      categoryNames.push(category);
    }

    itemCategory.push(index);
    itemNames.push(name);
    itemPricesCents.push(cents);
    itemDescriptions.push(description);
  }

  if (categoryNames.length > MAX_PUBLISH_CATEGORIES) {
    return {
      ok: false,
      error: `That is more than ${MAX_PUBLISH_CATEGORIES} sections for one menu.`,
    };
  }

  return {
    ok: true,
    arrays: { categoryNames, itemCategory, itemNames, itemPricesCents, itemDescriptions },
  };
}

/** The draft, in the shape the server action takes. Sections come out in
 *  the order the card prints them, because that is the order the
 *  assistant will read them in. */
export function toPublishItems(draft: ReviewDraft): PublishItem[] {
  const nameByKey = new Map(draft.categories.map((c) => [c.key, c.name]));
  const order = new Map(draft.categories.map((c, i) => [c.key, i]));

  return [...draft.items]
    .sort(
      (a, b) =>
        (order.get(a.categoryKey) ?? 0) - (order.get(b.categoryKey) ?? 0) ||
        a.position - b.position,
    )
    .map((item) => ({
      category: nameByKey.get(item.categoryKey) ?? "",
      name: item.name,
      price: item.price,
      description: item.description,
      confirmed: item.confirmed,
    }));
}
