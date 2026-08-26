import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MOVE_ALREADY_MOVED,
  MOVE_NOT_ALLOWED,
  MOVE_REFUSED_BY_DATABASE,
  MOVE_WRITE_FAILED,
} from "@/lib/orders/moves";

/** THE WRITE `orders.status` NEVER HAD, driven the way a browser drives
 *  it and the way a hand-rolled POST would.
 *
 *  `place_order` wrote 'new' and nothing in this repository ever wrote
 *  the column again, so two of the board's three columns could not fill.
 *  This is the action that fills them: one order, one status, on the
 *  signed-in user's own session, so RLS is the authorisation check and
 *  not a role this app hands itself.
 *
 *  What is asserted here is mostly what happens when the write does NOT
 *  land. A card that stays where it was and says nothing has told a cook
 *  the next cook knows -- which is the exact failure the board withheld
 *  its button to avoid, and shipping the button and swallowing its errors
 *  would be that failure with a control on top of it.
 */

type Result = { data: { id: string }[] | null; error: { code: string; message: string; details: string } | null };

/** Every update the action actually sent, and what it narrowed to. */
let writes: { table: string; values: Record<string, unknown>; filters: [string, unknown][] }[];
/** What the next write comes back with. */
let result: Result;

const getUser = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: { getUser },
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => {
        const filters: [string, unknown][] = [];
        writes.push({ table, values, filters });
        const query = {
          eq: (column: string, value: unknown) => {
            filters.push([column, value]);
            return query;
          },
          select: async () => result,
        };
        return query;
      },
    }),
  }),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { moveOrder } = await import("@/app/dashboard/orders/actions");

const AN_ORDER = "8f0f8c6e-0000-4000-8000-000000000000";

const SETTLED = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "owner@nonnarosa.test",
  app_metadata: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  writes = [];
  result = { data: [{ id: AN_ORDER }], error: null };
  getUser.mockResolvedValue({ data: { user: SETTLED }, error: null });
});

describe("a cook pressing Start cooking", () => {
  it("writes the new status and nothing else", async () => {
    const outcome = await moveOrder(AN_ORDER, "new", "preparing");

    expect(outcome).toEqual({ ok: true });
    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe("orders");
    expect(writes[0].values).toEqual({ status: "preparing" });
  });

  /* THE SECOND FILTER IS THE POINT. A kitchen runs more than one screen,
     and the status the cook was looking at is part of what they pressed:
     narrowing on it means a ticket somebody else already started is not
     dragged backwards by a press aimed at the card as it used to be. */
  it("moves it only if it is still where the cook was looking at it", async () => {
    await moveOrder(AN_ORDER, "new", "preparing");

    expect(writes[0].filters).toEqual([
      ["id", AN_ORDER],
      ["status", "new"],
    ]);
  });

  it("repaints the board, because the card has to be under a different heading now", async () => {
    await moveOrder(AN_ORDER, "new", "preparing");

    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/orders");
  });
});

describe("a move this board does not make", () => {
  /* Reachable in the ordinary product only by a form open since before a
     deploy -- and at any time by a POST straight at the action, which is
     what a "use server" export is from the moment it compiles. */
  it("writes nothing when the ticket would skip the kitchen", async () => {
    const outcome = await moveOrder(AN_ORDER, "new", "completed");

    expect(outcome).toEqual({ error: MOVE_NOT_ALLOWED });
    expect(writes).toEqual([]);
  });

  it("writes nothing when something asks it to cancel an order", async () => {
    const outcome = await moveOrder(AN_ORDER, "new", "cancelled");

    expect(outcome).toEqual({ error: MOVE_NOT_ALLOWED });
    expect(writes).toEqual([]);
  });

  /* Neither argument is trusted to be a status at all: both arrive as
     strings over the wire, and a value that is not in the enum would
     otherwise reach Postgres and come back as a type error carrying the
     column's name. */
  it("writes nothing when the status is not one the schema has", async () => {
    expect(await moveOrder(AN_ORDER, "new", "delivered" as never)).toEqual({
      error: MOVE_NOT_ALLOWED,
    });
    expect(await moveOrder(AN_ORDER, "queued" as never, "preparing")).toEqual({
      error: MOVE_NOT_ALLOWED,
    });
    expect(writes).toEqual([]);
  });

  it("writes nothing when the id is not the shape of an id", async () => {
    const outcome = await moveOrder("../../orders", "new", "preparing");

    expect(outcome).toEqual({ error: MOVE_NOT_ALLOWED });
    expect(writes).toEqual([]);
  });
});

describe("a ticket that had already moved", () => {
  /* No error and no row: either another screen moved it first, or it
     belongs to a restaurant this account cannot write to and RLS matched
     nothing. The browser cannot tell those apart, so the sentence claims
     neither -- and the board is repainted, so the card the cook is about
     to read again is the truth. */
  it("says so, and brings the board up to date rather than leaving the card where it was", async () => {
    result = { data: [], error: null };

    const outcome = await moveOrder(AN_ORDER, "new", "preparing");

    expect(outcome).toEqual({ error: MOVE_ALREADY_MOVED });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/orders");
  });

  it("says the same when the row comes back null rather than empty", async () => {
    result = { data: null, error: null };

    expect(await moveOrder(AN_ORDER, "new", "preparing")).toEqual({
      error: MOVE_ALREADY_MOVED,
    });
  });
});

describe("a write the database refuses", () => {
  const refused = {
    code: "42501",
    message: 'new row violates row-level security policy for table "order_status_events"',
    details: 'Failing row contains (…, Phi, (510) 555-0143, …).',
  };

  /* THE STATE OF EVERY DATABASE THIS FEATURE HAS NOT BEEN MIGRATED ON.
     The UPDATE on `orders` is allowed by `orders_rw`; the audit trigger
     then fires as the signed-in user, `order_status_events` has no INSERT
     policy for `authenticated`, and the whole transaction rolls back.
     Pressing again does exactly this again, so the cook is not sent
     looking for a connection fault. */
  it("tells the cook that pressing again will not help", async () => {
    result = { data: null, error: refused };

    expect(await moveOrder(AN_ORDER, "new", "preparing")).toEqual({
      error: MOVE_REFUSED_BY_DATABASE,
    });
  });

  it("tells them to press again when it was anything else", async () => {
    result = { data: null, error: { ...refused, code: "08006", message: "connection lost", details: "" } };

    expect(await moveOrder(AN_ORDER, "new", "preparing")).toEqual({
      error: MOVE_WRITE_FAILED,
    });
  });

  /* Nothing Postgres wrote reaches a screen, and nothing Postgres wrote
     reaches a log either: `details` on this table carries the failing
     row, which is the caller's name and the number they left. */
  it("puts the caller's name and number in neither the answer nor the log", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    result = { data: null, error: refused };

    const outcome = await moveOrder(AN_ORDER, "new", "preparing");

    expect(JSON.stringify(outcome)).not.toContain("Phi");
    expect(JSON.stringify(outcome)).not.toContain("510");
    expect(logged).toHaveBeenCalledTimes(1);
    const said = JSON.stringify(logged.mock.calls[0]);
    expect(said).toContain("42501");
    expect(said).not.toContain("Phi");
    expect(said).not.toContain("510");
    expect(said).not.toContain("Failing row contains");
    logged.mockRestore();
  });

  /* A refused write left the row where it was, and the screen is already
     showing that row correctly -- repainting it would only cost a read
     and could not change anything. What the cook needs is the sentence,
     which is what they get. */
  it("does not pretend the board changed", async () => {
    result = { data: null, error: refused };

    await moveOrder(AN_ORDER, "new", "preparing");

    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
