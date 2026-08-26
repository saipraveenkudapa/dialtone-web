import { describe, expect, it } from "vitest";
import {
  buildMessage,
  MAX_CALLBACK_PHONE_LENGTH,
  MAX_CALLER_NAME_LENGTH,
  MAX_MESSAGE_LENGTH,
} from "./messages";

/** A payload the way the tool actually sends one, so each test can vary
 *  the single field it is about. */
const payload = (over: Record<string, unknown> = {}) => ({
  caller_name: "Dana Whitlock",
  callback_number: "+1 (510) 555-0119",
  message: "She's unhappy about last Friday's order and wants the manager to ring her.",
  ...over,
});

describe("taking a message", () => {
  it("keeps the three things somebody needs to act on it", () => {
    const result = buildMessage(payload());
    expect(result).toEqual({
      ok: true,
      message: {
        caller_name: "Dana Whitlock",
        callback_phone: "+1 (510) 555-0119",
        body: "She's unhappy about last Friday's order and wants the manager to ring her.",
      },
    });
  });

  it("collapses the whitespace speech-to-text sprays through a transcript", () => {
    const result = buildMessage(
      payload({ caller_name: "  Dana   Whitlock ", message: "wants\n\na   callback" }),
    );
    expect(result).toEqual({
      ok: true,
      message: {
        caller_name: "Dana Whitlock",
        callback_phone: "+1 (510) 555-0119",
        body: "wants a callback",
      },
    });
  });

  it("takes a callback number sent as a JSON number rather than a string", () => {
    // A tool payload plausibly carries this unquoted. Asking the caller to
    // repeat a number that was heard perfectly well is the worse answer.
    const result = buildMessage(payload({ callback_number: 5105550119 }));
    expect(result).toEqual({
      ok: true,
      message: expect.objectContaining({ callback_phone: "5105550119" }),
    });
  });

  it("refuses a NaN or Infinity callback number rather than storing its spelling", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildMessage(payload({ callback_number: value }))).toEqual({
        ok: false,
        reason: "no_callback",
      });
    }
  });
});

describe("refusing a message nobody could act on", () => {
  it("asks again when there is no name", () => {
    for (const value of [undefined, null, "", "   ", 42, { first: "Dana" }, ["Dana"]]) {
      expect(buildMessage(payload({ caller_name: value }))).toEqual({
        ok: false,
        reason: "no_name",
      });
    }
  });

  it("asks again when the 'name' carries no letters -- a name transcribed as digits", () => {
    expect(buildMessage(payload({ caller_name: "22" }))).toEqual({
      ok: false,
      reason: "no_name",
    });
  });

  it("asks again when there is no callback number", () => {
    for (const value of [undefined, null, "", "  ", true, { number: "555" }]) {
      expect(buildMessage(payload({ callback_number: value }))).toEqual({
        ok: false,
        reason: "no_callback",
      });
    }
  });

  it("asks again for a number too short to be one -- five digits heard out of ten", () => {
    expect(buildMessage(payload({ callback_number: "55501" }))).toEqual({
      ok: false,
      reason: "no_callback",
    });
  });

  it("asks again when there is nothing to pass on", () => {
    for (const value of [undefined, null, "", "     ", 7, {}]) {
      expect(buildMessage(payload({ message: value }))).toEqual({
        ok: false,
        reason: "no_message",
      });
    }
  });

  it("reports the first thing it could not hear, so the agent asks one question at a time", () => {
    expect(
      buildMessage({ caller_name: "", callback_number: "", message: "" }),
    ).toEqual({ ok: false, reason: "no_name" });
    expect(buildMessage({ caller_name: "Dana", callback_number: "", message: "" })).toEqual({
      ok: false,
      reason: "no_callback",
    });
  });
});

describe("bounding what gets written", () => {
  it("truncates a message that runs on, rather than losing the whole thing", () => {
    const result = buildMessage(payload({ message: "a".repeat(MAX_MESSAGE_LENGTH + 50) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.body).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  it("keeps a message exactly at the limit whole", () => {
    const body = "b".repeat(MAX_MESSAGE_LENGTH);
    const result = buildMessage(payload({ message: body }));
    expect(result).toEqual({ ok: true, message: expect.objectContaining({ body }) });
  });

  it("asks again for an over-long name instead of truncating it -- half a name is somebody else", () => {
    expect(
      buildMessage(payload({ caller_name: "Dana ".repeat(MAX_CALLER_NAME_LENGTH) })),
    ).toEqual({ ok: false, reason: "no_name" });
  });

  it("asks again for an over-long callback number -- half a number is a wrong number", () => {
    expect(
      buildMessage(payload({ callback_number: "5".repeat(MAX_CALLBACK_PHONE_LENGTH + 1) })),
    ).toEqual({ ok: false, reason: "no_callback" });
  });
});

describe("card numbers in what a caller said", () => {
  it("redacts a card number read out into the message itself", () => {
    const result = buildMessage(
      payload({ message: "You charged my card 4111 1111 1111 1111 twice on Friday" }),
    );
    expect(result).toEqual({
      ok: true,
      message: expect.objectContaining({
        body: "You charged my card [redacted] twice on Friday",
      }),
    });
  });

  it("redacts before truncating, so a card cut at the boundary cannot survive", () => {
    // The card number straddles MAX_MESSAGE_LENGTH: truncate first and the
    // tail left behind is too short for the pattern to recognise, and the
    // head of a real card number stays in the column forever.
    const prefix = `${"x".repeat(MAX_MESSAGE_LENGTH - 9)} `;
    const result = buildMessage(payload({ message: `${prefix}4111111111111111 thanks` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.body).toBe(`${prefix}[redacted]`.slice(0, MAX_MESSAGE_LENGTH));
    expect(result.message.body).not.toMatch(/\d{4}/);
  });

  it("asks again -- and stores nothing -- when a card number is given as the callback number", () => {
    // The whole field is dropped rather than masked: a caller who answers
    // "what's a good number for you?" by reading out a card is asked for
    // a number again, and no part of the card reaches a column, a payload
    // or a log line.
    for (const card of ["4111 1111 1111 1111", "378282246310005", 4111111111111111]) {
      expect(buildMessage(payload({ callback_number: card }))).toEqual({
        ok: false,
        reason: "no_callback",
      });
    }
  });

  it("keeps an international callback number instead of scrubbing it into a refusal loop", () => {
    // These are the numbers that broke this. Each is past the 13-digit
    // floor `redactCardNumbers` matches on, so running the message
    // scrubber over this field turned every one of them into
    // "[redacted]" -- no digits, so `hasUsableCallerPhone` said no, so
    // the agent said "I didn't catch the best number to call you back
    // on", so the caller said it again, and the name and the message
    // were thrown away every time. The caller could not get out of it by
    // answering the question correctly, which is the definition of the
    // loop reservation/route.ts refuses to build.
    for (const number of [
      "011 44 20 7946 0958",
      "00 91 98765 43210",
      "011 33 1 42 68 53 00",
      "011442079460958x22",
    ]) {
      expect(buildMessage(payload({ callback_number: number }))).toEqual({
        ok: true,
        message: expect.objectContaining({ callback_phone: number }),
      });
    }
  });

  it("keeps the name and the message when the callback number is a long one", () => {
    // The loop did not only cost the number: everything the caller had
    // already said went with it, every time round.
    expect(buildMessage(payload({ callback_number: "011 44 20 7946 0958" }))).toEqual({
      ok: true,
      message: {
        caller_name: "Dana Whitlock",
        callback_phone: "011 44 20 7946 0958",
        body: "She's unhappy about last Friday's order and wants the manager to ring her.",
      },
    });
  });

  it("still redacts a card number the caller reads into the message body", () => {
    // The body is text, and text is still scrubbed -- only the callback
    // number changed.
    const result = buildMessage(
      payload({
        callback_number: "011 44 20 7946 0958",
        message: "You charged 4111 1111 1111 1111 twice",
      }),
    );
    expect(result).toEqual({
      ok: true,
      message: expect.objectContaining({
        callback_phone: "011 44 20 7946 0958",
        body: "You charged [redacted] twice",
      }),
    });
  });

  it("leaves an ordinary callback number alone", () => {
    for (const number of ["+15105550119", "(510) 555-0119", "510.555.0119 x24"]) {
      const result = buildMessage(payload({ callback_number: number }));
      expect(result).toEqual({
        ok: true,
        message: expect.objectContaining({ callback_phone: number }),
      });
    }
  });

  it("redacts a card number said in place of a name", () => {
    const result = buildMessage(payload({ caller_name: "Dana 4111111111111111" }));
    expect(result).toEqual({
      ok: true,
      message: expect.objectContaining({ caller_name: "Dana [redacted]" }),
    });
  });
});
