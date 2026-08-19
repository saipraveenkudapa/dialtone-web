import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoardOrder } from "@/lib/data";
import { ORDER_MOVES } from "@/lib/orders/moves";

/** What a restaurant actually reads on /dashboard/orders.
 *
 *  This screen was a stub -- "Not built yet" -- while real orders were
 *  landing in the database behind it. A caller ordered $27.00 of food on
 *  the phone, the agent took it, the row was written, and the people who
 *  had to cook it were shown a sentence about a design file. So the
 *  assertions here are deliberately about the WORDS on the screen and
 *  not about the shape of the component: what a cook can read is the
 *  entire product at this point.
 *
 *  Under lib/ because vitest.config.ts's node project takes
 *  lib/**\/*.test.ts, beside lib/calls/'s tests of the call screens.
 *  The page is an async server component with no event handlers, so
 *  awaiting it and putting the result through renderToStaticMarkup is
 *  the whole of what it does.
 */

/* next/link mounts against the App Router's context, which nothing here
   is inside. The page uses it for one thing -- a link back to the call
   the order was taken on -- so an anchor is a faithful stand-in and the
   assertions stay about what a reader reads. */
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children),
}));

const getCurrentLocation = vi.fn();
const getOrdersBoard = vi.fn();

vi.mock("@/lib/data", () => ({
  getCurrentLocation,
  getOrdersBoard,
  ORDERS_ON_THE_BOARD: 50,
}));

/* The ticket control's writer. Mocked for the same reason "@/lib/data" is
   -- it reaches next/headers through the signed-in user's Supabase client,
   and this file is asking what the page RENDERS. What the control does
   when it is pressed is components/OrderMoves.test.tsx, under jsdom,
   where a press is a real click. */
vi.mock("@/app/dashboard/orders/actions", () => ({ moveOrder: vi.fn() }));

const OrdersPage = (await import("@/app/dashboard/orders/page")).default;

/** New York, on purpose: the fixtures below are timestamped just after
 *  midnight UTC, so every rendered time is on the DAY BEFORE the one the
 *  raw column holds. A screen that rendered UTC -- or the machine's own
 *  clock, which under vitest is UTC -- would print a different date, not
 *  merely a different hour. */
const TZ = "America/New_York";

const PLACED = "2026-08-18T01:12:00.000Z"; // Aug 17, 9:12 PM in New York
const PROMISED = "2026-08-18T01:37:00.000Z"; // Aug 17, 9:37 PM in New York
const NOW = Date.parse("2026-08-18T01:18:00.000Z"); // six minutes later

function location(over: Record<string, unknown> = {}) {
  return {
    id: "loc-nonna",
    name: "Nonna Rosa",
    timezone: TZ,
    is_live: true,
    kill_switch_on: false,
    ...over,
  };
}

/** The order the product owner reported: #1001, Phi, $27.00, two lines,
 *  linked to its call -- with the note the caller said out loud. */
function order(over: Partial<BoardOrder> = {}): BoardOrder {
  return {
    id: "ord-1001",
    orderNumber: 1001,
    callId: "8f0f8c6e-0000-4000-8000-000000000000",
    customerName: "Phi",
    customerPhone: "(510) 555-0143",
    type: "pickup",
    status: "new",
    totalCents: 2700,
    placedAt: PLACED,
    promisedAt: PROMISED,
    address: null,
    lines: [
      { id: "l1", name: "Margherita", quantity: 1, totalCents: 1800, note: "no onions" },
      { id: "l2", name: "Garlic bread", quantity: 2, totalCents: 900, note: null },
    ],
    ...over,
  };
}

/** Tags dropped, entities put back, whitespace collapsed -- so the
 *  assertions are about what a reader reads. Same helper, same reason,
 *  as lib/calls/call-facts.test.ts. */
function prose(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&middot;/g, "·")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

async function markup(): Promise<string> {
  return renderToStaticMarkup(await OrdersPage());
}

async function said(): Promise<string> {
  return prose(await markup());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  getCurrentLocation.mockResolvedValue(location());
  getOrdersBoard.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a restaurant that has taken no orders yet", () => {
  it("is told what will appear here and when, not that the screen is unfinished", async () => {
    const screen = await said();

    expect(screen).toContain("No orders yet");
    // The whole point of the sentence: it says what lands here and what
    // puts it there.
    expect(screen).toContain("the agent takes");
    expect(screen).not.toContain("Not built yet");
    expect(screen).not.toContain("design/Dialtone.html");
    // The board's per-column note is for a column that is empty while
    // others are not. It is the wrong sentence for a restaurant that has
    // never taken an order at all.
    expect(screen).not.toContain("Quiet for the moment");
  });

  it("says why there can be none while the agent is not answering", async () => {
    getCurrentLocation.mockResolvedValue(location({ kill_switch_on: true }));

    const screen = await said();

    expect(screen).toContain("No orders yet");
    expect(screen).toContain("nobody can place one until this restaurant is answering");
  });

  it("still names the clock every time on this screen is in", async () => {
    expect(await said()).toContain(TZ);
  });
});

describe("one pickup order with a note on a line", () => {
  beforeEach(() => {
    getOrdersBoard.mockResolvedValue([order()]);
  });

  it("names the order, the customer, and the number to ring them back on", async () => {
    const screen = await said();

    expect(screen).toContain("#1001");
    expect(screen).toContain("Phi");
    expect(screen).toContain("(510) 555-0143");
  });

  it("lists what to make, with quantities", async () => {
    const screen = await said();

    expect(screen).toContain("1 × Margherita");
    expect(screen).toContain("2 × Garlic bread");
  });

  /* A NOTE IS WHY THE PLATE IS RIGHT. It was said out loud, confirmed
     back to the caller, and stored on the line it belongs to. A board
     that does not show it hands the pass a ticket reading `1x
     Margherita` and the caller gets onions. */
  it("shows the note on the line it belongs to", async () => {
    const html = await markup();

    // Not merely present somewhere on the card: inside the same list
    // item as the dish it changes, so a cook reading three lines knows
    // which plate it is about.
    const line = html.slice(html.indexOf("Margherita"));
    expect(line.slice(0, line.indexOf("</li>"))).toContain("no onions");
  });

  it("prices the line and the order through money(), in a tabular figure", async () => {
    const html = await markup();

    expect(prose(html)).toContain("$27.00");
    // Every figure on this screen is a .num, so columns of money line up
    // digit under digit.
    expect(html).toMatch(/class="[^"]*\bnum\b[^"]*">\$27\.00</);
    expect(html).toMatch(/class="[^"]*\bnum\b[^"]*">\$18\.00</);
  });

  /* The mockup's card reads "Total · paid by SMS link". Nothing in this
     product texts anybody a payment link -- lib/agent/prompt.ts tells
     the agent to say payment is handled at pickup or delivery -- and a
     ticket that tells a kitchen the food is already paid for is not a
     cosmetic error. */
  it("does not tell the kitchen the order has been paid for", async () => {
    expect(await said()).not.toContain("paid by SMS link");
  });

  it("says when it was placed and when it was promised, in the restaurant's own clock", async () => {
    const screen = await said();

    expect(screen).toContain("Placed Aug 17, 2026, 9:12 PM");
    expect(screen).toContain("Promised Aug 17, 2026, 9:37 PM");
    // The column holds Aug 18 in UTC. Nothing on this screen may.
    expect(screen).not.toContain("Aug 18, 2026");
    // And how long it has been sitting there, which is the question a
    // pass asks first.
    expect(screen).toContain("6 min ago");
  });

  it("says it is a pickup, and offers no address for one", async () => {
    const screen = await said();

    expect(screen).toContain("Pickup");
    expect(screen).not.toContain("Deliver to");
  });

  it("links back to the call it was taken on", async () => {
    expect(await markup()).toContain(
      'href="/dashboard/calls/8f0f8c6e-0000-4000-8000-000000000000"',
    );
  });

  it("puts it under the board's first column, by name", async () => {
    expect(await said()).toContain("New");
  });
});

describe("a delivery", () => {
  it("says where the food is going", async () => {
    getOrdersBoard.mockResolvedValue([
      order({
        id: "ord-1002",
        orderNumber: 1002,
        type: "delivery",
        address: "742 Evergreen Terrace, apt 2",
        customerName: "Priya S.",
      }),
    ]);

    const screen = await said();

    expect(screen).toContain("Delivery");
    expect(screen).toContain("Deliver to 742 Evergreen Terrace, apt 2");
  });

  it("says so even when the agent recorded no address, rather than showing an empty line", async () => {
    // place_order refuses a delivery with no address, so this row could
    // only come from somewhere else -- and a delivery whose address is
    // missing is the one a kitchen must not silently treat as fine.
    getOrdersBoard.mockResolvedValue([
      order({ type: "delivery", address: null }),
    ]);

    expect(await said()).toContain("no address on this order");
  });
});

describe("the board's columns", () => {
  it("carries the three the approved design has, in its order", async () => {
    const screen = await said();
    getOrdersBoard.mockResolvedValue([order()]);

    const withOrders = await said();
    expect(withOrders.indexOf("New")).toBeLessThan(withOrders.indexOf("In the kitchen"));
    expect(withOrders.indexOf("In the kitchen")).toBeLessThan(withOrders.indexOf("Ready"));
    // An empty board shows the honest sentence instead of three empty
    // columns.
    expect(screen).not.toContain("In the kitchen");
  });

  it("puts each order in the column its status belongs to", async () => {
    getOrdersBoard.mockResolvedValue([
      order({ id: "a", orderNumber: 1003, status: "ready" }),
      order({ id: "b", orderNumber: 1002, status: "preparing" }),
      order({ id: "c", orderNumber: 1001, status: "confirmed" }),
    ]);

    const screen = await said();

    // Column heading, then the order under it, then the next heading.
    expect(screen.indexOf("#1001")).toBeGreaterThan(screen.indexOf("New"));
    expect(screen.indexOf("#1001")).toBeLessThan(screen.indexOf("In the kitchen"));
    expect(screen.indexOf("#1002")).toBeGreaterThan(screen.indexOf("In the kitchen"));
    expect(screen.indexOf("#1002")).toBeLessThan(screen.indexOf("Ready"));
    expect(screen.indexOf("#1003")).toBeGreaterThan(screen.indexOf("Ready"));
  });

  it("keeps the newest order at the top of its column", async () => {
    getOrdersBoard.mockResolvedValue([
      order({ id: "b", orderNumber: 1002, placedAt: "2026-08-18T01:15:00.000Z" }),
      order({ id: "a", orderNumber: 1001, placedAt: PLACED }),
    ]);

    const screen = await said();

    expect(screen.indexOf("#1002")).toBeLessThan(screen.indexOf("#1001"));
  });

  it("uses the design's own words for a column with nothing in it", async () => {
    // One order, in the middle column, so the two either side are empty
    // and both sentences the design wrote have to appear.
    getOrdersBoard.mockResolvedValue([order({ status: "preparing" })]);

    const screen = await said();

    expect(screen).toContain("Quiet for the moment.");
    expect(screen).toContain("Nothing here.");
  });

  /* THE ONE THING THE APPROVED BOARD CANNOT HOLD. Its three columns are
     New, In the kitchen and Ready; `order_status` also has 'completed'
     and 'cancelled', and there is no column for either. Dropping them
     silently is the defect this whole screen exists to undo, one status
     along, so the board says how many it is not showing. */
  it("says out loud how many orders it is not showing", async () => {
    getOrdersBoard.mockResolvedValue([
      order({ id: "a", orderNumber: 1002, status: "completed" }),
      order({ id: "b", orderNumber: 1001, status: "new" }),
    ]);

    const screen = await said();

    expect(screen).toContain("#1001");
    expect(screen).not.toContain("#1002");
    expect(screen).toContain("1 completed or cancelled order is not on this board");
  });

  it("counts them properly when there is more than one", async () => {
    getOrdersBoard.mockResolvedValue([
      order({ id: "a", orderNumber: 1003, status: "completed" }),
      order({ id: "b", orderNumber: 1002, status: "cancelled" }),
      order({ id: "c", orderNumber: 1001, status: "new" }),
    ]);

    expect(await said()).toContain("2 completed or cancelled orders are not on this board");
  });

  it("says nothing about them when there are none", async () => {
    getOrdersBoard.mockResolvedValue([order()]);

    expect(await said()).not.toContain("not on this board");
  });
});

describe("an order that is late", () => {
  it("is marked, and one that is not is left alone", async () => {
    getOrdersBoard.mockResolvedValue([
      // Promised five minutes before the clock this render ran on.
      order({ id: "a", orderNumber: 1002, promisedAt: "2026-08-18T01:13:00.000Z" }),
    ]);

    expect(await markup()).toMatch(/class="[^"]*tag-out/);

    getOrdersBoard.mockResolvedValue([order()]);
    expect(await markup()).not.toMatch(/class="[^"]*tag-out/);
  });

  it("is not marked once it is ready to be collected", async () => {
    // Past its promise time, but cooked: the mark is for food nobody has
    // finished, not for a bag sitting on the counter waiting for its
    // owner.
    getOrdersBoard.mockResolvedValue([
      order({ status: "ready", promisedAt: "2026-08-18T01:13:00.000Z" }),
    ]);

    expect(await markup()).not.toMatch(/class="[^"]*tag-out/);
  });
});

describe("an order the agent could not name", () => {
  it("says so rather than printing a gap", async () => {
    getOrdersBoard.mockResolvedValue([
      order({ customerName: null, customerPhone: null, promisedAt: null }),
    ]);

    const screen = await said();

    expect(screen).toContain("No name taken");
    expect(screen).toContain("no number taken");
    // A sentence, not a label with a gap after it: "Promised —" is
    // something a reader has to interpret.
    expect(screen).toContain("No promise time recorded");
    expect(screen).not.toContain("Promised No promise");
  });
});

describe("the control the approved design draws on a ticket", () => {
  /* design/Dialtone.html ends every ticket with

       <button sc-camel-on-click="{{ o.advance }}"
               class="btn btn-secondary btn-block">{{ o.advanceLabel }}</button>

     labelled "Start cooking", "Mark ready" or "Picked up" by column,
     moving the card one column along.

     THIS SCREEN SHIPPED WITHOUT IT, AND THE TEST THAT USED TO STAND HERE
     PINNED THE ABSENCE. Read it in the history of this file before
     changing anything below, because its argument is still the argument:
     nothing in this repository wrote `orders.status` -- `place_order`
     wrote 'new' and the only other toucher of the column was the trigger
     that LOGS a change something else made -- and shipping the button
     against no writer would have been worse on a pass than shipping
     none. A cook who presses "Start cooking" and watches the ticket stay
     put has been told the next cook knows, and the next cook does not.

     WHAT CHANGED IS THE PREMISE, NOT THE ARGUMENT. There is a writer now:
     app/dashboard/orders/actions.ts moves one order to one status on the
     signed-in user's own session, and 20260819000100 makes the audit
     trigger SECURITY DEFINER so the write is no longer rolled back by the
     RLS on `order_status_events`. So the old test's claim -- no control
     that cannot move anything -- is kept, in the only form that still
     says something: every button on a ticket names a move ORDER_MOVES
     actually offers, which is the same table the server reads before it
     writes. A button this page could render and the action would refuse
     cannot exist.

     The other half of the old argument -- that a press which does not
     land must not look like one that did -- is components/
     OrderMoves.test.tsx, where a click is a real click and a refusal is
     a real sentence on the card. */
  it("is on the ticket now, in the column's own words", async () => {
    getOrdersBoard.mockResolvedValue([
      order({ id: "a", orderNumber: 1003, status: "ready" }),
      order({ id: "b", orderNumber: 1002, status: "preparing" }),
      order({ id: "c", orderNumber: 1001, status: "new" }),
    ]);

    const screen = await said();

    expect(screen).toContain("Start cooking");
    expect(screen).toContain("Mark ready");
    expect(screen).toContain("Picked up");
  });

  it("offers a way back out of the two columns that have one, and none out of New", async () => {
    getOrdersBoard.mockResolvedValue([order({ status: "new" })]);
    expect(await said()).not.toContain("Not started after all");

    getOrdersBoard.mockResolvedValue([order({ status: "preparing" })]);
    expect(await said()).toContain("Not started after all");

    getOrdersBoard.mockResolvedValue([order({ status: "ready" })]);
    expect(await said()).toContain("Back in the kitchen");
  });

  /* The old test's claim, in the form the writer left it: not "there is
     no button" but "there is no button behind which nothing happens". */
  it("renders exactly the moves the writer will accept, and nothing else", async () => {
    for (const status of ["new", "confirmed", "preparing", "ready"] as const) {
      getOrdersBoard.mockResolvedValue([order({ status })]);

      const html = await markup();
      const rendered = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

      expect(rendered).toEqual(ORDER_MOVES[status].map((move) => move.label));
    }
  });

  /* A ticket that has left the board has no card, so it can have no
     button -- and a form left open on a tablet cannot move an order that
     is already finished. */
  it("is not drawn for an order that is no longer on the board", async () => {
    getOrdersBoard.mockResolvedValue([order({ status: "completed" })]);

    const html = await markup();

    expect(html).not.toContain("<button");
    expect(prose(html)).toContain("not on this board");
  });

  /* THE DEVICE THIS SCREEN IS READ ON. A board at a pass is a tablet,
     and app.css's coarse-pointer block raises every .btn to a 44px
     target -- which on two stacked presses --space-1 (3.4px) apart makes
     the targets bigger while the lane between them stays where it was.
     In the Ready column that pair is "Picked up" over "Back in the
     kitchen", and 'completed' has no column here: a thumb that lands
     high takes the ticket off the board with no press left to bring it
     back. Asserted against the stylesheet because there is no layout
     under renderToStaticMarkup to measure -- the same idiom, and the
     same reason, as lib/admin/edit-screen.test.ts's assertions on this
     file. */
  it("separates the two presses on the pointer a kitchen actually uses", () => {
    const css = readFileSync(
      fileURLToPath(new URL("../../app/app.css", import.meta.url)),
      "utf8",
    );
    const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
    const separation = coarse.slice(
      coarse.indexOf("── separation"),
      coarse.indexOf("gap: var(--touch-gap)"),
    );

    expect(separation).toContain(".order-moves");
    // And at rest it is still the mockup's own spacing, not the touch one.
    expect(css).toContain(".order-moves { display: flex; flex-direction: column; gap: var(--space-1); }");
  });

  /* Screen readers get a dozen of these on a busy board, and "Start
     cooking" a dozen times is not a list anybody can navigate. */
  it("says which order each press is about, without printing it twice on the card", async () => {
    getOrdersBoard.mockResolvedValue([order()]);

    const html = await markup();

    expect(html).toContain('aria-label="Start cooking, order #1001"');
  });
});

describe("what a caller said their name was", () => {
  /* The kitchen reads this name off the ticket and says it out loud when
     the person walks in, so it is rendered as stored. The read is what
     guarantees a card number never gets that far (lib/orders/
     board.test.ts); what the SCREEN owes is that it prints what it was
     handed and does not reassemble the digits around it. */
  it("is printed as the read handed it over, redaction and all", async () => {
    getOrdersBoard.mockResolvedValue([
      order({ customerName: "Phi [redacted]", customerPhone: "011 44 20 7946 0958" }),
    ]);

    const screen = await said();

    expect(screen).toContain("Phi [redacted]");
    expect(screen).not.toContain("4111");
    // The number goes out whole -- see the board test of the same name.
    expect(screen).toContain("011 44 20 7946 0958");
  });
});

describe("a restaurant with no location at all", () => {
  it("renders nothing and leaves the layout to explain", async () => {
    getCurrentLocation.mockResolvedValue(null);

    expect(await markup()).toBe("");
    expect(getOrdersBoard).not.toHaveBeenCalled();
  });
});

describe("the orders that have left the board", () => {
  /* THE BOARD ALREADY SAID HOW MANY IT WAS NOT SHOWING, and for a while
     that sentence was the entire trace of a finished order anywhere in
     this product: press "Picked up" and the ticket, its lines, its money
     and the caller who is owed it left every screen. /dashboard/orders/
     history is where they are now, and the board owes a reader the way
     there -- a count of things you cannot go and look at is only half an
     answer. */
  it("offers a way to them from the head of the board", async () => {
    const html = await markup();

    expect(html).toContain('href="/dashboard/orders/history"');
    expect(prose(html)).toContain("Finished orders");
  });

  it("offers it on a board that has tickets on it too", async () => {
    getOrdersBoard.mockResolvedValue([order()]);

    expect(await markup()).toContain('href="/dashboard/orders/history"');
  });

  /* AND NOT ON A TICKET. This board is read on a tablet at a pass -- the
     device the coarse-pointer block at the end of app.css was measured
     for -- and the one thing a card must not grow is another tap target
     beside the presses that move the order. The link lives in the page
     head, at the far end of it, where the system already puts a screen's
     own action (.page-head .actions). */
  it("puts it in the head and nowhere near the presses on a card", async () => {
    getOrdersBoard.mockResolvedValue([order()]);

    const html = await markup();
    const card = html.slice(html.indexOf("order-card"));

    expect(html.indexOf("/dashboard/orders/history")).toBeLessThan(
      html.indexOf("order-card"),
    );
    expect(card).not.toContain("/dashboard/orders/history");
  });

  /* The board's own behaviour is unchanged by the link: the same three
     columns, the same four statuses, the same presses, and the same
     sentence about what it is not showing. */
  it("changes nothing else about the board", async () => {
    getOrdersBoard.mockResolvedValue([
      order({ id: "a", orderNumber: 1002, status: "completed" }),
      order({ id: "b", orderNumber: 1001, status: "new" }),
    ]);

    const screen = await said();

    expect(screen).toContain("1 completed or cancelled order is not on this board");
    expect(screen).toContain("#1001");
    expect(screen).not.toContain("#1002");
    expect(screen).toContain("Start cooking");
  });
});
