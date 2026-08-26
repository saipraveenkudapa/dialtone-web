import { describe, expect, it } from "vitest";
import {
  OWNER_PASSWORD_ALPHABET,
  OWNER_PASSWORD_LENGTH,
  generateOwnerPassword,
} from "./password";

describe("generateOwnerPassword", () => {
  it("draws only from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      for (const char of generateOwnerPassword().replaceAll("-", "")) {
        expect(OWNER_PASSWORD_ALPHABET).toContain(char);
      }
    }
  });

  it("has no character an operator could misread as another one", () => {
    // The whole point of the alphabet. This password gets copied out of a
    // browser, pasted into a message, and sometimes read down a phone.
    for (const confusable of ["0", "O", "1", "l", "I", "5", "S", "2", "Z", "8", "B"]) {
      expect(OWNER_PASSWORD_ALPHABET).not.toContain(confusable);
    }
  });

  it("carries the full random length regardless of the readability hyphens", () => {
    const password = generateOwnerPassword();
    expect(password.replaceAll("-", "")).toHaveLength(OWNER_PASSWORD_LENGTH);
    expect(password).toMatch(/^[^-]+(-[^-]+)+$/);
  });

  it("is long enough that it never needs rotating", () => {
    // Nothing in this product will remind anyone to rotate it, so the
    // entropy has to carry the whole burden. 20 chars from a 50-symbol
    // alphabet is ~112 bits.
    const bits = OWNER_PASSWORD_LENGTH * Math.log2(OWNER_PASSWORD_ALPHABET.length);
    expect(bits).toBeGreaterThan(100);
  });

  it("never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generateOwnerPassword());
    expect(seen.size).toBe(500);
  });

  it("does not lean on the front of the alphabet", () => {
    // randomBytes[i] % 50 would skew toward the first 6 symbols, because
    // 256 is not a multiple of 50. crypto.randomInt rejects and re-draws,
    // so every symbol should turn up across a large enough sample.
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      for (const char of generateOwnerPassword().replaceAll("-", "")) seen.add(char);
    }
    expect(seen.size).toBe(OWNER_PASSWORD_ALPHABET.length);
  });
});
