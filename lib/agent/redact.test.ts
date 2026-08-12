import { describe, expect, it } from "vitest";
import { redactCardNumbers } from "./redact";

describe("redacting card numbers", () => {
  it("redacts an unbroken 16-digit run", () => {
    expect(redactCardNumbers("card is 4111111111111111 thanks")).toBe(
      "card is [redacted] thanks",
    );
  });

  it("redacts a space-separated 16-digit run", () => {
    expect(redactCardNumbers("card is 4111 1111 1111 1111 thanks")).toBe(
      "card is [redacted] thanks",
    );
  });

  it("redacts a dash-separated 16-digit run", () => {
    expect(redactCardNumbers("card is 4111-1111-1111-1111 thanks")).toBe(
      "card is [redacted] thanks",
    );
  });

  it("redacts a comma-separated 16-digit run -- how people group digits in writing", () => {
    expect(redactCardNumbers("card is 4111, 1111, 1111, 1111 thanks")).toBe(
      "card is [redacted] thanks",
    );
  });

  it("redacts a double-space-separated 16-digit run -- a routine speech-to-text artifact", () => {
    expect(redactCardNumbers("card is 4111  1111  1111  1111 thanks")).toBe(
      "card is [redacted] thanks",
    );
  });

  it("redacts the shortest real card length, 13 unbroken digits", () => {
    expect(redactCardNumbers("4111111111111")).toBe("[redacted]");
  });

  it("redacts the longest real card length, 19 unbroken digits", () => {
    expect(redactCardNumbers("4111111111111111111")).toBe("[redacted]");
  });

  it("redacts a 15-digit Amex-style number", () => {
    expect(redactCardNumbers("amex 371449635398431 on file")).toBe("amex [redacted] on file");
  });

  it("redacts every card number when more than one appears", () => {
    expect(redactCardNumbers("first 4111111111111111 then 5500000000000004")).toBe(
      "first [redacted] then [redacted]",
    );
  });

  it("leaves a 12-digit run alone -- one short of a real card", () => {
    expect(redactCardNumbers("reference 411111111111 on file")).toBe(
      "reference 411111111111 on file",
    );
  });

  it("leaves a 20-digit unbroken run alone -- one over the ceiling, not a card shape", () => {
    const text = "id 41111111111111111119 here";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("leaves plain text with no digits alone", () => {
    const text = "caller mentioned a shellfish allergy and wants a manager";
    expect(redactCardNumbers(text)).toBe(text);
  });

  // The digits themselves are not the constant across formats -- what
  // matters is that these are all realistic ways a person, or a
  // transcript of one, would render one card number, and every one of
  // them must come out scrubbed.
  it("catches a card number woven into a full transfer reason", () => {
    const reason = "caller read out their card number 4111 1111 1111 1111 while asking for a refund";
    expect(redactCardNumbers(reason)).toBe(
      "caller read out their card number [redacted] while asking for a refund",
    );
  });

  // --- near misses: fields that legitimately carry long-ish digit runs ---

  it("spares a US phone number, dashed", () => {
    const text = "call me back at 510-555-0119";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares a US phone number with country code", () => {
    const text = "reach them at +1 510-555-0119";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares an unbroken 11-digit phone number with a leading plus and country code", () => {
    const text = "callback is +15105550119";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares an unbroken 11-digit phone number with country code", () => {
    const text = "callback is 15105550119";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares a parenthesized US phone number", () => {
    const text = "reach them at (510) 555-0119";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares an order number", () => {
    const text = "still waiting on order #4829";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares another order number", () => {
    const text = "checking on the status of #1043";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares a dollar amount with a comma and decimal point", () => {
    const text = "disputes a charge of $1,234.56 on the bill";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares a plain dollar amount", () => {
    const text = "wants a refund for the $45.67 order";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares a small plain dollar amount", () => {
    const text = "the total came to $80.48 with tax";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares a duration", () => {
    const text = "quoted a wait of 25 min for the table";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares a date -- dash-separated but nowhere near 13 digits", () => {
    const text = "reservation moved to 2026-08-12";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares a realistic order ticket line", () => {
    const text = "2x Bucatini Amatriciana";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares a time with a colon", () => {
    const text = "asked to move the reservation to 7:15pm";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares a 24-hour time", () => {
    const text = "wants pickup pushed to 19:30";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("spares a party size and a phone number in the same sentence", () => {
    const text = "party of 12, phone 510-555-0119, upset about the wait";
    expect(redactCardNumbers(text)).toBe(text);
  });

  it("redacts a card number but spares the phone number and order number beside it", () => {
    const reason =
      "card 4111 1111 1111 1111 declined, callback 510-555-0119, order #4829";
    expect(redactCardNumbers(reason)).toBe(
      "card [redacted] declined, callback 510-555-0119, order #4829",
    );
  });
});
