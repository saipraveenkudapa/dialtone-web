import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { anthropicEnv } from "@/lib/anthropic/env";
import { MAX_MENU_BATCH_BYTES } from "@/lib/menu-imports/file";
import {
  MENU_EXTRACTION_JSON_SCHEMA,
  normalizeExtraction,
  type ExtractionFile,
  type MenuExtraction,
} from "@/lib/menu-imports/extraction";
import { fileSize } from "@/lib/menu-imports/file";

/** Handing a menu to Claude and getting structured items back.
 *
 *  The whole batch goes in one request. A menu is often three photos and
 *  a section routinely runs off the bottom of one and onto the top of the
 *  next, so reading the photos separately would invent a category break
 *  that is not on the card. One call, every page, one answer -- and every
 *  item says which file it came from, so "go and re-check this one" still
 *  names a photograph.
 *
 *  Nothing this returns is a menu. It is a proposal, written to
 *  menu_imports.raw_extraction for a human to confirm; no price here has
 *  ever been near menu_items. */

/** The model, pinned. Reading a photograph of a laminated card under
 *  glare is a vision problem where being right matters more than being
 *  cheap: a price misread here is quoted down the phone until somebody
 *  notices. */
const MODEL = "claude-opus-5";

/** Thinking is on by default on this model; saying so keeps the request
 *  honest if the default ever moves. `high` effort is the API default
 *  too -- named here because it is a deliberate choice, not a leftover. */
const EFFORT = "high" as const;

/** A ten-page menu with descriptions and ingredients is a long answer,
 *  and a truncated one is a refusal that looks like success. Generous,
 *  and streamed so a long turn cannot trip an HTTP timeout. */
const MAX_TOKENS = 32000;

const SYSTEM = `You read photographs and PDFs of restaurant menus for a phone assistant that quotes prices to callers.

A price you get wrong is read aloud to a caller and comes out of the restaurant's pocket, so an unread price is a good answer and a plausible one is not. Where you cannot make a price out - glare, a fold, a crop, handwriting - set price_confidence to "unknown" and leave price_as_printed empty. Where something is printed but is not a plain amount - "market price", a range, a price by weight - copy it into price_as_printed exactly as printed and set price_confidence to "unknown", so the person checking sees what is on the card. Do not estimate a price, round one, do arithmetic on one, or carry one across from a similar dish.

Copy what is printed. Item names, descriptions and section headings keep the menu's own wording and its own language; do not translate, tidy or expand them. Use the menu's own section headings in the order they are printed, and where a run of items sits under no heading, call that section "Other".

List ingredients only where the menu names them for that dish, and only the ones it names. Do not add the ingredients a dish usually contains. These are not an allergen list and are never read as one - a printed menu cannot know that the fryer is shared or that something is finished in butter - so an empty list is the right answer wherever the menu is silent.

Mark a field "unsure" when the print is blurry, cut off, ambiguous, or you had to choose between readings; "confident" means you can read it plainly.

If the files do not show a menu, use document_kind "not_a_menu" and return no categories. If they show a menu you cannot read, use "unreadable". Either way, put one plain sentence in "note" telling the restaurant owner what to do about it.`;

/** One file, already fetched. The bytes are base64 because that is what
 *  the API takes; the caller reads them out of the private bucket. */
export type MenuReadFile = {
  filename: string | null;
  /** `image/jpeg`, `image/png`, `image/webp` or `application/pdf`. */
  mediaType: string;
  /** Size of the stored object, for the batch ceiling and the message. */
  bytes: number;
  base64: string;
  sourceType: ExtractionFile["source_type"];
};

/** Why a read produced nothing. The tag is for tests and logs; `error` is
 *  the sentence the owner is shown, and each one says what to do next. */
export type MenuReadFailure =
  | "not_configured"
  | "too_large"
  | "no_files"
  | "refused"
  | "truncated"
  | "malformed"
  | "unavailable";

export type MenuReadResult =
  | { ok: true; extractions: MenuExtraction[] }
  | { ok: false; reason: MenuReadFailure; error: string };

type Block = Anthropic.Messages.ContentBlockParam;

/** Reads one menu -- every file of a batch, in one call.
 *
 *  Returns one extraction per input file, in the same order. They share
 *  the reading (a category that runs across two photos stays one
 *  category) and differ only in which file each row is, so every
 *  menu_imports row can carry the whole result and still say which
 *  photograph it is. */
export async function readMenu(files: MenuReadFile[]): Promise<MenuReadResult> {
  if (files.length === 0) {
    return { ok: false, reason: "no_files", error: "There is nothing to read." };
  }

  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > MAX_MENU_BATCH_BYTES) {
    return {
      ok: false,
      reason: "too_large",
      error:
        `These files come to ${fileSize(total)} together, and one menu can be read up to ` +
        `${fileSize(MAX_MENU_BATCH_BYTES)}. Remove a file, or upload smaller photos, and try again.`,
    };
  }

  let client: Anthropic;
  try {
    client = new Anthropic({ apiKey: anthropicEnv().apiKey });
  } catch (error) {
    // The one error in this file worth showing verbatim: it is the
    // sentence lib/anthropic/env.ts wrote for exactly this moment.
    return {
      ok: false,
      reason: "not_configured",
      error: error instanceof Error ? error.message : "Reading a menu is not configured.",
    };
  }

  const content: Block[] = [];
  files.forEach((file, index) => {
    // Named before the bytes, so "file 2" in the answer means the file
    // the owner called menu-back.jpg rather than the second thing the
    // model happened to look at.
    content.push({
      type: "text",
      text: `File ${index}: ${file.filename ?? "menu file"}`,
    });
    content.push(
      file.mediaType === "application/pdf"
        ? {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: file.base64 },
          }
        : {
            type: "image",
            source: {
              type: "base64",
              media_type: file.mediaType as "image/jpeg" | "image/png" | "image/webp",
              data: file.base64,
            },
          },
    );
  });
  content.push({
    type: "text",
    text:
      files.length === 1
        ? "This file is one menu. Read every page of it and return the menu as JSON."
        : `These ${files.length} files are one menu, in order. Read every page of every file and return the whole menu as JSON.`,
  });

  let message: Anthropic.Messages.Message;
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      thinking: { type: "adaptive" },
      output_config: {
        effort: EFFORT,
        format: { type: "json_schema", schema: MENU_EXTRACTION_JSON_SCHEMA },
      },
      messages: [{ role: "user", content }],
    });
    message = await stream.finalMessage();
  } catch (error) {
    console.error("[menu-imports] the model call failed", error);
    if (error instanceof Anthropic.AuthenticationError) {
      return {
        ok: false,
        reason: "not_configured",
        error:
          "The Anthropic API key was refused. Check ANTHROPIC_API_KEY in .env.local and in " +
          "the Vercel project's environment variables.",
      };
    }
    if (error instanceof Anthropic.RateLimitError) {
      return {
        ok: false,
        reason: "unavailable",
        error: "Too many menus are being read at once. Wait a minute and try again.",
      };
    }
    return {
      ok: false,
      reason: "unavailable",
      error: "The menu could not be read just now. Try again in a minute.",
    };
  }

  // A safety classifier declined. Nothing was read, so nothing is written
  // -- the files stay where they are and a human can look at them.
  if (message.stop_reason === "refusal") {
    return {
      ok: false,
      reason: "refused",
      error:
        "The reader would not read these files. If they really are a menu, type the items " +
        "in by hand for now and tell us what was in them.",
    };
  }

  // Ran out of room mid-answer. The JSON is cut off, and half a menu that
  // looks whole is worse than no menu at all.
  if (message.stop_reason === "max_tokens") {
    return {
      ok: false,
      reason: "truncated",
      error:
        "This menu is longer than one read can hold. Upload it a few pages at a time and " +
        "read each part separately.",
    };
  }

  const answer = message.content.find((block) => block.type === "text");
  if (!answer || answer.type !== "text") {
    return {
      ok: false,
      reason: "malformed",
      error: "The reader answered with nothing. Try again.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.text);
  } catch {
    // Structured output should make this impossible, which is exactly why
    // it is handled: the day it happens, an owner gets a sentence rather
    // than a stack trace, and the row stays pending so the file can be
    // read again for the cost of one more call.
    console.error("[menu-imports] the model's answer was not JSON");
    return {
      ok: false,
      reason: "malformed",
      error: "The reader's answer could not be understood. Try reading this menu again.",
    };
  }

  const readAt = new Date().toISOString();
  const described: ExtractionFile[] = files.map((file, index) => ({
    index,
    filename: file.filename,
    source_type: file.sourceType,
  }));

  const extractions: MenuExtraction[] = [];
  for (const file of described) {
    const extraction = normalizeExtraction(parsed, {
      file,
      files: described,
      model: MODEL,
      readAt,
    });
    if (!extraction) {
      console.error("[menu-imports] the model's answer was not the shape we asked for");
      return {
        ok: false,
        reason: "malformed",
        error: "The reader's answer could not be understood. Try reading this menu again.",
      };
    }
    extractions.push(extraction);
  }

  return { ok: true, extractions };
}
