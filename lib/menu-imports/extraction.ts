import { parseDollarsToCents } from "@/lib/money";
import type { MenuImportSourceType } from "@/lib/supabase/types";

/* What a model read off a photograph of a menu, and the one function that
 * turns its answer into that shape.
 *
 * Nothing here calls a model and nothing here writes a menu. This is the
 * boundary between "some JSON arrived" and "a human can be shown this":
 * every field is re-checked, every price is converted here and only here,
 * and anything that does not survive the check comes back marked unknown
 * rather than guessed. A wrong price read aloud to a caller comes out of
 * the restaurant's pocket, so the failure this file is built to avoid is
 * a confident-looking number nobody read. */

/** How sure the model was about one field. Two values, not a score: a
 *  percentage invites the review screen to pick a threshold, and the only
 *  question that screen has to answer is "does a human need to look at
 *  this one?". */
export type Confidence = "confident" | "unsure";

/** THE SENTENCE. Extracted ingredients are what a laminated card happens
 *  to print. They are not an allergen list and never become one, and this
 *  string is the single place that says so -- the column comment, the
 *  type below, and every screen that shows an ingredient all point here,
 *  so the caveat cannot be shown in one place and dropped in another. */
export const INGREDIENTS_CAVEAT =
  "Read off the menu and not verified by anyone at the restaurant. This is NOT an " +
  "allergen list: a printed menu cannot know that the fryer is shared, that a dish is " +
  "finished in butter, or that a supplier changed last week. Any allergy, intolerance " +
  "or celiac question still goes to a human, unchanged.";

/** Ingredients as printed, carrying their own disclaimer. `verified` is
 *  the literal `false` rather than a boolean: there is no code path that
 *  can set it true, and the type says so. */
export type UnverifiedIngredients = {
  values: string[];
  confidence: Confidence;
  verified: false;
  caveat: typeof INGREDIENTS_CAVEAT;
};

/** A price is either a number that was read, already in integer cents, or
 *  an explicit absence. There is deliberately no third state and no
 *  nullable `cents`: code that wants a number has to acknowledge the case
 *  where the model could not read one. */
export type ExtractedPrice =
  | { known: true; cents: number; as_printed: string; confidence: Confidence }
  | { known: false; as_printed: string | null; reason: string };

export type ExtractedItem = {
  name: string;
  name_confidence: Confidence;
  price: ExtractedPrice;
  /** What the menu prints under the name, if anything. Never invented. */
  description: { text: string; confidence: Confidence } | null;
  /** Only when the menu itself lists them. Null is "the menu does not
   *  say", which is not the same as "this dish has no ingredients". */
  ingredients: UnverifiedIngredients | null;
  /** Which file of the batch this item was read from, as an index into
   *  `files` -- a three-photo menu needs to say which photo to re-check. */
  file_index: number;
};

export type ExtractedCategory = {
  name: string;
  name_confidence: Confidence;
  items: ExtractedItem[];
};

/** What the read was of. `not_a_menu` and `unreadable` are outcomes, not
 *  errors: a human still has to see them, because a model calling a
 *  stylised menu "not a menu" is exactly the sort of thing a human
 *  overrules. */
export type DocumentKind = "menu" | "not_a_menu" | "unreadable";

export type ExtractionFile = {
  index: number;
  filename: string | null;
  source_type: MenuImportSourceType;
};

/** One row's `raw_extraction`. Written once, never edited: it is the
 *  record of what the model said, which is what makes a later argument
 *  about a price settleable. Edits belong to the review step and land in
 *  menu_items, not here. */
export type MenuExtraction = {
  schema_version: 1;
  read_at: string;
  model: string;
  /** Which file of the batch this row is. */
  file: ExtractionFile;
  /** Every file read in the same call, in the order the model saw them.
   *  A menu is often three photos and a category can run across two of
   *  them, so they are read together and each row carries the whole
   *  result. */
  files: ExtractionFile[];
  document: {
    kind: DocumentKind;
    /** One sentence a human can act on. */
    note: string;
    /** The language the menu is written in, as the model read it. Names
     *  and descriptions are kept in it, never translated. */
    language: string | null;
  };
  categories: ExtractedCategory[];
  /** What the review screen leans on to draw the eye. Counted here so
   *  every screen counts it the same way. */
  totals: { items: number; unsure_fields: number; unknown_prices: number };
};

export const EXTRACTION_SCHEMA_VERSION = 1 as const;

/* ── what we ask the model for ──────────────────────────────────────── */

/** The model answers in dollars-as-printed and confidence words, never in
 *  cents and never in booleans. Two reasons: the conversion to integer
 *  cents happens once, here, in code that is tested (a model doing
 *  arithmetic on a price is the one thing this feature cannot afford);
 *  and "unknown" has to be a value the model can pick, so a price it
 *  could not read comes back as an absence rather than a plausible
 *  number.
 *
 *  Every property is required and `additionalProperties` is false
 *  throughout, which is what strict structured output needs: absence is
 *  spelled "" or [], so there is no shape where a field is simply
 *  missing and has to be guessed at on this side. */
export const MENU_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["document_kind", "note", "language", "categories"],
  properties: {
    document_kind: {
      type: "string",
      enum: ["menu", "not_a_menu", "unreadable"],
      description:
        "'menu' if these files show a food or drink menu. 'not_a_menu' if they show " +
        "something else. 'unreadable' if it is a menu but you cannot read it.",
    },
    note: {
      type: "string",
      description:
        "One sentence for the restaurant owner about this read: what you could not " +
        "make out, or why this is not a menu. Plain language, no jargon.",
    },
    language: {
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "The language the menu is printed in, in English (e.g. 'Italian').",
    },
    categories: {
      type: "array",
      description: "The menu's own sections, in the order they are printed.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "name_confidence", "items"],
        properties: {
          name: {
            type: "string",
            description:
              "The heading exactly as printed. If a run of items has no heading, use 'Other'.",
          },
          name_confidence: { type: "string", enum: ["confident", "unsure"] },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "name",
                "name_confidence",
                "price_as_printed",
                "price_confidence",
                "description",
                "description_confidence",
                "ingredients",
                "ingredients_confidence",
                "file_index",
              ],
              properties: {
                name: { type: "string", description: "The dish name exactly as printed." },
                name_confidence: { type: "string", enum: ["confident", "unsure"] },
                price_as_printed: {
                  type: "string",
                  description:
                    "The price exactly as the menu prints it: '12.00', '9'. No rounding and " +
                    "no arithmetic of any kind. Where what is printed is not a plain amount " +
                    "-- 'market price', a range, a per-100g weight -- copy it here as printed " +
                    "anyway and set price_confidence to 'unknown'. Empty string only when " +
                    "nothing is printed or nothing is legible.",
                },
                price_confidence: {
                  type: "string",
                  enum: ["confident", "unsure", "unknown"],
                  description:
                    "'unknown' whenever you cannot read a plain amount, whatever is printed. " +
                    "Never estimate a price.",
                },
                description: {
                  type: "string",
                  description:
                    "The blurb the menu prints under the name. Empty string if it prints none.",
                },
                description_confidence: { type: "string", enum: ["confident", "unsure"] },
                ingredients: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Only ingredients the menu itself names for this dish. Empty array if " +
                    "it names none. Never add the ingredients a dish usually has.",
                },
                ingredients_confidence: { type: "string", enum: ["confident", "unsure"] },
                file_index: {
                  type: "integer",
                  description: "The number of the file this item was read from.",
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

/* ── turning the model's answer into the stored shape ───────────────── */

const CONFIDENCES = new Set(["confident", "unsure"]);
const KINDS = new Set<DocumentKind>(["menu", "not_a_menu", "unreadable"]);

/** Any field the model did not label the way the schema says it should be
 *  labelled is treated as unsure, never as confident. A malformed label
 *  is itself a reason for a human to look. */
function confidence(value: unknown): Confidence {
  return typeof value === "string" && CONFIDENCES.has(value)
    ? (value as Confidence)
    : "unsure";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A currency symbol and the spaces around it are not part of the number,
 *  and stripping them is reading rather than guessing. Everything else --
 *  a comma decimal, a range, a "market price" -- is left alone so that
 *  `parseDollarsToCents` refuses it and the price comes back unknown. */
const CURRENCY = /^[\s$€£¥]+|[\s$€£¥]+$/g;

/** Dollars as printed to integer cents, or an explicit absence. This is
 *  the only place in the read path where a price becomes a number, and it
 *  refuses far more than it accepts on purpose: `parseDollarsToCents`
 *  takes a plain non-negative amount with at most two decimals and
 *  nothing else, so "12,50", "10-14" and "market price" all land in the
 *  human's lap with the printed text attached, which is exactly where a
 *  price nobody can read belongs. */
export function priceFrom(asPrinted: unknown, label: unknown): ExtractedPrice {
  const printed = typeof asPrinted === "string" ? asPrinted.trim() : "";
  const stated = typeof label === "string" ? label : "";

  if (stated === "unknown" || printed === "") {
    return {
      known: false,
      as_printed: printed === "" ? null : printed,
      reason: "The price could not be read.",
    };
  }

  const cents = parseDollarsToCents(printed.replace(CURRENCY, ""));
  if (cents === null) {
    return {
      known: false,
      as_printed: printed,
      reason: `"${printed}" is not a plain amount, so it was not turned into a price.`,
    };
  }

  return { known: true, cents, as_printed: printed, confidence: confidence(stated) };
}

function ingredientsFrom(values: unknown, label: unknown): UnverifiedIngredients | null {
  if (!Array.isArray(values)) return null;
  const cleaned = values.map(text).filter((v) => v !== "");
  if (cleaned.length === 0) return null;
  return {
    values: cleaned,
    confidence: confidence(label),
    verified: false,
    caveat: INGREDIENTS_CAVEAT,
  };
}

type RawRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is RawRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function itemFrom(raw: unknown, fileCount: number): ExtractedItem | null {
  if (!isRecord(raw)) return null;

  const name = text(raw.name);
  // An item with no name is not something a human can review or confirm.
  if (name === "") return null;

  const index = Number(raw.file_index);
  // A file index that is not one of the files we sent tells us nothing;
  // pointing at the first file is better than pointing at nothing, and
  // the item is still shown either way.
  const file_index =
    Number.isInteger(index) && index >= 0 && index < fileCount ? index : 0;

  const descriptionText = text(raw.description);

  return {
    name,
    name_confidence: confidence(raw.name_confidence),
    price: priceFrom(raw.price_as_printed, raw.price_confidence),
    description:
      descriptionText === ""
        ? null
        : { text: descriptionText, confidence: confidence(raw.description_confidence) },
    ingredients: ingredientsFrom(raw.ingredients, raw.ingredients_confidence),
    file_index,
  };
}

function categoryFrom(raw: unknown, fileCount: number): ExtractedCategory | null {
  if (!isRecord(raw)) return null;
  const items = Array.isArray(raw.items)
    ? raw.items.map((item) => itemFrom(item, fileCount)).filter((i): i is ExtractedItem => i !== null)
    : [];
  if (items.length === 0) return null;
  const name = text(raw.name);
  return {
    name: name === "" ? "Other" : name,
    name_confidence: confidence(raw.name_confidence),
    items,
  };
}

function totalsFor(categories: ExtractedCategory[]): MenuExtraction["totals"] {
  let items = 0;
  let unsure = 0;
  let unknownPrices = 0;

  for (const category of categories) {
    if (category.name_confidence === "unsure") unsure += 1;
    for (const item of category.items) {
      items += 1;
      if (item.name_confidence === "unsure") unsure += 1;
      if (item.description?.confidence === "unsure") unsure += 1;
      if (item.ingredients?.confidence === "unsure") unsure += 1;
      if (item.price.known) {
        if (item.price.confidence === "unsure") unsure += 1;
      } else {
        unknownPrices += 1;
        // An unread price is the thing the review screen must not let
        // anyone skip past, so it counts as something to check too.
        unsure += 1;
      }
    }
  }

  return { items, unsure_fields: unsure, unknown_prices: unknownPrices };
}

/** The model's JSON, already parsed, into one row's stored extraction.
 *
 *  Returns null only when the answer is not an object at all -- that is
 *  the malformed case, and the caller's job is to say so and leave the
 *  row pending rather than write a shape the review screen cannot read.
 *  Everything short of that is salvaged and marked: a category with no
 *  items is dropped, an unlabelled field becomes unsure, an unparseable
 *  price becomes an explicit unknown. */
export function normalizeExtraction(
  raw: unknown,
  context: { file: ExtractionFile; files: ExtractionFile[]; model: string; readAt: string },
): MenuExtraction | null {
  if (!isRecord(raw)) return null;

  const kind =
    typeof raw.document_kind === "string" && KINDS.has(raw.document_kind as DocumentKind)
      ? (raw.document_kind as DocumentKind)
      : "unreadable";

  const categories = Array.isArray(raw.categories)
    ? raw.categories
        .map((category) => categoryFrom(category, context.files.length))
        .filter((c): c is ExtractedCategory => c !== null)
    : [];

  // The model said "menu" but nothing came back that a human could
  // confirm. Saying "unreadable" here keeps the stored verdict and the
  // stored items telling the same story.
  const settled: DocumentKind = kind === "menu" && categories.length === 0 ? "unreadable" : kind;

  const note = text(raw.note);
  const language = text(raw.language);

  return {
    schema_version: EXTRACTION_SCHEMA_VERSION,
    read_at: context.readAt,
    model: context.model,
    file: context.file,
    files: context.files,
    document: {
      kind: settled,
      note: note === "" ? DEFAULT_NOTE[settled] : note,
      language: language === "" ? null : language,
    },
    categories,
    totals: totalsFor(categories),
  };
}

const DEFAULT_NOTE: Record<DocumentKind, string> = {
  menu: "Read from the uploaded file. Check every price before confirming.",
  not_a_menu: "This file does not look like a menu.",
  unreadable: "Nothing could be read from this file. A sharper photo would help.",
};

/** One line about a finished read, for a list that has no room for the
 *  read itself. Leads with what needs checking rather than with what was
 *  found: "18 items" invites a click-through, "4 to check" is the reason
 *  to click. Returns null for a row nothing has been read from yet. */
export function extractionSummary(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const document = isRecord(raw.document) ? raw.document : null;
  const kind = typeof document?.kind === "string" ? document.kind : null;
  if (!kind) return null;

  if (kind === "not_a_menu") return "Read: this does not look like a menu";
  if (kind === "unreadable") return "Read: nothing could be made out";

  const totals = isRecord(raw.totals) ? raw.totals : null;
  const items = typeof totals?.items === "number" ? totals.items : 0;
  const unsure = typeof totals?.unsure_fields === "number" ? totals.unsure_fields : 0;
  const found = `${items} item${items === 1 ? "" : "s"} found`;
  return unsure === 0 ? `${found}, none flagged` : `${found}, ${unsure} to check`;
}

/** Is there anything on this row a human could confirm into a menu? Used
 *  to tell "we read it and found dishes" from "we read it and found
 *  nothing", which are the same status but very different situations. */
export function extractionHasItems(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const totals = raw.totals;
  if (isRecord(totals) && typeof totals.items === "number") return totals.items > 0;
  return Array.isArray(raw.categories) && raw.categories.length > 0;
}
