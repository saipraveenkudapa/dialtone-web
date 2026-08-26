import { describe, expect, it } from "vitest";
import { orderEventActor, orderEventTitle } from "@/lib/orders/history";

/** The two translations that make `order_status_events` legible.
 *
 *  That table is written on every status change and, until this feature,
 *  was read by NOTHING in the product -- it appeared in this repository
 *  only inside comments. So these are first renderings, not adjustments
 *  to an existing one, and both of them are decisions about what a
 *  restaurant is allowed to be told.
 *
 *  Pure, so no database and no DOM: the module imports nothing but a
 *  type.
 */

describe("what a row of order_status_events says happened", () => {
  it("names the press that was made, in the board's own words", () => {
    expect(orderEventTitle("new", "preparing")).toBe("Started cooking");
    expect(orderEventTitle("confirmed", "preparing")).toBe("Started cooking");
    expect(orderEventTitle("preparing", "ready")).toBe("Marked ready");
    expect(orderEventTitle("ready", "completed")).toBe("Picked up");
  });

  /* Both ways back are offered on the board (ORDER_MOVES), and both are
     ordinary mid-service events. The log has to tell them apart from the
     forward move they undo, or a ticket walked forward and back reads as
     two identical lines. */
  it("tells a step back apart from the step it undoes", () => {
    expect(orderEventTitle("preparing", "new")).toBe("Put back to New");
    expect(orderEventTitle("ready", "preparing")).toBe("Back in the kitchen");
  });

  /* A null `from` is app.log_order_status's AFTER INSERT arm: the order
     row being created, which on every order this product has taken is a
     caller on the phone. */
  it("reads the first row of every order's log as the order arriving", () => {
    expect(orderEventTitle(null, "new")).toBe("Placed");
    expect(orderEventTitle(null, "completed")).toBe("Placed");
  });

  /* Nothing in this product writes 'cancelled' -- lib/orders/moves.ts
     offers no press that reaches it -- but `orders_rw` is `for all to
     authenticated`, so the log can hold one and the screen may not
     render it as a blank line. */
  it("has words for the two statuses the board itself never writes", () => {
    expect(orderEventTitle("ready", "cancelled")).toBe("Cancelled");
    expect(orderEventTitle("new", "confirmed")).toBe("Confirmed");
  });
});

describe("who the uuid in changed_by is", () => {
  const ME = "11111111-1111-1111-1111-111111111111";
  const BOSS = "22222222-2222-2222-2222-222222222222";
  const COOK = "33333333-3333-3333-3333-333333333333";
  const GONE = "44444444-4444-4444-4444-444444444444";

  const roles = { [ME]: "manager", [BOSS]: "owner", [COOK]: "manager" } as const;

  /* THE ONE RULE THIS WHOLE FUNCTION EXISTS FOR. `changed_by` is a uuid
     referencing auth.users, and auth.users is not readable by a
     restaurant on its own session at all -- no policy, not exposed
     through PostgREST -- while a service-role lookup is not something an
     owner's screen may do. So there is no name to print, and printing
     the uuid would be printing the fact that we could not answer. */
  it("never renders the uuid itself", () => {
    for (const who of [null, ME, BOSS, COOK, GONE]) {
      const said = orderEventActor(who, ME, roles);
      if (who) expect(said).not.toContain(who);
      expect(said).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
    }
  });

  it("says so when it was the person reading the screen", () => {
    expect(orderEventActor(ME, ME, roles)).toBe("you");
  });

  /* `memberships` IS readable on the owner's own session -- RLS's
     membership_read_own allows any member of the org to read its rows --
     and `role` is the one thing about a colleague the database can
     actually supply. In a restaurant with one owner, that is a name. */
  it("gives a colleague the role the database can supply, and no more", () => {
    expect(orderEventActor(BOSS, ME, roles)).toBe("an owner");
    expect(orderEventActor(COOK, ME, roles)).toBe("a manager");
  });

  /* A null uuid is app.log_order_status running under a token with no
     `sub` claim, which is every write on the agent's path: place_order is
     SECURITY DEFINER and is called with the per-call agent_service token.
     Not "unknown" -- the order being taken on the phone. */
  it("says the agent took it when nobody was signed in", () => {
    expect(orderEventActor(null, ME, roles)).toBe("the agent, on the call");
  });

  /* The uuid held a membership when it wrote -- `orders_rw` requires one
     to change a status at all -- so a uuid with no membership row now is
     somebody who has since left. Said plainly rather than as "unknown",
     which would read as a fault in the log rather than as staff
     turnover. */
  it("says a colleague has left rather than inventing a name for them", () => {
    expect(orderEventActor(GONE, ME, roles)).toBe("someone who has left this restaurant");
  });

  /* Signed out is not a state this screen renders in -- the middleware
     will not load it -- but "you" must never be the answer for a uuid
     that merely failed to compare against nothing. */
  it("does not call a stranger 'you' when there is no viewer to compare against", () => {
    expect(orderEventActor(BOSS, null, roles)).toBe("an owner");
    expect(orderEventActor(GONE, null, roles)).toBe("someone who has left this restaurant");
  });
});
