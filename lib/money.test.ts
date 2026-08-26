import { describe, expect, it } from "vitest";
import {
  formatBasisPointsAsPercent,
  parseDollarsToCents,
  parsePercentToBasisPoints,
} from "./money";

describe("parseDollarsToCents", () => {
  it("parses whole dollars", () => {
    expect(parseDollarsToCents("12")).toBe(1200);
    expect(parseDollarsToCents("0")).toBe(0);
  });

  it("parses cents exactly, with no float error", () => {
    // 19.99 * 100 is 1998.9999999999998 in plain float arithmetic --
    // this must still land on exactly 1999.
    expect(parseDollarsToCents("19.99")).toBe(1999);
    expect(parseDollarsToCents("0.10")).toBe(10);
    expect(parseDollarsToCents("0.01")).toBe(1);
  });

  it("pads a single decimal digit", () => {
    expect(parseDollarsToCents("12.5")).toBe(1250);
  });

  it("tolerates surrounding whitespace and a leading zero", () => {
    expect(parseDollarsToCents(" 12.30 ")).toBe(1230);
    expect(parseDollarsToCents("012.30")).toBe(1230);
  });

  it("refuses more precision than a cent", () => {
    expect(parseDollarsToCents("12.505")).toBeNull();
  });

  it("refuses anything that is not a plain non-negative amount", () => {
    expect(parseDollarsToCents("-5")).toBeNull();
    expect(parseDollarsToCents("")).toBeNull();
    expect(parseDollarsToCents("abc")).toBeNull();
    expect(parseDollarsToCents("$12.50")).toBeNull();
    expect(parseDollarsToCents("1,200")).toBeNull();
    expect(parseDollarsToCents("1e3")).toBeNull();
  });
});

describe("parsePercentToBasisPoints", () => {
  it("parses a whole-basis-point rate exactly", () => {
    expect(parsePercentToBasisPoints("8.75")).toBe(875);
    expect(parsePercentToBasisPoints("0")).toBe(0);
    expect(parsePercentToBasisPoints("20")).toBe(2000);
  });

  it("rounds a rate that does not land on a whole basis point", () => {
    // 6.625% * 100 = 662.5 bps -- half-away-from-zero rounds up.
    expect(parsePercentToBasisPoints("6.625")).toBe(663);
  });

  it("rounds down when the remainder is under half a basis point", () => {
    expect(parsePercentToBasisPoints("6.624")).toBe(662);
  });

  it("refuses a negative or malformed rate", () => {
    expect(parsePercentToBasisPoints("-1")).toBeNull();
    expect(parsePercentToBasisPoints("")).toBeNull();
    expect(parsePercentToBasisPoints("abc")).toBeNull();
  });
});

describe("formatBasisPointsAsPercent", () => {
  it("reads basis points back as the percentage they represent", () => {
    expect(formatBasisPointsAsPercent(663)).toBe("6.63%");
    expect(formatBasisPointsAsPercent(875)).toBe("8.75%");
    expect(formatBasisPointsAsPercent(0)).toBe("0.00%");
  });
});
