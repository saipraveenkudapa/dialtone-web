import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EXTRACTION_SCHEMA_VERSION,
  INGREDIENTS_CAVEAT,
  MENU_EXTRACTION_JSON_SCHEMA,
  extractionHasItems,
  extractionSummary,
  normalizeExtraction,
  priceFrom,
  type ExtractionFile,
} from "./extraction";

/* The boundary between "some JSON arrived from a model" and "a human is
 * shown this". Everything here is about the one failure that costs the
 * restaurant money: a number that looks read but was guessed. */

const FILES: ExtractionFile[] = [
  { index: 0, filename: "menu-front.jpg", source_type: "image" },
  { index: 1, filename: "menu-back.jpg", source_type: "image" },
];

const CONTEXT = {
  file: FILES[0],
  files: FILES,
  model: "claude-opus-5",
  readAt: "2026-08-13T12:00:00.000Z",
};

const item = (over: Record<string, unknown> = {}) => ({
  name: "Bruschetta",
  name_confidence: "confident",
  price_as_printed: "9.50",
  price_confidence: "confident",
  description: "",
  description_confidence: "confident",
  ingredients: [],
  ingredients_confidence: "confident",
  file_index: 0,
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  document_kind: "menu",
  note: "Read cleanly.",
  language: "Italian",
  categories: [
    { name: "Antipasti", name_confidence: "confident", items: [item()] },
  ],
  ...over,
});

describe("a price the model read", () => {
  it("becomes integer cents, exactly once, from the digits that were printed", () => {
    const price = priceFrom("12.05", "confident");
    expect(price).toEqual({
      known: true,
      cents: 1205,
      as_printed: "12.05",
      confidence: "confident",
    });
  });

  it("takes a whole-dollar price and a currency symbol the model left on", () => {
    expect(priceFrom("9", "confident")).toMatchObject({ known: true, cents: 900 });
    expect(priceFrom("$9.50", "confident")).toMatchObject({ known: true, cents: 950 });
    expect(priceFrom("12.00 €", "confident")).toMatchObject({ known: true, cents: 1200 });
  });

  it("keeps the printed text alongside the number, so a human can check it", () => {
    expect(priceFrom("$18.00", "unsure").as_printed).toBe("$18.00");
  });
});

describe("a price the model did not read", () => {
  it("comes back explicitly unknown when the model says unknown", () => {
    const price = priceFrom("", "unknown");
    expect(price.known).toBe(false);
    if (!price.known) {
      expect(price.as_printed).toBeNull();
      expect(price.reason).toMatch(/could not be read/i);
    }
  });

  it("is unknown even when the model labelled it confident but printed nothing", () => {
    expect(priceFrom("", "confident").known).toBe(false);
  });

  it("keeps what the card actually said, so the person checking sees it", () => {
    // "mkt price" is a real thing menus print. The number is unknown; the
    // words are not, and they are what tells the reviewer to go and ask.
    const price = priceFrom("mkt price", "unknown");
    expect(price.known).toBe(false);
    if (!price.known) expect(price.as_printed).toBe("mkt price");
  });

  it("refuses an amount that is not plain, rather than picking a reading", () => {
    // "12,50" is 1250 in one country and 12.50 in another, "10-14" is a
    // range, "market price" is not a number at all. Each of these guessed
    // wrong is read down the phone to a caller.
    for (const printed of ["12,50", "10-14", "market price", "12.505", "-4.00"]) {
      const price = priceFrom(printed, "confident");
      expect(price.known, printed).toBe(false);
      if (!price.known) expect(price.as_printed).toBe(printed);
    }
  });

  it("never lets an unknown price reach a caller as a zero", () => {
    const price = priceFrom("", "unknown");
    expect(JSON.stringify(price)).not.toMatch(/"cents"/);
  });
});

describe("carrying confidence through", () => {
  it("keeps what the model said, per field", () => {
    const extraction = normalizeExtraction(
      answer({
        categories: [
          {
            name: "Pizze",
            name_confidence: "unsure",
            items: [
              item({
                name_confidence: "unsure",
                description: "San Marzano tomato, fior di latte",
                description_confidence: "unsure",
                ingredients: ["tomato", "mozzarella"],
                ingredients_confidence: "unsure",
                price_confidence: "unsure",
              }),
            ],
          },
        ],
      }),
      CONTEXT,
    )!;

    const found = extraction.categories[0];
    expect(found.name_confidence).toBe("unsure");
    expect(found.items[0].name_confidence).toBe("unsure");
    expect(found.items[0].description?.confidence).toBe("unsure");
    expect(found.items[0].ingredients?.confidence).toBe("unsure");
    expect(found.items[0].price).toMatchObject({ known: true, confidence: "unsure" });
  });

  it("treats a label it did not recognise as unsure, never as confident", () => {
    const extraction = normalizeExtraction(
      answer({
        categories: [
          {
            name: "Dolci",
            name_confidence: "very sure indeed",
            items: [item({ name_confidence: null })],
          },
        ],
      }),
      CONTEXT,
    )!;

    expect(extraction.categories[0].name_confidence).toBe("unsure");
    expect(extraction.categories[0].items[0].name_confidence).toBe("unsure");
  });

  it("counts what a human has to look at, and counts an unread price among it", () => {
    const extraction = normalizeExtraction(
      answer({
        categories: [
          {
            name: "Antipasti",
            name_confidence: "confident",
            items: [
              item(),
              item({ name: "Arancini", price_as_printed: "", price_confidence: "unknown" }),
              item({ name: "Olive", name_confidence: "unsure" }),
            ],
          },
        ],
      }),
      CONTEXT,
    )!;

    expect(extraction.totals).toEqual({ items: 3, unsure_fields: 2, unknown_prices: 1 });
  });
});

describe("ingredients, which are not an allergen list", () => {
  it("stores them unverified, with the caveat attached to the data itself", () => {
    const extraction = normalizeExtraction(
      answer({
        categories: [
          {
            name: "Antipasti",
            name_confidence: "confident",
            items: [item({ ingredients: ["tomato", " basil ", ""] })],
          },
        ],
      }),
      CONTEXT,
    )!;

    const ingredients = extraction.categories[0].items[0].ingredients!;
    expect(ingredients.values).toEqual(["tomato", "basil"]);
    expect(ingredients.verified).toBe(false);
    expect(ingredients.caveat).toBe(INGREDIENTS_CAVEAT);
  });

  it("says, in the caveat, that an allergy question still goes to a human", () => {
    // The owner's rule, in the one string every screen and the column
    // comment both point at. If this sentence ever softens, an agent
    // could start answering "is there butter in it?" off a laminated card.
    expect(INGREDIENTS_CAVEAT).toMatch(/NOT an allergen list/i);
    expect(INGREDIENTS_CAVEAT).toMatch(/allergy/i);
    expect(INGREDIENTS_CAVEAT).toMatch(/intolerance/i);
    expect(INGREDIENTS_CAVEAT).toMatch(/celiac/i);
    expect(INGREDIENTS_CAVEAT).toMatch(/human/i);
  });

  it("is absent, rather than empty, when the menu names none", () => {
    // "The menu does not say" and "this dish has no ingredients" are not
    // the same claim, and only one of them is true.
    const extraction = normalizeExtraction(answer(), CONTEXT)!;
    expect(extraction.categories[0].items[0].ingredients).toBeNull();
  });

  it("carries the caveat into the column comment the database ships", () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          "../../supabase/migrations/20260813150000_menu_import_extraction.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(sql).toMatch(/INGREDIENTS ARE NOT AN ALLERGEN LIST/);
    expect(sql).toMatch(/allergen_note/);
    expect(sql).toMatch(/transfers to a human/i);
  });
});

describe("the menu's own shape", () => {
  it("keeps the menu's categories, in the menu's order, in the menu's language", () => {
    const extraction = normalizeExtraction(
      answer({
        language: "Italian",
        categories: [
          { name: "Antipasti", name_confidence: "confident", items: [item({ name: "Bruschetta" })] },
          { name: "Primi", name_confidence: "confident", items: [item({ name: "Cacio e pepe" })] },
        ],
      }),
      CONTEXT,
    )!;

    expect(extraction.categories.map((c) => c.name)).toEqual(["Antipasti", "Primi"]);
    expect(extraction.document.language).toBe("Italian");
    expect(extraction.categories[1].items[0].name).toBe("Cacio e pepe");
  });

  it("names which file each item came from, so a re-check names a photo", () => {
    const extraction = normalizeExtraction(
      answer({
        categories: [
          {
            name: "Dolci",
            name_confidence: "confident",
            items: [item({ file_index: 1 }), item({ name: "Tiramisu", file_index: 7 })],
          },
        ],
      }),
      CONTEXT,
    )!;

    expect(extraction.categories[0].items[0].file_index).toBe(1);
    // Out of range points at nothing; the first file is a place a human
    // can start, and the item is still shown either way.
    expect(extraction.categories[0].items[1].file_index).toBe(0);
    expect(extraction.files).toEqual(FILES);
    expect(extraction.file).toEqual(FILES[0]);
  });

  it("records the model and the moment, because raw_extraction is evidence", () => {
    const extraction = normalizeExtraction(answer(), CONTEXT)!;
    expect(extraction.model).toBe("claude-opus-5");
    expect(extraction.read_at).toBe("2026-08-13T12:00:00.000Z");
    expect(extraction.schema_version).toBe(EXTRACTION_SCHEMA_VERSION);
  });
});

describe("what came back was not a menu", () => {
  it("keeps the verdict and the sentence a human can act on", () => {
    const extraction = normalizeExtraction(
      { document_kind: "not_a_menu", note: "This is a photo of a parking receipt.", language: null, categories: [] },
      CONTEXT,
    )!;

    expect(extraction.document.kind).toBe("not_a_menu");
    expect(extraction.document.note).toMatch(/parking receipt/);
    expect(extraction.categories).toEqual([]);
    expect(extraction.totals.items).toBe(0);
    expect(extractionHasItems(extraction)).toBe(false);
  });

  it("calls a menu with nothing in it unreadable, so the verdict matches the items", () => {
    const extraction = normalizeExtraction(
      { document_kind: "menu", note: "", language: null, categories: [] },
      CONTEXT,
    )!;
    expect(extraction.document.kind).toBe("unreadable");
    expect(extraction.document.note).toMatch(/sharper photo/i);
  });

  it("always leaves a note, even when the model left it blank", () => {
    const extraction = normalizeExtraction(
      { document_kind: "not_a_menu", note: "   ", language: "  ", categories: [] },
      CONTEXT,
    )!;
    expect(extraction.document.note.length).toBeGreaterThan(0);
    expect(extraction.document.language).toBeNull();
  });
});

describe("what the model sent back was not the shape we asked for", () => {
  it("refuses an answer that is not an object at all", () => {
    for (const raw of [null, "a menu", 42, ["Antipasti"]]) {
      expect(normalizeExtraction(raw, CONTEXT)).toBeNull();
    }
  });

  it("drops an item with no name rather than showing a nameless price", () => {
    const extraction = normalizeExtraction(
      answer({
        categories: [
          {
            name: "Antipasti",
            name_confidence: "confident",
            items: [item({ name: "  " }), item({ name: "Olive" }), "not an item"],
          },
        ],
      }),
      CONTEXT,
    )!;
    expect(extraction.categories[0].items.map((i) => i.name)).toEqual(["Olive"]);
  });

  it("drops a category left with nothing in it, and says so in the verdict", () => {
    const extraction = normalizeExtraction(
      answer({
        categories: [
          { name: "Antipasti", name_confidence: "confident", items: [] },
          { name: "Primi", name_confidence: "confident", items: "not a list" },
        ],
      }),
      CONTEXT,
    )!;
    expect(extraction.categories).toEqual([]);
    expect(extraction.document.kind).toBe("unreadable");
  });

  it("names an unheaded run of items rather than leaving it blank", () => {
    const extraction = normalizeExtraction(
      answer({ categories: [{ name: "", name_confidence: "unsure", items: [item()] }] }),
      CONTEXT,
    )!;
    expect(extraction.categories[0].name).toBe("Other");
  });
});

describe("the line the file list shows", () => {
  it("leads with what needs checking", () => {
    const extraction = normalizeExtraction(
      answer({
        categories: [
          {
            name: "Antipasti",
            name_confidence: "confident",
            items: [item(), item({ name: "Arancini", price_confidence: "unknown", price_as_printed: "" })],
          },
        ],
      }),
      CONTEXT,
    )!;
    expect(extractionSummary(extraction)).toBe("2 items found, 1 to check");
  });

  it("says so plainly when nothing is flagged, or when nothing was read", () => {
    expect(extractionSummary(normalizeExtraction(answer(), CONTEXT))).toBe(
      "1 item found, none flagged",
    );
    expect(
      extractionSummary(
        normalizeExtraction({ document_kind: "not_a_menu", note: "x", language: null, categories: [] }, CONTEXT),
      ),
    ).toMatch(/does not look like a menu/);
  });

  it("says nothing at all about a file nobody has read yet", () => {
    expect(extractionSummary({})).toBeNull();
    expect(extractionSummary(null)).toBeNull();
  });
});

describe("what we ask the model for", () => {
  it("offers 'unknown' as a price answer, so a price need never be invented", () => {
    const item = (MENU_EXTRACTION_JSON_SCHEMA.properties.categories.items.properties.items
      .items.properties) as Record<string, { enum?: readonly string[] }>;
    expect(item.price_confidence.enum).toContain("unknown");
    // Names and descriptions have no "unknown": an unreadable name means
    // there is no item to show, not an item with a blank where it goes.
    expect(item.name_confidence.enum).toEqual(["confident", "unsure"]);
  });

  it("leaves the model no shape in which a field can simply be missing", () => {
    const schema = MENU_EXTRACTION_JSON_SCHEMA;
    expect(schema.additionalProperties).toBe(false);
    const itemSchema = schema.properties.categories.items.properties.items.items;
    expect(itemSchema.additionalProperties).toBe(false);
    expect([...itemSchema.required]).toEqual(Object.keys(itemSchema.properties));
  });
});
