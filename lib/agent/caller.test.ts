import { describe, expect, it } from "vitest";
import { hasUsableCallerName, hasUsableCallerPhone } from "./caller";

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
