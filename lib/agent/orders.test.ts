import { describe, expect, it } from "vitest";
import {
  buildOrderLines,
  isRequestedItem,
  matchesSpokenName,
  matchItem,
  normaliseOrderType,
  normaliseItemNote,
  normaliseQuantity,
  priceOrder,
  MAX_ITEM_NOTE_LENGTH,
  MAX_ITEM_QUANTITY,
  MAX_ORDER_LINES,
  type PricedItem,
} from "./orders";

const items: PricedItem[] = [
  { id: "i1", name: "Bucatini Amatriciana", price_cents: 2400, sold_out_until: null },
  { id: "i2", name: "Lasagne Verdi", price_cents: 2600, sold_out_until: null },
  { id: "i3", name: "Squid Ink Tonnarelli", price_cents: 2900, sold_out_until: "close" },
];

/** The burger shop this whole distinction came from: "fries" is what a
 *  caller says on most calls, and it is two items. */
const friesMenu: PricedItem[] = [
  { id: "f1", name: "Hand Cut Fries", price_cents: 500, sold_out_until: null },
  { id: "f2", name: "Cheese Fries", price_cents: 700, sold_out_until: null },
  { id: "f3", name: "Double Cheeseburger", price_cents: 1300, sold_out_until: null },
];

/** The id of the item a match resolved to. Asserting through this rather
 *  than on the whole union keeps a test that is about *which item*
 *  readable; the tests that are about *which outcome* assert on the whole
 *  value, because that is exactly what they are pinning down. */
const matchedId = (menu: PricedItem[], spoken: string) => {
  const result = matchItem(menu, spoken);
  return result.ok ? result.item.id : null;
};

describe("matching spoken item names", () => {
  it("matches exactly, ignoring case and spacing", () => {
    expect(matchedId(items, "  lasagne verdi ")).toBe("i2");
  });

  it("matches a partial name the way a caller would say it", () => {
    expect(matchedId(items, "bucatini")).toBe("i1");
  });

  it("reports ambiguity, with both candidates, rather than guessing between two matches", () => {
    const ambiguous: PricedItem[] = [
      { id: "a", name: "Cheese Pizza", price_cents: 1200, sold_out_until: null },
      { id: "b", name: "Cheese Bread", price_cents: 800, sold_out_until: null },
    ];
    expect(matchItem(ambiguous, "cheese")).toEqual({
      ok: false,
      reason: "ambiguous_item",
      candidates: ambiguous,
    });
  });

  it("reports unknown, not ambiguity, for something not on the menu", () => {
    expect(matchItem(items, "chicken tikka")).toEqual({ ok: false, reason: "unknown_item" });
  });

  it("matches a word prefix the way a caller would shorten a name", () => {
    const menu: PricedItem[] = [
      { id: "m1", name: "Margherita", price_cents: 1800, sold_out_until: null },
    ];
    expect(matchedId(menu, "marg")).toBe("m1");
  });

  it("does not match a needle that only appears mid-word (cola vs chocolate)", () => {
    const menu: PricedItem[] = [
      { id: "c1", name: "Chocolate Cake", price_cents: 900, sold_out_until: null },
    ];
    expect(matchItem(menu, "cola")).toEqual({ ok: false, reason: "unknown_item" });
  });

  it("does not match a needle that only appears mid-word (apple vs pineapple)", () => {
    const menu: PricedItem[] = [
      { id: "c2", name: "Pineapple Upside-Down Cake", price_cents: 950, sold_out_until: null },
    ];
    expect(matchItem(menu, "apple")).toEqual({ ok: false, reason: "unknown_item" });
  });

  it("does not match a needle that only appears mid-word (melon vs watermelon)", () => {
    const menu: PricedItem[] = [
      { id: "c3", name: "Watermelon Salad", price_cents: 700, sold_out_until: null },
    ];
    expect(matchItem(menu, "melon")).toEqual({ ok: false, reason: "unknown_item" });
  });

  it("still refuses to guess when a word-prefix match is ambiguous, and says which two", () => {
    const ambiguous: PricedItem[] = [
      { id: "p1", name: "Margherita Pizza", price_cents: 1400, sold_out_until: null },
      { id: "p2", name: "Marganza Sandwich", price_cents: 1100, sold_out_until: null },
    ];
    expect(matchItem(ambiguous, "marg")).toEqual({
      ok: false,
      reason: "ambiguous_item",
      candidates: ambiguous,
    });
  });

  it("does not let a short word prefix-match into a longer unrelated word (ham vs hamburger)", () => {
    const menu: PricedItem[] = [
      { id: "h1", name: "Hamburger", price_cents: 1000, sold_out_until: null },
    ];
    expect(matchItem(menu, "ham")).toEqual({ ok: false, reason: "unknown_item" });
  });

  it("does not let a short word prefix-match into a longer unrelated word (pie vs pierogi)", () => {
    const menu: PricedItem[] = [
      { id: "pr1", name: "Pierogi", price_cents: 1100, sold_out_until: null },
    ];
    expect(matchItem(menu, "pie")).toEqual({ ok: false, reason: "unknown_item" });
  });

  it("still matches a short word exactly against an item actually named that word", () => {
    const menu: PricedItem[] = [
      { id: "hc1", name: "Ham & Cheese", price_cents: 900, sold_out_until: null },
    ];
    expect(matchedId(menu, "ham")).toBe("hc1");
  });

  it("still allows a longer word to prefix-match (marg for Margherita)", () => {
    const menu: PricedItem[] = [
      { id: "m2", name: "Margherita", price_cents: 1800, sold_out_until: null },
    ];
    expect(matchedId(menu, "marg")).toBe("m2");
  });
});

/** The failure that put this distinction in: at a burger restaurant,
 *  ordering "fries" matched Hand Cut Fries and Cheese Fries, came back as
 *  `unknown_item`, and the agent apologised for not selling fries and
 *  handed the call over -- on most calls. */
describe("telling 'which one did you mean' apart from 'we don't have that'", () => {
  it("answers 'fries' with ambiguity and BOTH candidates, not with unknown", () => {
    const result = matchItem(friesMenu, "fries");
    expect(result).toEqual({
      ok: false,
      reason: "ambiguous_item",
      candidates: [friesMenu[0], friesMenu[1]],
    });
    // The names are the point: without them the agent cannot ask "hand
    // cut or cheese fries?", which is the entire fix.
    if (result.ok || result.reason !== "ambiguous_item") throw new Error("expected ambiguity");
    expect(result.candidates.map((c) => c.name)).toEqual(["Hand Cut Fries", "Cheese Fries"]);
  });

  it("still answers a genuinely unknown item with unknown, not ambiguity", () => {
    expect(matchItem(friesMenu, "onion rings")).toEqual({ ok: false, reason: "unknown_item" });
  });

  it("lets an exact full name win over the partial match it collides with", () => {
    // An exact whole-name hit is an order, never a question, even
    // though the word "fries" on its own is ambiguous on this menu.
    expect(matchedId(friesMenu, "Cheese Fries")).toBe("f2");
    expect(matchedId(friesMenu, "  hand cut fries ")).toBe("f1");
  });

  it("still resolves a single partial match without asking anything", () => {
    expect(matchedId(friesMenu, "double")).toBe("f3");
    expect(matchedId(friesMenu, "hand")).toBe("f1");
  });

  it("prefers an exact-name tie's own rows as the candidates", () => {
    // Two rows literally sharing a name is a menu-data fault, not a
    // spoken-word one -- still a tie, still asked about rather than
    // guessed at, and the candidates are the rows that were actually
    // named rather than everything the words could have reached.
    const duplicated: PricedItem[] = [
      { id: "d1", name: "Fries", price_cents: 400, sold_out_until: null },
      { id: "d2", name: "Fries", price_cents: 450, sold_out_until: null },
      { id: "d3", name: "Fries and Gravy", price_cents: 600, sold_out_until: null },
    ];
    expect(matchItem(duplicated, "fries")).toEqual({
      ok: false,
      reason: "ambiguous_item",
      candidates: [duplicated[0], duplicated[1]],
    });
  });

  it("treats a blank spoken name as unknown, never as every item at once", () => {
    expect(matchItem(friesMenu, "   ")).toEqual({ ok: false, reason: "unknown_item" });
  });
});

describe("pricing", () => {
  it("adds tax in integer cents", () => {
    const totals = priceOrder(
      [
        { item: items[0], quantity: 2 },
        { item: items[1], quantity: 1 },
      ],
      875,
    );
    expect(totals.subtotal_cents).toBe(7400);
    expect(totals.tax_cents).toBe(648); // 7400 * 0.0875 = 647.5, rounded
    expect(totals.total_cents).toBe(8048);
  });

  it("handles a zero tax rate", () => {
    const totals = priceOrder([{ item: items[1], quantity: 1 }], 0);
    expect(totals).toEqual({
      subtotal_cents: 2600,
      tax_cents: 0,
      total_cents: 2600,
    });
  });

  it("rounds down, not just up, when the tax has a fractional part below one half", () => {
    // 1000 * 433 / 10_000 = 43.3 cents -- Math.round and Math.ceil disagree
    // here (43 vs 44), unlike the exact-half-cent case above, so this
    // catches a mutation that always rounds up and would overcharge most
    // orders.
    const item: PricedItem = { id: "t1", name: "Test Item", price_cents: 1000, sold_out_until: null };
    const totals = priceOrder([{ item, quantity: 1 }], 433);
    expect(totals.tax_cents).toBe(43);
    expect(totals.total_cents).toBe(1043);
  });
});

describe("quantity validation", () => {
  it("rejects a zero quantity rather than silently zeroing out a line", () => {
    expect(() => priceOrder([{ item: items[0], quantity: 0 }], 0)).toThrow();
  });

  it("rejects a negative quantity rather than silently shrinking the subtotal", () => {
    expect(() => priceOrder([{ item: items[0], quantity: -1 }], 0)).toThrow();
  });

  it("rejects a fractional quantity rather than producing fractional cents", () => {
    expect(() => priceOrder([{ item: items[0], quantity: 1.5 }], 0)).toThrow();
  });

  it("still accepts an ordinary positive integer quantity", () => {
    expect(() => priceOrder([{ item: items[0], quantity: 3 }], 0)).not.toThrow();
  });
});

describe("normaliseQuantity", () => {
  it("accepts an ordinary positive integer count", () => {
    expect(normaliseQuantity(3)).toBe(3);
  });

  it("rejects zero rather than treating it as a sane count", () => {
    expect(normaliseQuantity(0)).toBeNull();
  });

  it("rejects a negative count", () => {
    expect(normaliseQuantity(-1)).toBeNull();
  });

  it("rejects a fractional count", () => {
    expect(normaliseQuantity(1.5)).toBeNull();
  });

  it("accepts a numeric string, the way a loosely-typed tool payload might send it", () => {
    expect(normaliseQuantity("4")).toBe(4);
  });

  it("rejects a value that is not a number at all", () => {
    expect(normaliseQuantity("two")).toBeNull();
    expect(normaliseQuantity(undefined)).toBeNull();
    expect(normaliseQuantity(null)).toBeNull();
    expect(normaliseQuantity({})).toBeNull();
  });
});

describe("buildOrderLines", () => {
  it("builds a priced line for each requested item, defaulting quantity to one", () => {
    const result = buildOrderLines(items, [{ name: "lasagne verdi" }, { name: "bucatini", quantity: 2 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.lines).toEqual([
      { item: items[1], quantity: 1, note: null },
      { item: items[0], quantity: 2, note: null },
    ]);
  });

  it("accepts a numeric-string quantity the way a loosely-typed payload might send it", () => {
    const result = buildOrderLines(items, [{ name: "bucatini", quantity: "3" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.lines).toEqual([{ item: items[0], quantity: 3, note: null }]);
  });

  it("carries a per-item change through onto the line it belongs to", () => {
    const result = buildOrderLines(items, [
      { name: "bucatini", quantity: 1, note: "  no  onions\nextra crispy " },
      { name: "lasagne verdi" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // Whitespace collapsed, and only the line the caller changed carries
    // it -- a note pooled onto the order (or onto every line) is a cook
    // guessing which plate it meant.
    expect(result.lines).toEqual([
      { item: items[0], quantity: 1, note: "no onions extra crispy" },
      { item: items[1], quantity: 1, note: null },
    ]);
  });

  it("reports bad_note rather than silently dropping a change it cannot use", () => {
    // Dropping it is the bug this field exists to fix: the caller hears
    // "got it, no onions" and the kitchen never sees it.
    expect(buildOrderLines(items, [{ name: "bucatini", note: 42 }])).toEqual({
      ok: false,
      reason: "bad_note",
      item: "Bucatini Amatriciana",
    });
    expect(
      buildOrderLines(items, [{ name: "bucatini", note: "x".repeat(MAX_ITEM_NOTE_LENGTH + 1) }]),
    ).toEqual({ ok: false, reason: "bad_note", item: "Bucatini Amatriciana" });
  });

  it("reports unknown_item for something not on the menu, rather than throwing", () => {
    const result = buildOrderLines(items, [{ name: "chicken tikka" }]);
    expect(result).toEqual({ ok: false, reason: "unknown_item", item: "chicken tikka" });
  });

  it("reports ambiguous_item, carrying every name it could have been, instead of unknown_item", () => {
    // The whole order used to be refused as unknown_item here, so the
    // agent said the restaurant has no fries and handed the call over.
    const result = buildOrderLines(friesMenu, [{ name: "fries", quantity: 2 }]);
    expect(result).toEqual({
      ok: false,
      reason: "ambiguous_item",
      // What the caller said -- there is no one menu name to give.
      item: "fries",
      options: ["Hand Cut Fries", "Cheese Fries"],
    });
  });

  it("keeps ambiguity distinct from unknown all the way out of buildOrderLines", () => {
    const ambiguous = buildOrderLines(friesMenu, [{ name: "fries" }]);
    const unknown = buildOrderLines(friesMenu, [{ name: "onion rings" }]);
    if (ambiguous.ok || unknown.ok) throw new Error("expected both to be refused");
    expect(ambiguous.reason).not.toBe(unknown.reason);
    expect(unknown).toEqual({ ok: false, reason: "unknown_item", item: "onion rings" });
  });

  it("takes an unambiguous line from the same menu without asking anything", () => {
    // The ambiguity answer must not become a new way to refuse orders
    // that were always fine.
    const result = buildOrderLines(friesMenu, [{ name: "cheese fries", quantity: 2 }]);
    expect(result).toEqual({
      ok: true,
      lines: [{ item: friesMenu[1], quantity: 2, note: null }],
    });
  });

  it("reports sold_out for an item flagged out, even though get_menu already said so once", () => {
    const result = buildOrderLines(items, [{ name: "squid ink tonnarelli" }]);
    expect(result).toEqual({ ok: false, reason: "sold_out", item: "Squid Ink Tonnarelli" });
  });

  it("reports bad_quantity for a quantity that cannot be understood, rather than crashing on NaN", () => {
    const result = buildOrderLines(items, [{ name: "bucatini", quantity: "two" }]);
    expect(result).toEqual({ ok: false, reason: "bad_quantity", item: "bucatini" });
  });

  it("reports bad_quantity for a zero or negative quantity", () => {
    expect(buildOrderLines(items, [{ name: "bucatini", quantity: 0 }])).toEqual({
      ok: false,
      reason: "bad_quantity",
      item: "bucatini",
    });
    expect(buildOrderLines(items, [{ name: "bucatini", quantity: -1 }])).toEqual({
      ok: false,
      reason: "bad_quantity",
      item: "bucatini",
    });
  });

  it("reports bad_quantity for a fractional quantity", () => {
    const result = buildOrderLines(items, [{ name: "bucatini", quantity: 1.5 }]);
    expect(result).toEqual({ ok: false, reason: "bad_quantity", item: "bucatini" });
  });

  it("stops at the first item that fails rather than checking the rest", () => {
    const result = buildOrderLines(items, [{ name: "chicken tikka" }, { name: "bucatini", quantity: "two" }]);
    expect(result).toEqual({ ok: false, reason: "unknown_item", item: "chicken tikka" });
  });

  it("hands priceOrder lines it will never throw on, because every quantity already passed normaliseQuantity", () => {
    const result = buildOrderLines(items, [{ name: "bucatini", quantity: 2 }, { name: "lasagne verdi" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // priceOrder's own guard throws on a bad quantity as a last resort;
    // this is the route's actual call path, and it must not throw here.
    expect(() => priceOrder(result.lines, 0)).not.toThrow();
  });
});

describe("reading the order type a caller asked for", () => {
  it("takes the two values the tool contract defines", () => {
    expect(normaliseOrderType("pickup")).toBe("pickup");
    expect(normaliseOrderType("delivery")).toBe("delivery");
  });

  // The bug this replaced: `body.type === "delivery" ? ... : "pickup"`
  // turned every one of these into a PICKUP order and dropped the
  // address with it, so a caller who asked for delivery was told to come
  // and collect.
  it("reads a capitalised or padded delivery as delivery, not as pickup", () => {
    expect(normaliseOrderType("Delivery")).toBe("delivery");
    expect(normaliseOrderType("DELIVERY")).toBe("delivery");
    expect(normaliseOrderType("  delivery  ")).toBe("delivery");
  });

  it("reads a capitalised or padded pickup as pickup", () => {
    expect(normaliseOrderType("Pickup")).toBe("pickup");
    expect(normaliseOrderType(" PICKUP ")).toBe("pickup");
  });

  it("defaults an absent type to pickup, the ordinary case", () => {
    expect(normaliseOrderType(undefined)).toBe("pickup");
    expect(normaliseOrderType(null)).toBe("pickup");
    expect(normaliseOrderType("   ")).toBe("pickup");
  });

  // Refusing and asking is one more question; guessing is a driver sent
  // to an address nobody gave, or a caller waiting at home for food
  // sitting on a pickup shelf.
  it("returns null for a value it cannot recognise rather than guessing pickup", () => {
    expect(normaliseOrderType("takeaway")).toBeNull();
    expect(normaliseOrderType("dine-in")).toBeNull();
    expect(normaliseOrderType("drop it off")).toBeNull();
    expect(normaliseOrderType("")).toBe("pickup");
  });

  it("returns null for a value that is not a string at all", () => {
    expect(normaliseOrderType(1)).toBeNull();
    expect(normaliseOrderType({ type: "delivery" })).toBeNull();
    expect(normaliseOrderType(["delivery"])).toBeNull();
  });
});

describe("the size of a phone order", () => {
  it("takes an order right up to the line limit", () => {
    const requested = Array.from({ length: MAX_ORDER_LINES }, () => ({ name: "bucatini" }));
    expect(buildOrderLines(items, requested).ok).toBe(true);
  });

  it("refuses one line past the limit, before touching any of them", () => {
    const requested = Array.from({ length: MAX_ORDER_LINES + 1 }, () => ({ name: "bucatini" }));
    expect(buildOrderLines(items, requested)).toEqual({
      ok: false,
      reason: "too_many_items",
      item: undefined,
    });
  });

  it("takes a quantity right up to the per-item limit", () => {
    const result = buildOrderLines(items, [{ name: "bucatini", quantity: MAX_ITEM_QUANTITY }]);
    expect(result.ok).toBe(true);
  });

  // A transcript reads "fifty thousand" when someone says "fifteen" down
  // a bad line. Unbounded, that priced and printed as a five-figure
  // ticket; now it is a sentence the agent can say.
  it("refuses one past the per-item limit, and names the item it refused", () => {
    const result = buildOrderLines(items, [{ name: "bucatini", quantity: MAX_ITEM_QUANTITY + 1 }]);
    expect(result).toEqual({
      ok: false,
      reason: "too_many_of_item",
      item: "Bucatini Amatriciana",
    });
  });

  it("refuses a wildly mis-heard quantity", () => {
    const result = buildOrderLines(items, [{ name: "lasagne verdi", quantity: 50000 }]);
    expect(result).toEqual({
      ok: false,
      reason: "too_many_of_item",
      item: "Lasagne Verdi",
    });
  });

  // The limits are duplicated in
  // supabase/migrations/20260812000400_place_order.sql (c_max_lines,
  // c_max_qty), which is the authority. If they drift, this route starts
  // asking the database for orders it will refuse -- so the values are
  // pinned here rather than left implicit.
  it("keeps the limits the database enforces", () => {
    expect(MAX_ORDER_LINES).toBe(40);
    expect(MAX_ITEM_QUANTITY).toBe(50);
  });
});

describe("normaliseItemNote", () => {
  it("keeps a spoken change as free text, whitespace collapsed", () => {
    expect(normaliseItemNote("no onions")).toEqual({ ok: true, note: "no onions" });
    // A newline would break the kitchen ticket's line-per-item layout
    // (lib/agent/notify.ts) into something a pass cannot read.
    expect(normaliseItemNote(" sauce on the side,\n  well done ")).toEqual({
      ok: true,
      note: "sauce on the side, well done",
    });
  });

  it("treats absent, null and blank as no change at all", () => {
    expect(normaliseItemNote(undefined)).toEqual({ ok: true, note: null });
    expect(normaliseItemNote(null)).toEqual({ ok: true, note: null });
    expect(normaliseItemNote("   ")).toEqual({ ok: true, note: null });
  });

  it("refuses a non-string instead of ignoring it", () => {
    // Ignoring is what this whole field exists to stop: a change the
    // caller heard confirmed back that the kitchen never saw.
    expect(normaliseItemNote(42)).toEqual({ ok: false });
    expect(normaliseItemNote({ note: "no onions" })).toEqual({ ok: false });
    expect(normaliseItemNote(["no onions"])).toEqual({ ok: false });
  });

  it("refuses a note longer than a spoken modification can plausibly be", () => {
    expect(normaliseItemNote("x".repeat(MAX_ITEM_NOTE_LENGTH))).toEqual({
      ok: true,
      note: "x".repeat(MAX_ITEM_NOTE_LENGTH),
    });
    expect(normaliseItemNote("x".repeat(MAX_ITEM_NOTE_LENGTH + 1))).toEqual({ ok: false });
  });

  it("redacts a card number a caller reads into the change field", () => {
    // This is a new free-text write path for words a caller actually
    // said, and it egresses further than any other one: a column, the
    // kitchen ticket, and out to Twilio in the SMS body.
    expect(normaliseItemNote("charge it to 4111 1111 1111 1111 please")).toEqual({
      ok: true,
      note: "charge it to [redacted] please",
    });
    expect(normaliseItemNote("4111111111111111")).toEqual({ ok: true, note: "[redacted]" });
  });

  it("leaves the length check to look at what will actually be stored", () => {
    // Redaction shortens the text, so a long card number does not push an
    // otherwise ordinary note over the limit.
    const long = `${"x".repeat(MAX_ITEM_NOTE_LENGTH - 20)} 4111 1111 1111 1111`;
    expect(normaliseItemNote(long)).toEqual({
      ok: true,
      note: `${"x".repeat(MAX_ITEM_NOTE_LENGTH - 20)} [redacted]`,
    });
  });
});

describe("matchesSpokenName", () => {
  // One matcher, shared with lib/agent/menu.ts's suggestAlternative --
  // "wings" has to mean the same thing to the thing that builds the order
  // line and the thing that offers an alternative when it is sold out.
  it("matches a spoken word against the item's words", () => {
    expect(matchesSpokenName("Buffalo Wings", "wings")).toBe(true);
    expect(matchesSpokenName("Boneless Wings", "wings")).toBe(true);
    expect(matchesSpokenName("Bucatini Amatriciana", "bucatini")).toBe(true);
    expect(matchesSpokenName("Margherita", "marg")).toBe(true);
  });

  it("does not match across word boundaries or on nothing at all", () => {
    expect(matchesSpokenName("Chocolate Cake", "cola")).toBe(false);
    expect(matchesSpokenName("Hamburger", "ham")).toBe(false);
    expect(matchesSpokenName("Buffalo Wings", "")).toBe(false);
    expect(matchesSpokenName("Buffalo Wings", "   ")).toBe(false);
  });
});

/** The runtime half of `RequestedItem`, which until now had none.
 *
 *  `app/api/agent/order/route.ts` reached `buildOrderLines` through
 *  `args.items as RequestedItem[]` -- a cast over a `JSON.parse` of a
 *  model-authored `arguments` string. The two shapes below used to reach
 *  the matcher and throw straight out of the handler, and Vapi ignores a
 *  non-200 completely, so a caller mid-order heard nothing at all. */
describe("isRequestedItem", () => {
  it("accepts what a place_order item is declared to be", () => {
    expect(isRequestedItem({ name: "bucatini" })).toBe(true);
    expect(isRequestedItem({ name: "bucatini", quantity: 2, note: "no chilli" })).toBe(true);
    // `name` absent is legitimate -- buildOrderLines already answers it
    // as unknown_item, in a sentence, without throwing.
    expect(isRequestedItem({})).toBe(true);
    expect(isRequestedItem({ quantity: 2 })).toBe(true);
    expect(isRequestedItem({ name: "" })).toBe(true);
  });

  it("rejects the two shapes that threw out of the order route", () => {
    // "Cannot read properties of null (reading 'name')" in
    // buildOrderLines.
    expect(isRequestedItem(null)).toBe(false);
    // "value.trim is not a function" in matchItem's `normalise`.
    expect(isRequestedItem({ name: 7 })).toBe(false);
  });

  it("rejects the shapes that did not throw but were never an item either", () => {
    // These degraded quietly into "we don't sell that" -- property
    // access on a string or a number just yields undefined -- which is
    // why nothing ever looked wrong.
    expect(isRequestedItem("wings")).toBe(false);
    expect(isRequestedItem(42)).toBe(false);
    expect(isRequestedItem(true)).toBe(false);
    expect(isRequestedItem(undefined)).toBe(false);
    expect(isRequestedItem(["bucatini"])).toBe(false);
    expect(isRequestedItem([])).toBe(false);
    expect(isRequestedItem({ name: { first: "bucatini" } })).toBe(false);
    expect(isRequestedItem({ name: null })).toBe(false);
    expect(isRequestedItem({ name: ["bucatini"] })).toBe(false);
  });

  it("leaves quantity and note alone -- each already has a guard with a better sentence", () => {
    // normaliseQuantity/normaliseItemNote take `unknown` and refuse in a
    // way that names the item; this predicate could only say "I didn't
    // catch what you'd like to order" about the whole basket.
    expect(isRequestedItem({ name: "bucatini", quantity: "two" })).toBe(true);
    expect(isRequestedItem({ name: "bucatini", note: 42 })).toBe(true);
  });

  it("narrows an array so buildOrderLines needs no cast to be called", () => {
    const raw: unknown[] = [{ name: "bucatini", quantity: 2 }, { name: "lasagne verdi" }];
    // The `.every` narrowing is what lets `as RequestedItem[]` go away in
    // the route -- assert that the value it produces is actually usable.
    expect(raw.every(isRequestedItem)).toBe(true);
    if (raw.every(isRequestedItem)) {
      expect(buildOrderLines(items, raw).ok).toBe(true);
    }
  });
});
