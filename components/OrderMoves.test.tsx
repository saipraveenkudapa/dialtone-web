import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ORDER_BOARD_COLUMN, ORDER_BOARD_COLUMNS } from "@/lib/format";
import {
  MOVE_ALREADY_MOVED,
  MOVE_REFUSED_BY_DATABASE,
  MOVE_WRITE_FAILED,
} from "@/lib/orders/moves";
import type { OrderStatus } from "@/lib/supabase/types";

/* THE TICKET CONTROL, PRESSED.
 *
 * Why this file is not under lib/ with the rest of the Orders screen.
 * lib/orders/screen.test.ts renders the board to static markup, which is
 * the right tool for what a cook READS -- the words, the columns, which
 * button is on which card. It cannot ask the only question that decides
 * whether this control should have shipped at all: what happens when the
 * press does not land.
 *
 * The board withheld this button on purpose for as long as nothing wrote
 * `orders.status`, on the argument that a cook who presses "Start
 * cooking" and watches the ticket stay put has been told the next cook
 * knows, and the next cook does not. A button that fails silently is that
 * same lie with a control on top of it. So: vitest.config.ts's "jsdom"
 * project, real clicks, a server action double that can be told to refuse
 * the way the database refuses, and assertions about what is on the card
 * afterwards.
 */

const moveOrder = vi.fn();
vi.mock("@/app/dashboard/orders/actions", () => ({ moveOrder }));

const { OrderMoves, OrderMovesRegion } = await import("@/components/OrderMoves");

/* React's own switch for act(), the same declaration
   components/MenuEditor.pick.test.tsx makes and for the same reason:
   globalThis has no index signature under `strict`, and a global
   augmentation has to be `var`. */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const AN_ORDER = "8f0f8c6e-0000-4000-8000-000000000000";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  moveOrder.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** One ticket, inside the region that holds what its last press was
 *  refused with. The region is not optional -- the control throws
 *  without it -- because a board that forgot to wrap itself would be a
 *  control that swallows refusals on the screen and nowhere else. */
async function mount(status: OrderStatus) {
  await act(async () => {
    root.render(
      <OrderMovesRegion onBoard={[AN_ORDER]}>
        <OrderMoves orderId={AN_ORDER} orderNumber={1001} status={status} />
      </OrderMovesRegion>,
    );
  });
}

/** THE BOARD AS THE PAGE ACTUALLY DRAWS IT: three columns, each its own
 *  <section>, the ticket inside whichever one its status belongs to --
 *  app/dashboard/orders/page.tsx, and the same ORDER_BOARD_COLUMN it maps
 *  with rather than a second copy of that map.
 *
 *  Mounting the control on its own cannot ask the question these tests
 *  need. A ticket that changes status changes PARENT, and React does not
 *  move an instance between parents: it unmounts the card and mounts a
 *  new one. Anything the old card was holding goes with it. So the
 *  repaint has to be rendered, not simulated. */
async function board(status: OrderStatus, onBoard: string[] = [AN_ORDER]) {
  await act(async () => {
    root.render(
      <OrderMovesRegion onBoard={onBoard}>
        {ORDER_BOARD_COLUMNS.map((column) => (
          <section key={column.key} data-column={column.key}>
            {ORDER_BOARD_COLUMN[status] === column.key ? (
              <OrderMoves orderId={AN_ORDER} orderNumber={1001} status={status} />
            ) : null}
          </section>
        ))}
      </OrderMovesRegion>,
    );
  });
}

/** Which column the sentence is drawn in, or "" when it is outside the
 *  columns altogether -- which is where the region puts it. */
const saidIn = () =>
  container.querySelector(".auth-error")?.closest("section")?.dataset.column ?? "";

const buttons = () => [...container.querySelectorAll("button")];
const labels = () => buttons().map((b) => b.textContent);

function button(label: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent === label);
  if (!found) throw new Error(`no button reading "${label}" — found ${JSON.stringify(labels())}`);
  return found;
}

async function press(label: string) {
  await act(async () => {
    button(label).click();
  });
}

/** What the card says under its buttons, which on a refusal is the whole
 *  of what a cook is told. */
const said = () => container.querySelector(".auth-error")?.textContent ?? "";

describe("a ticket nobody has started", () => {
  it("offers the one press the design draws, and no way back from a column with nothing behind it", async () => {
    await mount("new");

    expect(labels()).toEqual(["Start cooking"]);
  });

  it("sends the status the cook was looking at, not just the one they want", async () => {
    await mount("new");
    await press("Start cooking");

    // The action narrows the UPDATE on both, so a ticket somebody else
    // already started is not dragged back by a press aimed at the card as
    // it used to be.
    expect(moveOrder).toHaveBeenCalledWith(AN_ORDER, "new", "preparing");
  });

  it("names the order it belongs to for anyone who cannot see which card it is on", async () => {
    await mount("new");

    expect(button("Start cooking").getAttribute("aria-label")).toBe(
      "Start cooking, order #1001",
    );
  });
});

describe("a ticket in the kitchen", () => {
  it("offers the way on and the way back", async () => {
    await mount("preparing");

    expect(labels()).toEqual(["Mark ready", "Not started after all"]);
  });

  /* A ticket started by mistake mid-service is an ordinary event -- two
     cooks, one tablet at the pass. Without this the only correction
     available is the board saying one thing and the kitchen doing
     another, which is what the screen exists to prevent. */
  it("un-starts it when the way back is pressed", async () => {
    await mount("preparing");
    await press("Not started after all");

    expect(moveOrder).toHaveBeenCalledWith(AN_ORDER, "preparing", "new");
  });

  it("draws the way back as the quieter of the two", async () => {
    await mount("preparing");

    expect(button("Mark ready").className).toContain("btn-secondary");
    expect(button("Not started after all").className).toContain("btn-ghost");
  });
});

describe("food on the pass", () => {
  it("finishes the order, and can put it back in the kitchen", async () => {
    await mount("ready");

    expect(labels()).toEqual(["Picked up", "Back in the kitchen"]);

    await press("Picked up");
    expect(moveOrder).toHaveBeenCalledWith(AN_ORDER, "ready", "completed");
  });
});

describe("a ticket that has left the board", () => {
  it("carries no control at all", async () => {
    await mount("completed");
    expect(container.innerHTML).toBe("");

    await mount("cancelled");
    expect(container.innerHTML).toBe("");
  });
});

describe("a press the database refuses", () => {
  /* THE ASSERTION THIS WHOLE FILE EXISTS FOR. The card cannot go quiet:
     the ticket is still in the column it was in, and the cook has to know
     that rather than walk away believing the next cook has been told. */
  it("says so on the ticket rather than leaving it silently where it was", async () => {
    moveOrder.mockResolvedValue({ error: MOVE_REFUSED_BY_DATABASE });

    await mount("new");
    await press("Start cooking");

    expect(said()).toBe(MOVE_REFUSED_BY_DATABASE);
    // Still the same press on offer, because the ticket has not moved.
    expect(labels()).toEqual(["Start cooking"]);
  });

  it("announces it, rather than only drawing it", async () => {
    moveOrder.mockResolvedValue({ error: MOVE_WRITE_FAILED });

    await mount("new");
    await press("Start cooking");

    const note = container.querySelector(".auth-error");
    expect(note?.getAttribute("role")).toBe("status");
    expect(note?.getAttribute("aria-live")).toBe("polite");
  });

  it("says which refusal it was, and not one sentence for all of them", async () => {
    moveOrder.mockResolvedValue({ error: MOVE_ALREADY_MOVED });

    await mount("preparing");
    await press("Mark ready");

    expect(said()).toBe(MOVE_ALREADY_MOVED);
  });

  /* A sentence about the press before last, sitting under a button that
     has since worked, is a ticket telling a kitchen something that is no
     longer true. */
  it("takes the sentence away again when the next press lands", async () => {
    moveOrder.mockResolvedValue({ error: MOVE_WRITE_FAILED });
    await mount("new");
    await press("Start cooking");
    expect(said()).toBe(MOVE_WRITE_FAILED);

    moveOrder.mockResolvedValue({ ok: true });
    await press("Start cooking");

    expect(said()).toBe("");
  });

  it("says nothing at all until something has been refused", async () => {
    await mount("new");

    expect(container.querySelector(".auth-error")).toBeNull();
  });
});

describe("a board that forgot to wrap itself", () => {
  /* The region is not decoration and not optional: without it the
     control has nowhere to keep what a press was refused with, and the
     failure would be invisible -- a button that works right up until
     something goes wrong. So it fails at the first render instead, where
     the page's own test (lib/orders/screen.test.ts renders the whole
     board) catches it, rather than on a pass. */
  it("says so rather than quietly losing every refusal", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      act(async () => {
        root.render(<OrderMoves orderId={AN_ORDER} orderNumber={1001} status="new" />);
      }),
    ).rejects.toThrow("OrderMovesRegion");

    quiet.mockRestore();
  });
});

describe("a press that never reached the action at all", () => {
  /* NOT the same as a write the database refused, and this is the case
     the file was missing. A server action is a POST: a tablet at a pass
     that has wandered off the wifi, a 500, or an action id that no longer
     resolves after a deploy while the board was left open all REJECT --
     they do not come back as a result with an error in it. Uncaught,
     React 19 rethrows a rejected transition into the render pass, and
     with no error boundary over /dashboard the whole subtree is torn out:
     the cook is not merely told nothing, the ticket disappears and takes
     the board with it. */
  it("says so on the ticket rather than taking the board off the screen", async () => {
    moveOrder.mockRejectedValue(new Error("Failed to fetch"));

    await mount("new");
    await press("Start cooking");

    // The card is still there, which is the first half of it.
    expect(labels()).toEqual(["Start cooking"]);
    // And it says the one thing that is true: press again.
    expect(said()).toBe(MOVE_WRITE_FAILED);
    expect(button("Start cooking").disabled).toBe(false);
  });

  it("takes the sentence away again when the next press gets through", async () => {
    moveOrder.mockRejectedValue(new Error("Failed to fetch"));
    await mount("new");
    await press("Start cooking");
    expect(said()).toBe(MOVE_WRITE_FAILED);

    moveOrder.mockResolvedValue({ ok: true });
    await press("Start cooking");

    expect(said()).toBe("");
  });
});

describe("the ticket another screen moved first", () => {
  /* THE REFUSAL THAT OUTLIVES ITS OWN CARD. Two cooks, one ticket: the
     loser's write matches no row, so the action repaints the board before
     it answers -- the card must not sit in the column it was pressed in.
     That repaint is exactly what would destroy the explanation if the
     sentence were held on the card, and the cook who lost the race is the
     one person who needs it. */
  it("still says why, on the card, after the repaint has moved it", async () => {
    moveOrder.mockResolvedValue({ error: MOVE_ALREADY_MOVED });

    await board("new");
    await press("Start cooking");

    expect(said()).toBe(MOVE_ALREADY_MOVED);
    expect(saidIn()).toBe("new");

    // The repaint the action asked for: the row is 'preparing' now, so
    // the page draws the card in another column -- a different parent,
    // and so a different instance of the control.
    await board("preparing");

    expect(labels()).toEqual(["Mark ready", "Not started after all"]);
    // Moved with the ticket, and still there.
    expect(saidIn()).toBe("kitchen");
    expect(said()).toBe(MOVE_ALREADY_MOVED);
  });

  /* Somebody else pressed "Picked up": 'completed' has no column on this
     board, so there is no card left to carry anything. The board says it
     instead, and names the ticket, because a press that produced neither
     a card nor a sentence produced nothing a cook can act on. */
  it("says it above the board, naming the ticket, when the card has gone", async () => {
    moveOrder.mockResolvedValue({ error: MOVE_ALREADY_MOVED });

    await board("ready");
    await press("Picked up");
    await board("completed", []);

    expect(container.querySelector("button")).toBeNull();
    expect(said()).toBe(`#1001: ${MOVE_ALREADY_MOVED}`);
    // Outside the columns: there is no column it belongs to any more.
    expect(saidIn()).toBe("");
  });

  /* And not twice. While the ticket still has a card, the card is the
     only place the sentence is drawn -- a kitchen reading the same
     refusal in two places has to work out whether it is one ticket or
     two. */
  it("says it once, on the card, while the card is still on the board", async () => {
    moveOrder.mockResolvedValue({ error: MOVE_REFUSED_BY_DATABASE });

    await board("new");
    await press("Start cooking");

    expect(container.querySelectorAll(".auth-error")).toHaveLength(1);
    expect(saidIn()).toBe("new");
  });
});

describe("while the write is still in flight", () => {
  /* Mid-service a double press is a thumb resting on a tablet, and the
     second press would be aimed at a status the card no longer has --
     which the action refuses, so the cook would be shown a refusal for a
     move that actually worked. Both buttons go down, not just the one
     pressed. */
  it("takes no second press, on either button", async () => {
    let settle: (value: { ok: true }) => void = () => {};
    moveOrder.mockImplementation(
      () => new Promise<{ ok: true }>((resolve) => (settle = resolve)),
    );

    await mount("preparing");
    await press("Mark ready");

    expect(button("Mark ready").disabled).toBe(true);
    expect(button("Not started after all").disabled).toBe(true);
    expect(moveOrder).toHaveBeenCalledTimes(1);

    await act(async () => settle({ ok: true }));

    expect(button("Mark ready").disabled).toBe(false);
  });
});
