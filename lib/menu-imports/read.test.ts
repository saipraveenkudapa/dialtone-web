import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MENU_BATCH_BYTES } from "./file";

/* Handing a menu to a model, and every way that can go wrong.
 *
 * The model is a double here on purpose: these tests are about what this
 * app does with an answer, not about what Claude says. The rule they all
 * circle is the same one -- a read that did not finish must leave the
 * rows untouched, so the owner can try again rather than confirm half a
 * menu that looks whole. */

const state = vi.hoisted(() => ({
  sent: null as Record<string, unknown> | null,
  reply: null as unknown,
  throws: null as unknown,
}));

class FakeAPIError extends Error {}
class FakeAuthenticationError extends FakeAPIError {}
class FakeRateLimitError extends FakeAPIError {}

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    static AuthenticationError = FakeAuthenticationError;
    static RateLimitError = FakeRateLimitError;
    static APIError = FakeAPIError;

    constructor(readonly options: { apiKey: string }) {}

    messages = {
      stream: (params: Record<string, unknown>) => {
        state.sent = params;
        return {
          finalMessage: async () => {
            if (state.throws) throw state.throws;
            return state.reply;
          },
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

const { readMenu } = await import("./read");

const said = (json: unknown, stop = "end_turn") => ({
  stop_reason: stop,
  content: [{ type: "text", text: typeof json === "string" ? json : JSON.stringify(json) }],
});

const MENU = {
  document_kind: "menu",
  note: "Read cleanly.",
  language: "Italian",
  categories: [
    {
      name: "Antipasti",
      name_confidence: "confident",
      items: [
        {
          name: "Bruschetta",
          name_confidence: "confident",
          price_as_printed: "9.50",
          price_confidence: "confident",
          description: "",
          description_confidence: "confident",
          ingredients: [],
          ingredients_confidence: "confident",
          file_index: 0,
        },
      ],
    },
  ],
};

const photo = (over: Record<string, unknown> = {}) => ({
  filename: "menu-front.jpg",
  mediaType: "image/jpeg",
  bytes: 2_000_000,
  base64: "AAAA",
  sourceType: "image" as const,
  ...over,
});

const pdf = () =>
  photo({ filename: "menu.pdf", mediaType: "application/pdf", sourceType: "pdf" as const });

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  state.sent = null;
  state.reply = said(MENU);
  state.throws = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("what gets sent", () => {
  it("sends every file of the batch in one call, each named before its bytes", async () => {
    await readMenu([photo(), photo({ filename: "menu-back.jpg", base64: "BBBB" })]);

    const content = (state.sent!.messages as { content: Record<string, unknown>[] }[])[0].content;
    expect(content.map((block) => block.type)).toEqual([
      "text",
      "image",
      "text",
      "image",
      "text",
    ]);
    expect(content[0].text).toBe("File 0: menu-front.jpg");
    expect(content[2].text).toBe("File 1: menu-back.jpg");
    expect(content[4].text).toMatch(/These 2 files are one menu/);
  });

  it("sends a multi-page PDF as one document, not as pictures of pages", async () => {
    // A PDF goes over whole: the API reads every page of it, so a ten-page
    // wine list is one block and one read rather than ten of each.
    await readMenu([pdf()]);

    const content = (state.sent!.messages as { content: Record<string, unknown>[] }[])[0].content;
    const document = content.find((block) => block.type === "document") as {
      source: { media_type: string; type: string };
    };
    expect(document.source).toMatchObject({ type: "base64", media_type: "application/pdf" });
    expect(content.find((block) => block.type === "image")).toBeUndefined();
    expect(content.at(-1)!.text).toMatch(/This file is one menu/);
  });

  it("asks for the shape it is going to check, from the model that can read a photograph", async () => {
    await readMenu([photo()]);

    expect(state.sent!.model).toBe("claude-opus-5");
    const output = state.sent!.output_config as {
      format: { type: string; schema: Record<string, unknown> };
    };
    expect(output.format.type).toBe("json_schema");
    expect(output.format.schema.additionalProperties).toBe(false);
  });

  it("tells the model, in the system prompt, the two things that cost money", async () => {
    await readMenu([photo()]);
    const system = state.sent!.system as string;
    // Never guess a price...
    expect(system).toMatch(/price_confidence to "unknown"/);
    expect(system).toMatch(/Do not estimate a price/);
    // ...and never turn a printed ingredient into an allergen claim.
    expect(system).toMatch(/not an allergen list/i);
    expect(system).toMatch(/do not translate/i);
  });
});

describe("a read that worked", () => {
  it("gives every file the same reading, and tells each one which file it is", async () => {
    const result = await readMenu([photo(), photo({ filename: "menu-back.jpg" })]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extractions).toHaveLength(2);
    // One menu, read once: a section running from the bottom of one photo
    // to the top of the next stays one section on both rows.
    expect(result.extractions[0].categories).toEqual(result.extractions[1].categories);
    expect(result.extractions[0].file).toEqual({
      index: 0,
      filename: "menu-front.jpg",
      source_type: "image",
    });
    expect(result.extractions[1].file.index).toBe(1);
    expect(result.extractions[0].files).toHaveLength(2);
    expect(result.extractions[0].categories[0].items[0].price).toMatchObject({
      known: true,
      cents: 950,
    });
  });

  it("hands back a not-a-menu verdict rather than treating it as a failure", async () => {
    // A model calling a hand-lettered chalkboard "not a menu" is exactly
    // the call an owner overrules, so this reaches a human like any other.
    state.reply = said({
      document_kind: "not_a_menu",
      note: "This looks like a parking receipt.",
      language: null,
      categories: [],
    });

    const result = await readMenu([photo()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extractions[0].document.kind).toBe("not_a_menu");
    expect(result.extractions[0].totals.items).toBe(0);
  });

  it("hands back an unreadable verdict the same way", async () => {
    state.reply = said({
      document_kind: "unreadable",
      note: "The photo is too blurred to read any prices.",
      language: null,
      categories: [],
    });

    const result = await readMenu([photo()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.extractions[0].document.kind).toBe("unreadable");
    expect(result.extractions[0].document.note).toMatch(/blurred/);
  });

  it("reads a menu in another language without translating it", async () => {
    state.reply = said({
      document_kind: "menu",
      note: "Read cleanly.",
      language: "Italian",
      categories: [
        {
          name: "Secondi Piatti",
          name_confidence: "confident",
          items: [
            {
              name: "Saltimbocca alla Romana",
              name_confidence: "confident",
              price_as_printed: "24.00",
              price_confidence: "confident",
              description: "Vitello, prosciutto crudo e salvia",
              description_confidence: "confident",
              ingredients: ["vitello", "prosciutto crudo", "salvia"],
              ingredients_confidence: "confident",
              file_index: 0,
            },
          ],
        },
      ],
    });

    const result = await readMenu([photo()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const found = result.extractions[0];
    expect(found.document.language).toBe("Italian");
    expect(found.categories[0].name).toBe("Secondi Piatti");
    expect(found.categories[0].items[0].name).toBe("Saltimbocca alla Romana");
    expect(found.categories[0].items[0].ingredients?.verified).toBe(false);
  });
});

describe("a read that did not finish", () => {
  it("says so when the answer is not JSON, instead of writing half a menu", async () => {
    state.reply = said("I had a look at your menu and here is what I found:");

    const result = await readMenu([photo()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
    expect(result.error).toMatch(/could not be understood/i);
  });

  it("says so when the answer is JSON of the wrong shape", async () => {
    state.reply = said(["Antipasti", "Primi"]);

    const result = await readMenu([photo()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });

  it("says so when the answer ran out of room, rather than trusting the part that arrived", async () => {
    state.reply = said('{"document_kind":"menu","categ', "max_tokens");

    const result = await readMenu([photo()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("truncated");
    expect(result.error).toMatch(/a few pages at a time/i);
  });

  it("says so when the model declined to read the files", async () => {
    state.reply = { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] };

    const result = await readMenu([photo()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("refused");
  });

  it("says so when the answer had no text in it at all", async () => {
    state.reply = { stop_reason: "end_turn", content: [] };

    const result = await readMenu([photo()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("malformed");
  });
});

describe("when the key is missing or refused", () => {
  it("fails with a sentence naming the variable and where to set it", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const result = await readMenu([photo()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_configured");
    expect(result.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(result.error).toMatch(/\.env\.local/);
    expect(result.error).toMatch(/Vercel/);
    // Never a stack trace, and never a hint that the fix is in the browser.
    expect(result.error).not.toMatch(/NEXT_PUBLIC_ANTHROPIC/);
  });

  it("fails the same way when the key exists but the API rejects it", async () => {
    state.throws = new FakeAuthenticationError("401");

    const result = await readMenu([photo()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_configured");
    expect(result.error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("asks for a retry when the account is over its rate limit", async () => {
    state.throws = new FakeRateLimitError("429");

    const result = await readMenu([photo()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unavailable");
    expect(result.error).toMatch(/try again/i);
  });

  it("asks for a retry when the call blew up for any other reason", async () => {
    state.throws = new Error("socket hang up");

    const result = await readMenu([photo()]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unavailable");
    // Whatever the library said, the owner gets a sentence.
    expect(result.error).not.toMatch(/socket/);
  });
});

describe("what will not even be attempted", () => {
  it("refuses a batch too big for one request, naming the size and the fix", async () => {
    const huge = [photo({ bytes: MAX_MENU_BATCH_BYTES }), photo({ bytes: 1 })];

    const result = await readMenu(huge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too_large");
    expect(result.error).toMatch(/16 MB/);
    expect(result.error).toMatch(/Remove a file/);
    // Nothing was spent finding that out.
    expect(state.sent).toBeNull();
  });

  it("refuses an empty batch without calling anything", async () => {
    const result = await readMenu([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_files");
    expect(state.sent).toBeNull();
  });
});
