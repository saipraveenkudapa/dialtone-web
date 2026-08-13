import { describe, expect, it } from "vitest";
import { normalizePhoneToE164 } from "./phone";

describe("normalizePhoneToE164", () => {
  it("adds +1 to a bare 10-digit US number", () => {
    expect(normalizePhoneToE164("5105550199")).toBe("+15105550199");
  });

  it("strips formatting from a typed US number", () => {
    expect(normalizePhoneToE164("(510) 555-0199")).toBe("+15105550199");
    expect(normalizePhoneToE164("510.555.0199")).toBe("+15105550199");
    expect(normalizePhoneToE164(" 510 555 0199 ")).toBe("+15105550199");
  });

  it("accepts a leading 1 without a +", () => {
    expect(normalizePhoneToE164("15105550199")).toBe("+15105550199");
  });

  it("trusts and cleans a number that already carries a country code", () => {
    expect(normalizePhoneToE164("+15105550199")).toBe("+15105550199");
    expect(normalizePhoneToE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("refuses anything that isn't a plausible phone number", () => {
    expect(normalizePhoneToE164("")).toBeNull();
    expect(normalizePhoneToE164("12345")).toBeNull();
    expect(normalizePhoneToE164("not a number")).toBeNull();
    expect(normalizePhoneToE164("+1")).toBeNull();
  });
});
