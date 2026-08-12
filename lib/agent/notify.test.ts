import { describe, expect, it } from "vitest";
import { orderMessage } from "./notify";

describe("order message", () => {
  const message = orderMessage({
    orderNumber: 1043,
    type: "pickup",
    customerName: "Dana",
    customerPhone: "+15105550119",
    lines: [
      { quantity: 2, name: "Bucatini Amatriciana" },
      { quantity: 1, name: "Lasagne Verdi" },
    ],
    totalCents: 8048,
    promisedMinutes: 25,
  });

  it("leads with the order number and type", () => {
    expect(message.startsWith("#1043 PICKUP")).toBe(true);
  });

  it("lists each line with its quantity", () => {
    expect(message).toContain("2x Bucatini Amatriciana");
    expect(message).toContain("1x Lasagne Verdi");
  });

  it("shows the total in dollars", () => {
    expect(message).toContain("$80.48");
  });

  it("carries the callback number and the promise", () => {
    expect(message).toContain("+15105550119");
    expect(message).toContain("25 min");
  });

  it("never contains anything that looks like a card number", () => {
    expect(message).not.toMatch(/\b\d{13,19}\b/);
  });
});
