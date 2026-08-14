import { describe, expect, it } from "vitest";
import { callerFieldText, hasUsableCallerName, hasUsableCallerPhone } from "./caller";

describe("hasUsableCallerName", () => {
  it("accepts an ordinary first name", () => {
    expect(hasUsableCallerName("Marcus")).toBe(true);
  });

  it("accepts a name with punctuation, the way app.caller_name_key does", () => {
    expect(hasUsableCallerName("O'Brien")).toBe(true);
  });

  it("accepts a full name -- app.caller_name_key only takes the first word, but this is just asking whether one survives", () => {
    expect(hasUsableCallerName("Marcus Webb")).toBe(true);
  });

  // The reachable failure this whole file exists for: a name a transcript
  // reduced to digits, which is exactly app.caller_name_key's own
  // "nothing alphabetic survives" example.
  it("rejects a name transcribed as digits", () => {
    expect(hasUsableCallerName("22")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(hasUsableCallerName("")).toBe(false);
  });

  it("rejects whitespace only", () => {
    expect(hasUsableCallerName("   ")).toBe(false);
  });

  it("rejects null", () => {
    expect(hasUsableCallerName(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(hasUsableCallerName(undefined)).toBe(false);
  });
});

describe("hasUsableCallerPhone", () => {
  it("accepts a plain 10-digit number", () => {
    expect(hasUsableCallerPhone("5105551014")).toBe(true);
  });

  it("accepts a formatted number, the way a caller actually says one", () => {
    expect(hasUsableCallerPhone("+1 (510) 555-1014")).toBe(true);
  });

  it("accepts the shortest length app.caller_phone_key still keys on -- 7 digits", () => {
    expect(hasUsableCallerPhone("5551014")).toBe(true);
  });

  // The other reachable failure: a phone number heard as too few digits
  // for app.caller_phone_key to trust, one short of its own 7-digit floor.
  it("rejects six digits, one short of app.caller_phone_key's floor", () => {
    expect(hasUsableCallerPhone("555101")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(hasUsableCallerPhone("")).toBe(false);
  });

  it("rejects null", () => {
    expect(hasUsableCallerPhone(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(hasUsableCallerPhone(undefined)).toBe(false);
  });
});

/** Both predicates used to be annotated `string | null | undefined` and
 *  called `.replace` on whatever arrived. Their callers reach them
 *  through an `as {customer_phone?: string}` cast over a JSON.parse of a
 *  model-authored arguments string, so the annotation was a claim tsc
 *  checked and the runtime never honoured: `"customer_phone": 5105550100`
 *  threw `TypeError: replace is not a function` straight out of
 *  cancel-reservation and change-reservation, which Next turns into a
 *  framework 500, which Vapi discards entirely -- dead air for a caller
 *  ringing to cancel a table. Widened to `unknown` so the question can be
 *  ASKED about anything, and answered rather than thrown. */
describe("neither predicate throws on a field that is not a string", () => {
  const NOT_STRINGS: unknown[] = [
    5105550100,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    true,
    false,
    {},
    { area: "510" },
    [],
    ["510", "555", "0100"],
    null,
    undefined,
  ];

  it.each(NOT_STRINGS.map((v) => [JSON.stringify(v) ?? String(v), v] as const))(
    "answers rather than throws for %s",
    (_label, value) => {
      expect(() => hasUsableCallerName(value)).not.toThrow();
      expect(() => hasUsableCallerPhone(value)).not.toThrow();
      expect(typeof hasUsableCallerName(value)).toBe("boolean");
      expect(typeof hasUsableCallerPhone(value)).toBe("boolean");
    },
  );

  it("accepts a phone number the model sent unquoted, the way spokenPhone does", () => {
    // lib/agent/messages.ts calls callback_number "the one field a tool
    // payload plausibly carries as a JSON number rather than a string",
    // and coerces it rather than asking a caller to repeat a number the
    // agent heard perfectly well. Same answer here, so take_message and
    // the two booking routes agree.
    expect(hasUsableCallerPhone(5105550100)).toBe(true);
  });

  it("refuses a name transcribed as a bare number, as it does the string '22'", () => {
    expect(hasUsableCallerName(22)).toBe(false);
    expect(hasUsableCallerName("22")).toBe(false);
  });

  it("refuses a shape nobody should guess at", () => {
    // Not a mis-heard field -- a payload. The same line normaliseItemNote
    // and spokenText draw.
    for (const value of [{}, { area: "510" }, [], ["510"], true, false]) {
      expect(hasUsableCallerName(value)).toBe(false);
      expect(hasUsableCallerPhone(value)).toBe(false);
    }
  });
});

describe("callerFieldText", () => {
  it("passes a string through untouched", () => {
    expect(callerFieldText("+1 (510) 555-1014")).toBe("+1 (510) 555-1014");
    expect(callerFieldText("O'Brien")).toBe("O'Brien");
    expect(callerFieldText("")).toBe("");
  });

  it("renders a finite number as its digits, so the gate and the write agree", () => {
    // A check that approves "5105550100" and then hands Postgres the
    // JSON number 5105550100 has approved something it did not send.
    expect(callerFieldText(5105550100)).toBe("5105550100");
    expect(callerFieldText(0)).toBe("0");
  });

  it("gives nothing for NaN and Infinity, which stringify into non-numbers", () => {
    expect(callerFieldText(NaN)).toBe("");
    expect(callerFieldText(Infinity)).toBe("");
    expect(callerFieldText(-Infinity)).toBe("");
  });

  it("gives nothing for every other shape", () => {
    for (const value of [null, undefined, true, false, {}, [], () => {}]) {
      expect(callerFieldText(value)).toBe("");
    }
  });
});
