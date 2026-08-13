import { afterEach, describe, expect, it, vi } from "vitest";
import { orderMessage, sendOrderSms } from "./notify";
import type { LocationRow } from "@/lib/supabase/types";

/** A run of 13-19 digits, allowing the spaces or dashes a human actually
 *  types (or a transcript actually contains) between groups --
 *  `4111 1111 1111 1111` and `4111-1111-1111-1111` are both card numbers
 *  even though neither is an unbroken run of digits. `\b\d{13,19}\b` alone
 *  misses both. */
const CARD_NUMBER_PATTERN = /\b(?:\d[ -]?){13,19}\b/;

const baseOrder = {
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
};

describe("order message", () => {
  const message = orderMessage(baseOrder);

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
    expect(message).not.toMatch(CARD_NUMBER_PATTERN);
  });

  // The ticket said `1x Margherita` while the caller had heard "got it,
  // no onions" confirmed back a minute earlier -- the change was
  // confirmed aloud and then discarded, so the kitchen cooked the wrong
  // food on every modified order.
  it("prints the change the caller asked for under the item it belongs to", () => {
    const withNote = orderMessage({
      ...baseOrder,
      lines: [
        { quantity: 1, name: "Margherita", note: "no onions" },
        { quantity: 1, name: "Lasagne Verdi" },
      ],
    });
    expect(withNote).toContain("1x Margherita\n  * no onions");
    // The unmodified line stays a single line -- no empty marker under
    // every item on a ticket read at a pass during service.
    expect(withNote).toContain("1x Lasagne Verdi\nTotal");
  });

  it("treats a blank change as no change", () => {
    const blank = orderMessage({
      ...baseOrder,
      lines: [{ quantity: 1, name: "Margherita", note: "   " }],
    });
    expect(blank).toContain("1x Margherita\nTotal");
    expect(blank).not.toContain("*");
  });

  // A caller who reads out a card number thinking they're giving their
  // name or address has it land, verbatim, in a free-text field that ends
  // up in this message. The guard above is only worth anything if it
  // would actually catch that -- these prove it does for the formats a
  // person (or a transcript of one) would plausibly produce, not just an
  // unbroken run of digits.
  it("the card-number guard catches a spaced card number in a free-text field", () => {
    const withSpaces = orderMessage({ ...baseOrder, customerName: "4111 1111 1111 1111" });
    expect(withSpaces).toMatch(CARD_NUMBER_PATTERN);
  });

  it("the card-number guard catches a dashed card number in a free-text field", () => {
    const withDashes = orderMessage({ ...baseOrder, customerName: "4111-1111-1111-1111" });
    expect(withDashes).toMatch(CARD_NUMBER_PATTERN);
  });

  it("the card-number guard still catches an unbroken run of digits", () => {
    const unbroken = orderMessage({ ...baseOrder, customerName: "4111111111111111" });
    expect(unbroken).toMatch(CARD_NUMBER_PATTERN);
  });
});

/** A delivery ticket used to reach the pass with a customer, a total and
 *  a 25-minute promise, and nowhere to take the food. */
describe("the delivery address on the ticket", () => {
  const deliveryOrder = {
    ...baseOrder,
    type: "delivery",
    address: "1412 Telegraph Ave, Apt 3, Oakland, CA 94612",
  };

  it("carries the address on a delivery ticket", () => {
    expect(orderMessage(deliveryOrder)).toContain("1412 Telegraph Ave, Apt 3, Oakland, CA 94612");
  });

  it("puts the address last, where it can be copied straight into a map", () => {
    const lines = orderMessage(deliveryOrder).split("\n");
    expect(lines[lines.length - 1]).toBe("1412 Telegraph Ave, Apt 3, Oakland, CA 94612");
  });

  it("still leads with the order number and type, and still shows the total", () => {
    const message = orderMessage(deliveryOrder);
    expect(message.startsWith("#1043 DELIVERY")).toBe(true);
    expect(message).toContain("$80.48");
    expect(message).toContain("2x Bucatini Amatriciana");
  });

  // A pickup order has no address to show. Printing one anyway is how a
  // driver gets dispatched to a meal nobody ordered delivered -- so an
  // address supplied on a pickup order is dropped, not shown.
  it("shows no address on a pickup ticket, even if one was supplied", () => {
    const message = orderMessage({ ...baseOrder, address: "1412 Telegraph Ave, Oakland, CA" });
    expect(message).not.toContain("Telegraph");
    expect(message.split("\n")).toHaveLength(5);
  });

  it("adds no empty line when a delivery order has no address to show", () => {
    expect(orderMessage({ ...baseOrder, type: "delivery" }).endsWith("\n")).toBe(false);
    expect(orderMessage({ ...baseOrder, type: "delivery", address: "   " }).split("\n")).toHaveLength(5);
    expect(orderMessage({ ...baseOrder, type: "delivery", address: null }).split("\n")).toHaveLength(5);
  });

  // The address is a free-text field a caller speaks, which makes it one
  // more place a misheard card number can land verbatim -- and the only
  // new one this change introduces. A real address must not trip the
  // guard, and a card number in that field must.
  it("a real address does not look like a card number", () => {
    expect(orderMessage(deliveryOrder)).not.toMatch(CARD_NUMBER_PATTERN);
  });

  it("the card-number guard reaches the address field too", () => {
    const leaked = orderMessage({ ...deliveryOrder, address: "4111 1111 1111 1111" });
    expect(leaked).toMatch(CARD_NUMBER_PATTERN);
  });
});

/** Every field `sendOrderSms` doesn't look at, filled with plausible
 *  values, so each test only has to override what it's actually about. */
function testLocation(overrides: Partial<LocationRow> = {}): LocationRow {
  return {
    id: "loc-1",
    org_id: "org-1",
    name: "Trattoria Test",
    timezone: "America/Los_Angeles",
    address: "123 Test St",
    business_phone: "+15105550100",
    twilio_number: "+15105550101",
    fallback_human_number: null,
    greeting_text: "Thanks for calling.",
    greeting_audio_path: null,
    recording_enabled: false,
    recording_retention_days: 30,
    is_live: true,
    kill_switch_on: false,
    order_delivery: "sms",
    order_sms_to: "+15105550199",
    order_email_to: null,
    carrier_name: null,
    forwarding_verified_at: null,
    agent_secret_hash: null,
    tax_rate_bps: 875,
    seats: 20,
    reservation_slot_minutes: 30,
    max_party_size: 8,
    order_types: "both",
    pickup_promise_minutes: 25,
    delivery_promise_minutes: 45,
    onboarding_step: "menu",
    vapi_assistant_id: null,
    ...overrides,
  };
}

describe("sending the order ticket", () => {
  const originalFetch = globalThis.fetch;
  const originalSid = process.env.TWILIO_ACCOUNT_SID;
  const originalToken = process.env.TWILIO_AUTH_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.TWILIO_ACCOUNT_SID = originalSid;
    process.env.TWILIO_AUTH_TOKEN = originalToken;
  });

  it("posts to Twilio's Messages endpoint, addressed to the restaurant's own staff line", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC-test-sid";
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(new Response("", { status: 201 }));
    globalThis.fetch = fetchMock;

    const location = testLocation();
    const ok = await sendOrderSms(location, "ticket body");

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC-test-sid/Messages.json");

    const body = new URLSearchParams((init as RequestInit).body as string);
    // The restaurant's own configured staff number is the destination and
    // the restaurant's own Twilio number is the sender -- there is no
    // field here a customer's phone number could ever occupy. This
    // function has exactly one send target, and it is not the caller.
    expect(body.get("To")).toBe(location.order_sms_to);
    expect(body.get("From")).toBe(location.twilio_number);
    expect(body.get("To")).not.toBe(baseOrder.customerPhone);
    expect(body.get("Body")).toBe("ticket body");
  });

  it("returns false, without throwing, on a non-2xx response", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC-test-sid";
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    globalThis.fetch = vi.fn(
      async () => new Response("bad request", { status: 400 }),
    ) as unknown as typeof fetch;

    expect(await sendOrderSms(testLocation(), "ticket body")).toBe(false);
  });

  // This is the critical path: the order is already committed by the time
  // this runs, so a network-level failure (DNS, connection reset, timeout)
  // must resolve to `false`, not reject. An uncaught rejection here would
  // surface as a 500 on the orders route and tell a caller their order
  // failed when it is already on its way to the kitchen.
  it("returns false, without throwing, when fetch itself rejects", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC-test-sid";
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(sendOrderSms(testLocation(), "ticket body")).resolves.toBe(false);
  });

  it("returns false without making a network call when the location has no staff number", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC-test-sid";
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const location = testLocation({ order_sms_to: null });
    const ok = await sendOrderSms(location, "ticket body");

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false, without throwing, when response.text() rejects after a non-2xx status", async () => {
    process.env.TWILIO_ACCOUNT_SID = "AC-test-sid";
    process.env.TWILIO_AUTH_TOKEN = "test-token";
    const mockResponse = new Response("bad request", { status: 400 });
    mockResponse.text = vi.fn(async () => {
      throw new TypeError("body stream error");
    });
    globalThis.fetch = vi.fn(async () => mockResponse) as unknown as typeof fetch;

    await expect(sendOrderSms(testLocation(), "ticket body")).resolves.toBe(false);
  });
});
