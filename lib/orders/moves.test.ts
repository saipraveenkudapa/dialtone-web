import { describe, expect, it } from "vitest";
import {
  MOVE_REFUSED_BY_DATABASE,
  MOVE_WRITE_FAILED,
  ORDER_MOVES,
  isOrderStatus,
  moveRefusal,
  orderMove,
} from "@/lib/orders/moves";
import { ORDER_BOARD_COLUMN } from "@/lib/format";
import type { OrderStatus } from "@/lib/supabase/types";

/** THE RULES A TICKET MOVES BY.
 *
 *  Everything a cook may do to an order goes through this table, and so
 *  does everything the server will accept: the browser sends a pair of
 *  statuses and `orderMove` decides, server-side, whether that pair is a
 *  step this product takes. A "use server" export is a live HTTP endpoint
 *  from the moment it compiles, so what is asserted here is not what the
 *  buttons happen to offer -- it is the whole of what is reachable.
 */

const EVERY_STATUS = Object.keys(ORDER_MOVES) as OrderStatus[];

describe("the way forward", () => {
  it("takes a ticket one column at a time, in the design's own words", () => {
    expect(orderMove("new", "preparing")?.label).toBe("Start cooking");
    expect(orderMove("preparing", "ready")?.label).toBe("Mark ready");
    expect(orderMove("ready", "completed")?.label).toBe("Picked up");
  });

  /* Nothing writes 'confirmed' today, but the board puts it in the same
     column as 'new' -- both mean a ticket nobody has started -- so it has
     to offer the same press. A status that renders in a column and then
     refuses that column's button is a card a cook cannot move at all. */
  it("starts a confirmed ticket the same way it starts a new one", () => {
    expect(orderMove("confirmed", "preparing")?.label).toBe("Start cooking");
  });

  /* THE CLAIM THAT MAKES THIS SAFE TO DRIVE FROM A FORM. A press cannot
     name its own destination: only the pairs in the table exist, so there
     is no jump from the first column to a finished order and no way to
     reach either off-board status except through the column in front of
     it. */
  it("has no path that skips the kitchen", () => {
    expect(orderMove("new", "ready")).toBeNull();
    expect(orderMove("new", "completed")).toBeNull();
    expect(orderMove("confirmed", "completed")).toBeNull();
    expect(orderMove("preparing", "completed")).toBeNull();
  });

  /* Cancelling somebody's dinner is not a kitchen press. It is not on the
     board, so it is not in the table, so no request can produce it --
     including one that never came from the board at all. */
  it("cannot cancel an order from any status whatsoever", () => {
    for (const from of EVERY_STATUS) {
      expect(orderMove(from, "cancelled")).toBeNull();
    }
  });
});

describe("the way back", () => {
  /* A ticket started by mistake mid-service is an ordinary event, and
     without this the only correction available is the board saying one
     thing while the kitchen does another -- which is the failure the
     whole screen exists to prevent. */
  it("un-starts a ticket that was started by mistake", () => {
    expect(orderMove("preparing", "new")?.direction).toBe("back");
  });

  it("puts food back in the kitchen when it was called ready and was not", () => {
    expect(orderMove("ready", "preparing")?.direction).toBe("back");
  });

  /* Every back move is the exact reverse of a forward move, so the two
     controls on a card can never disagree about where the card came
     from. This is the invariant that a later "add one more transition"
     pass would break first. */
  it("is always the reverse of a step that was offered forwards", () => {
    for (const from of EVERY_STATUS) {
      for (const move of ORDER_MOVES[from].filter((m) => m.direction === "back")) {
        const forward = orderMove(move.to, from);
        expect(forward).not.toBeNull();
        expect(forward?.direction).toBe("forward");
      }
    }
  });

  it("is not offered from the first column, which has nothing behind it", () => {
    expect(ORDER_MOVES.new.some((m) => m.direction === "back")).toBe(false);
    expect(ORDER_MOVES.confirmed.some((m) => m.direction === "back")).toBe(false);
  });
});

describe("a ticket that has left the board", () => {
  /* 'completed' and 'cancelled' have no column on the approved design, so
     there is no card to press. Offering moves out of them would be a
     control on a ticket nobody can see -- and it would let a form still
     open on a tablet since before the order was finished move it again. */
  it("offers nothing at all, in either direction", () => {
    expect(ORDER_MOVES.completed).toEqual([]);
    expect(ORDER_MOVES.cancelled).toEqual([]);
    expect(orderMove("completed", "ready")).toBeNull();
    expect(orderMove("cancelled", "new")).toBeNull();
  });

  it("is what 'Picked up' produces, so that press is the one that clears the board", () => {
    const pickedUp = orderMove("ready", "completed");
    expect(pickedUp).not.toBeNull();
    expect(ORDER_BOARD_COLUMN[pickedUp!.to]).toBeNull();
  });
});

describe("every move the board offers", () => {
  /* A move whose destination has no column would take a card off the
     board without saying so. Exactly one does -- "Picked up" -- and the
     test above is the one that names it, so any OTHER move that started
     doing the same thing fails here. */
  it("lands somewhere a cook can see, except the one that finishes the order", () => {
    for (const from of EVERY_STATUS) {
      for (const move of ORDER_MOVES[from]) {
        if (move.to === "completed") continue;
        expect(ORDER_BOARD_COLUMN[move.to]).not.toBeNull();
      }
    }
  });

  it("is a real status, and never a status that stays where it is", () => {
    for (const from of EVERY_STATUS) {
      for (const move of ORDER_MOVES[from]) {
        expect(isOrderStatus(move.to)).toBe(true);
        expect(move.to).not.toBe(from);
      }
    }
  });

  it("says something a cook could act on, once each per card", () => {
    for (const from of EVERY_STATUS) {
      const labels = ORDER_MOVES[from].map((m) => m.label);
      expect(new Set(labels).size).toBe(labels.length);
      for (const label of labels) expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("a status off the wire", () => {
  it("is only a status if the schema says so", () => {
    expect(isOrderStatus("preparing")).toBe(true);
    expect(isOrderStatus("PREPARING")).toBe(false);
    expect(isOrderStatus("delivered")).toBe(false);
    expect(isOrderStatus("")).toBe(false);
    expect(isOrderStatus(null)).toBe(false);
    expect(isOrderStatus(undefined)).toBe(false);
    expect(isOrderStatus(7)).toBe(false);
  });

  /* Object.hasOwn, not `in`: "constructor" and "toString" are on every
     object's prototype chain and neither is an order status. */
  it("is not a name Object.prototype happens to carry", () => {
    expect(isOrderStatus("constructor")).toBe(false);
    expect(isOrderStatus("toString")).toBe(false);
  });
});

describe("what a cook is told when the write comes back refused", () => {
  /* 42501 is what a missing grant and a row-level security policy both
     raise, and on this write it means the audit trigger could not log the
     change -- i.e. the migration behind this feature has not been applied
     yet. Every press will fail identically until it is, so the sentence
     must not send a kitchen looking for a network fault. */
  it("says pressing again will not help when the database refused it outright", () => {
    expect(moveRefusal("42501")).toBe(MOVE_REFUSED_BY_DATABASE);
    expect(MOVE_REFUSED_BY_DATABASE).toContain("Pressing again will not help");
  });

  it("says to press again when it was anything else", () => {
    expect(moveRefusal("08006")).toBe(MOVE_WRITE_FAILED);
    expect(moveRefusal(null)).toBe(MOVE_WRITE_FAILED);
    expect(moveRefusal(undefined)).toBe(MOVE_WRITE_FAILED);
  });

  /* A PostgrestError's message, details and hint name columns,
     constraints and sometimes the failing row -- which on `orders` is the
     caller's name and their phone number. Only the code is ever read, so
     only these fixed sentences can reach a screen. */
  it("never says anything the database wrote", () => {
    const fromPostgres =
      'new row violates row-level security policy for table "order_status_events"';
    expect(moveRefusal("42501")).not.toContain(fromPostgres);
    expect(moveRefusal("42501")).not.toContain("order_status_events");
    expect(moveRefusal("23505")).not.toContain("Failing row contains");
  });
});
