import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryOrder } from "@/lib/data";

/** What a restaurant reads on /dashboard/orders/history.
 *
 *  THE SCREEN THE PRODUCT OWNER ASKED FOR. The board is a live kitchen
 *  screen; once a cook pressed "Picked up" the order left every screen in
 *  the product and the only trace was one sentence on the board saying
 *  how many it was not showing. This is where a finished order can be
 *  found again.
 *
 *  A SEPARATE ROUTE AND NOT A TOGGLE ON THE BOARD, which is the decision
 *  most of this file is really about. The board is read at a pass on a
 *  tablet, in service, by somebody with their hands full; a segmented
 *  control that swaps the whole screen for a list of finished orders is a
 *  press that takes the live tickets away mid-service. The history is
 *  read at a desk, after service, by the owner. Two readers, two devices,
 *  two moments -- and one bookmark each, so the kitchen tablet's own
 *  address can never be saved in the wrong mode.
 *
 *  Under lib/ because vitest.config.ts's node project takes
 *  lib/**\/*.test.ts, beside lib/orders/screen.test.ts, which is the same
 *  idiom for the board: await the async server component and put it
 *  through renderToStaticMarkup, then assert on the WORDS.
 */

/* next/link mounts against the App Router's context, which nothing here
   is inside. An anchor is a faithful stand-in -- and unlike the board's
   copy of this mock, this one passes the rest of the props through,
   because the filter nav's whole behaviour is which option wears
   `is-on` and `aria-current`. */
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  } & Record<string, unknown>) => createElement("a", { href, ...rest }, children),
}));

const getCurrentLocation = vi.fn();
const getOrderHistoryPage = vi.fn();

/* Only the two reads are stubbed. ORDER_HISTORY_WINDOWS and its default
   are the screen's own vocabulary and are imported for real, so a window
   added to the list appears in this test's assertions rather than
   silently not being drawn. */
vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return { ...actual, getCurrentLocation, getOrderHistoryPage };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => {
    throw new Error("this screen's reads are stubbed");
  },
}));

const HistoryPage = (await import("@/app/dashboard/orders/history/page")).default;
const { DEFAULT_ORDER_HISTORY_WINDOW, ORDER_HISTORY_WINDOWS } = await import("@/lib/data");

const TZ = "America/New_York";
const PLACED = "2026-08-18T01:12:00.000Z"; // Aug 17, 9:12 PM in New York
const NOW = Date.parse("2026-08-18T02:00:00.000Z");

function location(over: Record<string, unknown> = {}) {
  return { id: "loc-nonna", name: "Nonna Rosa", timezone: TZ, org_id: "org-nonna", ...over };
}

function historyOrder(over: Partial<HistoryOrder> = {}): HistoryOrder {
  return {
    id: "8f0f8c6e-0000-4000-8000-000000000000",
    orderNumber: 1001,
    customerName: "Phi",
    type: "pickup",
    status: "completed",
    totalCents: 2700,
    placedAt: PLACED,
    ...over,
  };
}

function pageOf(orders: HistoryOrder[], over: Record<string, unknown> = {}) {
  return {
    orders,
    total: orders.length,
    page: 1,
    pageCount: 1,
    since: "2026-08-11T04:00:00.000Z",
    ...over,
  };
}

function prose(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&middot;/g, "·")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x2014;/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

async function markup(params: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await HistoryPage({ searchParams: Promise.resolve(params) }));
}

async function said(params: Record<string, string> = {}): Promise<string> {
  return prose(await markup(params));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  getCurrentLocation.mockResolvedValue(location());
  getOrderHistoryPage.mockResolvedValue(pageOf([]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what the screen asks the database for", () => {
  it("reads a week of this restaurant's finished orders by default", async () => {
    await markup();

    expect(getOrderHistoryPage).toHaveBeenCalledWith("loc-nonna", {
      timezone: TZ,
      window: DEFAULT_ORDER_HISTORY_WINDOW,
      page: 1,
    });
  });

  it("takes the window and the page off the URL", async () => {
    await markup({ window: "month", page: "3" });

    expect(getOrderHistoryPage).toHaveBeenCalledWith("loc-nonna", {
      timezone: TZ,
      window: "month",
      page: 3,
    });
  });

  /* The windows are links, so a stale bookmark or a hand-edited address
     is the ordinary way something else arrives. It falls back rather than
     throwing: a bad query string is not a reason a restaurant cannot see
     its own orders. */
  it("falls back to the default rather than trusting an edited URL", async () => {
    await markup({ window: "since-the-dawn-of-time", page: "not-a-number" });

    expect(getOrderHistoryPage).toHaveBeenCalledWith("loc-nonna", {
      timezone: TZ,
      window: DEFAULT_ORDER_HISTORY_WINDOW,
      page: 1,
    });
  });
});

describe("the window control", () => {
  /* Links in a .seg, exactly as on the call log and the message book: a
     filtered view stays shareable and survives a refresh. The house
     already has this control; a history screen is not the place to
     invent a second kind of filter nav. */
  it("is the house's segmented filter nav, drawn as links", async () => {
    const html = await markup();

    expect(html).toContain('class="seg filter-seg"');
    for (const w of ORDER_HISTORY_WINDOWS) expect(prose(html)).toContain(w.label);
  });

  it("marks the window being read, and only that one", async () => {
    const html = await markup({ window: "month" });

    const on = [...html.matchAll(/<a[^>]*class="seg-opt is-on"[^>]*>([^<]*)<\/a>/g)];
    expect(on.map((m) => m[1])).toEqual(["Last 30 days"]);
    expect(html).toContain('aria-current="page"');
  });

  /* The default window is the bare address. Anything else carries its
     own query, so the URL in somebody's address bar is the view they are
     looking at. */
  it("leaves the default window out of the URL and names every other one", async () => {
    const html = await markup();

    expect(html).toContain('href="/dashboard/orders/history"');
    expect(html).toContain('href="/dashboard/orders/history?window=month"');
    expect(html).toContain('href="/dashboard/orders/history?window=all"');
  });

  /* Changing the window while reading page 4 of the old one must not ask
     for page 4 of the new one -- a narrower window has fewer pages, and
     the answer to that request is a page nobody chose. */
  it("sends every window back to its own first page", async () => {
    getOrderHistoryPage.mockResolvedValue(pageOf([historyOrder()], { page: 4, pageCount: 9 }));

    const html = await markup({ window: "all", page: "4" });

    expect(html).toContain('href="/dashboard/orders/history?window=month"');
    expect(html).not.toContain("window=month&amp;page=4");
  });
});

describe("a restaurant that has finished nothing", () => {
  it("says what puts an order here rather than that the screen is empty", async () => {
    const screen = await said({ window: "all" });

    expect(screen).toContain("No finished orders yet");
    expect(screen).toContain("Picked up");
  });

  /* A window with nothing in it is a different fact from a restaurant
     with no history at all, and the difference is actionable: one of
     them is fixed by pressing "All time". */
  it("says the window is empty rather than the restaurant is, and where the rest are", async () => {
    const screen = await said();

    expect(screen).not.toContain("No finished orders yet");
    expect(screen).toContain("Nothing finished in this window");
    // And it points at the screen that IS still holding those orders.
    expect(screen).toContain("board");
  });
});

describe("one finished order on the list", () => {
  beforeEach(() => {
    getOrderHistoryPage.mockResolvedValue(pageOf([historyOrder()]));
  });

  it("names the order, the caller and the money", async () => {
    const screen = await said();

    expect(screen).toContain("#1001");
    expect(screen).toContain("Phi");
    expect(screen).toContain("$27.00");
  });

  /* A LOG ROW CARRIES ITS DATE. lib/format.ts says it in as many words:
     "11:09 AM" on its own does not say which 11:09 AM, and a history
     screen is the one place in this product where a row is guaranteed to
     be old. */
  it("dates every row, in the restaurant's own clock", async () => {
    const screen = await said();

    expect(screen).toContain("Aug 17, 2026, 9:12 PM");
    // The column holds Aug 18 in UTC. Nothing on this screen may.
    expect(screen).not.toContain("Aug 18, 2026");
  });

  it("shows the status in the same chip every other state in this product wears", async () => {
    const html = await markup();

    expect(html).toMatch(/class="tag tag-accent">completed</);
  });

  it("marks a cancelled order as the one that went wrong", async () => {
    getOrderHistoryPage.mockResolvedValue(
      pageOf([historyOrder({ status: "cancelled", orderNumber: 1002 })]),
    );

    expect(await markup()).toMatch(/class="tag tag-out">cancelled</);
  });

  it("opens the whole order, at its own address", async () => {
    expect(await markup()).toContain(
      'href="/dashboard/orders/8f0f8c6e-0000-4000-8000-000000000000"',
    );
  });

  it("says whether it was collected or delivered", async () => {
    expect(await said()).toContain("Pickup");

    getOrderHistoryPage.mockResolvedValue(pageOf([historyOrder({ type: "delivery" })]));
    expect(await said()).toContain("Delivery");
  });

  it("says so when the agent took no name, rather than printing a gap", async () => {
    getOrderHistoryPage.mockResolvedValue(pageOf([historyOrder({ customerName: null })]));

    expect(await said()).toContain("No name taken");
  });

  /* The read scrubs card numbers out of a caller's name (lib/orders/
     history-read.test.ts). What the SCREEN owes is that it prints what it
     was handed and does not reassemble the digits around it. */
  it("prints the name as the read handed it over, redaction and all", async () => {
    getOrderHistoryPage.mockResolvedValue(
      pageOf([historyOrder({ customerName: "Phi [redacted]" })]),
    );

    const screen = await said();

    expect(screen).toContain("Phi [redacted]");
    expect(screen).not.toContain("4111");
  });
});

describe("a restaurant with more history than one page", () => {
  beforeEach(() => {
    getOrderHistoryPage.mockResolvedValue(
      pageOf([historyOrder()], { total: 214, page: 3, pageCount: 5 }),
    );
  });

  it("says where in the history the reader is standing", async () => {
    const screen = await said({ page: "3" });

    expect(screen).toContain("of 214");
  });

  it("offers both directions, and carries the window with them", async () => {
    const html = await markup({ window: "all", page: "3" });

    expect(html).toContain('href="/dashboard/orders/history?window=all&amp;page=2"');
    expect(html).toContain('href="/dashboard/orders/history?window=all&amp;page=4"');
  });

  it("offers no way further back from the last page", async () => {
    getOrderHistoryPage.mockResolvedValue(
      pageOf([historyOrder()], { total: 214, page: 5, pageCount: 5 }),
    );

    const html = await markup({ page: "5" });

    expect(html).toContain("page=4");
    expect(html).not.toContain("page=6");
  });

  it("draws no pager at all when the whole history fits on one page", async () => {
    getOrderHistoryPage.mockResolvedValue(pageOf([historyOrder()]));

    expect(await markup()).not.toContain("page=2");
  });
});

describe("the way back to the kitchen", () => {
  it("links to the board, which is where the live tickets still are", async () => {
    expect(await markup()).toContain('href="/dashboard/orders"');
  });
});

describe("a restaurant with no location at all", () => {
  it("renders nothing and leaves the layout to explain", async () => {
    getCurrentLocation.mockResolvedValue(null);

    expect(await markup()).toBe("");
    expect(getOrderHistoryPage).not.toHaveBeenCalled();
  });
});
