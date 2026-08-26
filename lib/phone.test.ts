import { describe, expect, it } from "vitest";
import { dialableNumber, normalizePhoneToE164 } from "./phone";

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

/* The question four call sites were asking wrong: not "is the column
   set" but "is what the column holds the string that will be dialled".
   Nothing between `locations.fallback_human_number` and the PSTN
   re-formats it -- TwiML dials it verbatim, the transfer tool hands it
   to Vapi verbatim, and the assistant payload bakes it in -- so the two
   questions have different answers for exactly the rows an operator
   reaches for in an emergency. */
describe("dialableNumber", () => {
  it("passes a number already stored in the shape that will be dialled", () => {
    expect(dialableNumber("+15105550199")).toBe("+15105550199");
    expect(dialableNumber("+442079460958")).toBe("+442079460958");
  });

  it("refuses nothing at all, the way a null check already did", () => {
    expect(dialableNumber(null)).toBeNull();
    expect(dialableNumber(undefined)).toBeNull();
    expect(dialableNumber("")).toBeNull();
  });

  it("refuses a value that is set but is not a phone number", () => {
    // The legacy row this whole rule exists for: "12" clears a
    // truthiness test and then drops a caller asking about an allergy.
    expect(dialableNumber("12")).toBeNull();
    expect(dialableNumber("not a number")).toBeNull();
  });

  it("refuses a real number stored in a shape nothing here dials", () => {
    // EQUALITY, NOT NORMALIZABILITY. "(510) 555-0199" is a perfectly
    // good number and normalizePhoneToE164 is happy to read it -- but
    // it is not the string Twilio and Vapi are handed, and they refuse
    // that string with "must be a valid phone number in the E.164
    // format". A row written before setFallbackNumber normalized on the
    // way in holds exactly this.
    expect(normalizePhoneToE164("(510) 555-0199")).toBe("+15105550199");
    expect(dialableNumber("(510) 555-0199")).toBeNull();
    expect(dialableNumber("5105550199")).toBeNull();
    expect(dialableNumber(" +15105550199 ")).toBeNull();
  });

  it("never repairs -- it answers yes or no and returns the stored string", () => {
    // Returning the normalized form here would make the number dialled
    // and the number on file two different things, silently, which is
    // the drift the go-live checklist exists to put in front of a human.
    expect(dialableNumber("(510) 555-0199")).not.toBe("+15105550199");
  });
});
