import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrderRecord } from "@/lib/data";

/** One order in full, at /dashboard/orders/<id> -- and THE FIRST TIME
 *  `order_status_events` HAS EVER REACHED A SCREEN.
 *
 *  That table has been written on every status change since the schema's
 *  first migration: order_id, from_status, to_status, changed_by,
 *  changed_at. It is the reason 20260819000100 had to make
 *  app.log_order_status() SECURITY DEFINER. And it was read by nothing --
 *  a grep for it in this repository found comments and no code. "Who
 *  marked this ready, and when" was recorded and unreadable.
 *
 *  So the assertions below are mostly about the timeline, and the
 *  sharpest of them is about what stands where `changed_by` is. A raw
 *  uuid on a restaurant's screen is the shape of a question we could not
 *  answer, printed; a name would be an invention, because auth.users is
 *  not readable on an owner's own session at all and this page may not
 *  reach for the service role. What is rendered is what the database can
 *  supply and nothing else.
 */

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) =>
    createElement("a", { href, ...rest }, children),
}));

/* notFound() throws a framework-internal control-flow error. Thrown by
   name here so a test can assert "this page refuses to render" without
   depending on how Next spells it this week. */
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const getCurrentLocation = vi.fn();
const getOrderRecord = vi.fn();

vi.mock("@/lib/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/data")>();
  return { ...actual, getCurrentLocation, getOrderRecord };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => {
    throw new Error("this screen's reads are stubbed");
  },
}));

const OrderPage = (await import("@/app/dashboard/orders/[id]/page")).default;

const TZ = "America/New_York";
const ID = "8f0f8c6e-0000-4000-8000-000000000000";
const CALL = "7a1a1a1a-0000-4000-8000-000000000000";

const ME = "11111111-1111-1111-1111-111111111111";
const BOSS = "22222222-2222-2222-2222-222222222222";
const GONE = "44444444-4444-4444-4444-444444444444";

const PLACED = "2026-08-18T01:12:00.000Z"; // Aug 17, 9:12 PM in New York
const PROMISED = "2026-08-18T01:37:00.000Z";
const NOW = Date.parse("2026-08-18T02:00:00.000Z");

function location(over: Record<string, unknown> = {}) {
  return { id: "loc-nonna", org_id: "org-nonna", name: "Nonna Rosa", timezone: TZ, ...over };
}

function record(over: Partial<OrderRecord> = {}): OrderRecord {
  return {
    order: {
      id: ID,
      orderNumber: 1001,
      callId: CALL,
      customerName: "Phi",
      customerPhone: "(510) 555-0143",
      type: "pickup",
      status: "completed",
      totalCents: 2700,
      placedAt: PLACED,
      promisedAt: PROMISED,
      address: null,
      lines: [
        { id: "l1", name: "Margherita", quantity: 1, totalCents: 1800, note: "no onions" },
        { id: "l2", name: "Garlic bread", quantity: 2, totalCents: 900, note: null },
      ],
    },
    events: [
      { id: "e1", from: null, to: "new", changedBy: null, changedAt: PLACED },
      {
        id: "e2",
        from: "new",
        to: "preparing",
        changedBy: ME,
        changedAt: "2026-08-18T01:15:00.000Z",
      },
      {
        id: "e3",
        from: "preparing",
        to: "ready",
        changedBy: BOSS,
        changedAt: "2026-08-18T01:31:00.000Z",
      },
      {
        id: "e4",
        from: "ready",
        to: "completed",
        changedBy: ME,
        changedAt: "2026-08-18T01:44:00.000Z",
      },
    ],
    actors: { [ME]: "manager", [BOSS]: "owner" },
    viewerId: ME,
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

async function markup(id = ID): Promise<string> {
  return renderToStaticMarkup(await OrderPage({ params: Promise.resolve({ id }) }));
}

async function said(id = ID): Promise<string> {
  return prose(await markup(id));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  getCurrentLocation.mockResolvedValue(location());
  getOrderRecord.mockResolvedValue(record());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what the page asks for", () => {
  it("reads the order against this restaurant and this organization", async () => {
    await markup();

    expect(getOrderRecord).toHaveBeenCalledWith("loc-nonna", "org-nonna", ID);
  });

  /* Same guard, and the same reason, as the call detail page: an id off
     the URL that is not a uuid must not reach Postgres to come back as a
     type error naming a column. */
  it("refuses an id that is not a uuid without asking the database anything", async () => {
    await expect(markup("history")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(markup("../../etc/passwd")).rejects.toThrow("NEXT_NOT_FOUND");

    expect(getOrderRecord).not.toHaveBeenCalled();
  });

  /* RLS makes "another restaurant's order" and "no such order"
     indistinguishable, which is what we want -- a 404 tells a stranger
     nothing about whether the row exists. */
  it("is a 404 for an order this restaurant cannot see", async () => {
    getOrderRecord.mockResolvedValue(null);

    await expect(markup()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("the order itself", () => {
  it("names the order and says what state it ended in", async () => {
    const html = await markup();

    expect(prose(html)).toContain("Order #1001");
    expect(html).toMatch(/class="tag tag-accent">completed</);
  });

  it("lists what was ordered, with the note the caller said out loud", async () => {
    const html = await markup();

    expect(prose(html)).toContain("1 × Margherita");
    expect(prose(html)).toContain("2 × Garlic bread");

    // On the line it belongs to, exactly as on the board's ticket: a note
    // nobody can attribute is a note nobody can read.
    const line = html.slice(html.indexOf("Margherita"));
    expect(line.slice(0, line.indexOf("</li>"))).toContain("no onions");
  });

  it("prices every line and the order through money(), in a tabular figure", async () => {
    const html = await markup();

    expect(html).toMatch(/class="[^"]*\bnum\b[^"]*">\$18\.00</);
    expect(html).toMatch(/class="[^"]*\bnum\b[^"]*">\$27\.00</);
  });

  /* The mockup's card reads "Total · paid by SMS link". Nothing in this
     product texts anybody a payment link, and this screen is the record
     an owner would check a dispute against. */
  it("does not claim the order was paid for", async () => {
    expect(await said()).not.toContain("paid by SMS link");
  });

  it("names the caller and the number to ring them back on", async () => {
    const screen = await said();

    expect(screen).toContain("Phi");
    expect(screen).toContain("(510) 555-0143");
  });

  it("says when it was placed and when it was promised, in the restaurant's clock", async () => {
    const screen = await said();

    expect(screen).toContain("Aug 17, 2026, 9:12 PM");
    expect(screen).toContain("Aug 17, 2026, 9:37 PM");
    // The columns hold Aug 18 in UTC. Nothing on this screen may.
    expect(screen).not.toContain("Aug 18, 2026");
  });

  it("says where a delivery went", async () => {
    getOrderRecord.mockResolvedValue(
      record({
        order: {
          ...record().order,
          type: "delivery",
          address: "742 Evergreen Terrace, apt 2",
        },
      }),
    );

    const screen = await said();

    expect(screen).toContain("Delivery");
    expect(screen).toContain("742 Evergreen Terrace, apt 2");
  });

  it("links back to the call it was taken on", async () => {
    expect(await markup()).toContain(`href="/dashboard/calls/${CALL}"`);
  });

  /* `orders.call_id` is ON DELETE SET NULL, so an order outlives its
     call -- and a recording ages out long before a dispute about the
     order does. */
  it("says so when the call is gone rather than offering a dead link", async () => {
    getOrderRecord.mockResolvedValue(
      record({ order: { ...record().order, callId: null } }),
    );

    const screen = await said();

    expect(screen).toContain("No call record");
    expect(await markup()).not.toContain("/dashboard/calls/");
  });

  /* THIS SCREEN CHANGES NOTHING. The board is the one place in this
     product that moves an order, and every refusal sentence a cook is
     owed lives there. A second writer on a record screen is a second
     answer to "what is the kitchen doing". */
  it("carries no control that writes anything", async () => {
    const html = await markup();

    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });
});

describe("the timeline", () => {
  it("is drawn from order_status_events, oldest first", async () => {
    const screen = await said();

    expect(screen.indexOf("Placed")).toBeLessThan(screen.indexOf("Started cooking"));
    expect(screen.indexOf("Started cooking")).toBeLessThan(screen.indexOf("Marked ready"));
    expect(screen.indexOf("Marked ready")).toBeLessThan(screen.indexOf("Picked up"));
  });

  it("dates every step whole, in the restaurant's own clock", async () => {
    const screen = await said();

    expect(screen).toContain("Aug 17, 2026, 9:15 PM");
    expect(screen).toContain("Aug 17, 2026, 9:31 PM");
    expect(screen).toContain("Aug 17, 2026, 9:44 PM");
  });

  /* THE ASSERTION THIS WHOLE SCREEN IS ACCOUNTABLE TO. `changed_by` is a
     uuid, and a uuid is not an answer to "who marked this ready". */
  it("never prints a uuid at a restaurant", async () => {
    const html = await markup();

    for (const uuid of [ME, BOSS]) expect(html).not.toContain(uuid);
    expect(prose(html)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  });

  it("says which steps were the reader's own, and what role a colleague holds", async () => {
    const screen = await said();

    expect(screen).toContain("Started cooking Aug 17, 2026, 9:15 PM · you");
    expect(screen).toContain("Marked ready Aug 17, 2026, 9:31 PM · an owner");
  });

  /* A null changed_by is the agent's own token, which carries no `sub`
     claim -- so the first line of every order's timeline is the order
     arriving on the phone, and not a gap. */
  it("says the first step was the agent taking the call", async () => {
    expect(await said()).toContain("Placed Aug 17, 2026, 9:12 PM · the agent, on the call");
  });

  it("says a colleague has left rather than inventing a name for them", async () => {
    getOrderRecord.mockResolvedValue(
      record({
        events: [
          { id: "e1", from: null, to: "new", changedBy: null, changedAt: PLACED },
          {
            id: "e2",
            from: "new",
            to: "preparing",
            changedBy: GONE,
            changedAt: "2026-08-18T01:15:00.000Z",
          },
        ],
      }),
    );

    const screen = await said();

    expect(screen).toContain("someone who has left this restaurant");
    expect(screen).not.toContain(GONE);
  });

  /* A ticket walked forward and back is an ordinary mid-service
     correction -- the board offers both ways back on purpose. The log
     must show it as two different things happening, not as the same
     thing twice. */
  it("shows a correction as a correction, not as a repeat of the move it undoes", async () => {
    getOrderRecord.mockResolvedValue(
      record({
        events: [
          { id: "e1", from: null, to: "new", changedBy: null, changedAt: PLACED },
          {
            id: "e2",
            from: "new",
            to: "preparing",
            changedBy: ME,
            changedAt: "2026-08-18T01:15:00.000Z",
          },
          {
            id: "e3",
            from: "preparing",
            to: "new",
            changedBy: ME,
            changedAt: "2026-08-18T01:16:00.000Z",
          },
        ],
      }),
    );

    const screen = await said();

    expect(screen).toContain("Put back to New");
    expect(screen).toContain("Started cooking");
  });

  /* A row whose log is empty is a real row: a direct INSERT that rolled
     back before 20260819000100, a restore, a fixture. The screen has to
     say so rather than draw an empty card, because an audit trail that
     renders as nothing is indistinguishable from one nobody wrote to. */
  it("says the log is empty rather than drawing an empty card", async () => {
    getOrderRecord.mockResolvedValue(record({ events: [] }));

    const screen = await said();

    expect(screen).toContain("No status changes recorded for this order");
  });

  it("names the clock the whole timeline is in, once", async () => {
    expect(await said()).toContain(TZ);
  });
});

describe("the way back", () => {
  it("returns to the history the reader came from", async () => {
    expect(await markup()).toContain('href="/dashboard/orders/history"');
  });
});

describe("a restaurant with no location at all", () => {
  it("does not try to read an order against a restaurant that is not there", async () => {
    getCurrentLocation.mockResolvedValue(null);

    await expect(markup()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getOrderRecord).not.toHaveBeenCalled();
  });
});
