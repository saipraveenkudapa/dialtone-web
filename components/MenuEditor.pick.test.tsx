import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ONE_CHEFS_SPECIAL_REFUSAL,
  PICK_CAP_REFUSAL,
  PICK_WRITE_FAILED,
} from "@/lib/menu";
import type { MenuCategoryWithItems } from "@/lib/data";
import type { MenuItemRow, PickLabel, SoldOutUntil } from "@/lib/supabase/types";

/* THE RESTAURANT'S OWN PICK CONTROL, driven rather than read.
 *
 * WHY THIS FILE IS NOT UNDER lib/. The operator's identical control is
 * asserted in lib/admin/edit-screen.test.ts by rendering MenuAdmin to
 * static markup, and that is the right tool there: MenuAdmin takes its
 * write as a prop, so what a render can see -- which options are shut,
 * what the chip says -- is nearly the whole of it.
 *
 * The owner's cannot be tested that way, because the owner's transport
 * IS the thing under test. MenuStore writes through supabaseBrowser() as
 * the signed-in user, and the four claims that matter are all about what
 * crosses that wire and what comes back:
 *
 *   * the write carries pick_label and NOTHING else, so a pick cannot
 *     ride along with a description and a description cannot clear a
 *     pick;
 *   * 23514 and 23505 arrive as two different sentences, because the
 *     database is the enforcement here -- the greyed options are only a
 *     courtesy drawn from rows this browser happens to hold;
 *   * a refusal puts the row back, since the write is optimistic like
 *     every other write on this screen;
 *   * a pick set by the OPERATOR, through an entirely different
 *     transport, lands on the owner's open screen through the realtime
 *     subscription.
 *
 * None of those exist in one render's markup. So: vitest.config.ts's
 * "jsdom" project, a real <select> changed with a real change event, and
 * a Supabase double that records what it was asked to write and can be
 * told to refuse it the way Postgres would.
 */

/* ── the wire ──────────────────────────────────────────────────────── */

type Refusal = { code?: string; message?: string; details?: string } | null;

/** Every update the screen actually sent, in order. */
const writes: { table: string; values: Record<string, unknown>; id: string }[] = [];
/** What the next write comes back with. Cleared as it is served, so a
 *  test arms exactly one refusal and the write after it succeeds. */
let refusal: Refusal = null;
/** The realtime handler MenuStore registered, i.e. the operator's way in. */
let arrive: ((payload: { new: MenuItemRow }) => void) | null = null;

const channel = {
  on(
    _event: unknown,
    _filter: unknown,
    handler: (payload: { new: MenuItemRow }) => void,
  ) {
    arrive = handler;
    return channel;
  },
  subscribe(cb: (status: string) => void) {
    cb("SUBSCRIBED");
    return channel;
  },
};

const client = {
  from(table: string) {
    return {
      update(values: Record<string, unknown>) {
        return {
          eq(_column: string, id: string) {
            writes.push({ table, values, id });
            const error = refusal;
            refusal = null;
            return Promise.resolve({ error });
          },
        };
      },
      /* Not a pick write, and here for one reason: Remove is a writer
         that DOES use the store-wide `error` channel, which is what
         lets a test arm a stale banner and then watch a pick that lands
         clear it. Recorded like any other write so the assertion that a
         pick sends pick_label alone still sees everything sent. */
      delete() {
        return {
          eq(_column: string, id: string) {
            writes.push({ table, values: { __delete: true }, id });
            const error = refusal;
            refusal = null;
            return Promise.resolve({ error });
          },
        };
      },
    };
  },
  channel: () => channel,
  removeChannel: () => {},
};

vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => client }));
/* The socket's token priming. Real in the product, nothing here: this
   suite's channel is the double above. */
vi.mock("@/lib/supabase/realtime", () => ({
  primeRealtimeAuth: () => Promise.resolve(null),
}));

const { MenuProvider, useMenu } = await import("@/components/MenuStore");
const { MenuEditor } = await import("@/components/MenuEditor");

/* ManagerScreen's SyncNote, to the line (ManagerScreen.tsx:31-32): the
 * store-wide `error` is rendered INSTEAD of the sync status, and nothing
 * clears it until the next write. Reproduced rather than imported
 * because the real one wants the AgentStatus context and a timezone,
 * and neither is what is under test here -- what is under test is which
 * channel a refused pick lands in. MenuProvider is mounted in
 * app/dashboard/layout.tsx, so this really is the same store instance
 * the mid-service screen reads. */
function SyncNoteStandIn() {
  const { lastChangeAt, error } = useMenu();
  if (error) return <b data-sync-note="">{error}</b>;
  return (
    <b data-sync-note="">
      {lastChangeAt ? "Saved · live on the next call" : "In sync. Every call reads this list fresh."}
    </b>
  );
}

/* ── the restaurant ────────────────────────────────────────────────── */

const LOCATION = "d7be1400-7c38-4933-a248-407ff339cd73";
const CATEGORY = "c0000000-0000-0000-0000-0000000000c1";

function dish(
  name: string,
  pick: PickLabel | null,
  soldOut: SoldOutUntil | null = null,
): MenuItemRow {
  return {
    id: `item-${name.toLowerCase().replace(/[^a-z]+/g, "-")}`,
    category_id: CATEGORY,
    location_id: LOCATION,
    name,
    description: null,
    price_cents: 2200,
    sold_out_until: soldOut,
    pick_label: pick,
    allergen_note: null,
    sort_order: 0,
    updated_at: "2026-08-18T12:00:00.000Z",
  };
}

function menu(...items: MenuItemRow[]): MenuCategoryWithItems[] {
  return [
    {
      id: CATEGORY,
      location_id: LOCATION,
      name: "Primi",
      sort_order: 0,
      created_at: "2026-08-18T12:00:00.000Z",
      items: items.map((item, i) => ({ ...item, sort_order: i })),
    },
  ];
}

/* React's own switch for act(): without it every act() call warns that
   the test environment was not configured for it. Declared rather than
   cast because globalThis has no index signature under `strict`. */
declare global {
  // `var` and not let/const: a global augmentation has to be one.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  writes.length = 0;
  refusal = null;
  arrive = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Mounted and settled. `await`, not a bare act(): MenuStore subscribes
 *  from inside an async effect that primes the socket's token first, so
 *  the channel -- and with it the operator's way in below -- exists only
 *  after that microtask has run. */
async function mount(categories: MenuCategoryWithItems[]) {
  await act(async () => {
    root.render(
      <MenuProvider locationId={LOCATION} initialCategories={categories}>
        <MenuEditor />
      </MenuProvider>,
    );
  });
}

/** The same store, with the mid-service screen's sync line beside the
 *  editor -- which is the real arrangement, one route apart under a
 *  provider that outlives both. */
async function mountWithSyncNote(categories: MenuCategoryWithItems[]) {
  await act(async () => {
    root.render(
      <MenuProvider locationId={LOCATION} initialCategories={categories}>
        <MenuEditor />
        <SyncNoteStandIn />
      </MenuProvider>,
    );
  });
}

const syncNote = () => container.querySelector("[data-sync-note]")?.textContent ?? "";

/** The pick control on one dish's row, by the name a screen reader
 *  announces it with. */
function control(name: string): HTMLSelectElement {
  const found = container.querySelector<HTMLSelectElement>(
    `select[aria-label="${name} as a pick"]`,
  );
  if (!found) throw new Error(`no pick control on "${name}"`);
  return found;
}

function option(select: HTMLSelectElement, value: string): HTMLOptionElement {
  const found = Array.from(select.options).find((o) => o.value === value);
  if (!found) throw new Error(`no "${value}" option`);
  return found;
}

/** A real change on a real <select>, dispatched. React listens for
 *  "change" on a select unconditionally -- there is no value-tracker
 *  comparison in that path, which is why setting .value first is enough
 *  here where it would not be on a text input. */
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(label: string, within: ParentNode = container) {
  const button = Array.from(within.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button) throw new Error(`no "${label}" button`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const said = () => container.textContent ?? "";

/* ── what the owner can see ────────────────────────────────────────── */

describe("the picks a restaurant can see on its own menu", () => {
  it("shows which of its dishes are picks, and which kind, without opening one", async () => {
    /* The whole of the reported defect: the owner dashboard said nothing
       about picks anywhere, so a restaurant could not see that the agent
       was praising a dish, let alone which one. The kind is on the row,
       at rest, on every dish -- not behind an Edit button, for the same
       reason the operator's is not. */
    await mount(menu(dish("Carbonara", "best_seller"), dish("Osso Buco", "chefs_special"), dish("Tiramisu", null)));

    expect(control("Carbonara").value).toBe("best_seller");
    expect(control("Osso Buco").value).toBe("chefs_special");
    expect(control("Tiramisu").value).toBe("");

    // In the owner's words, not the column's codes.
    expect(said()).toContain("Best seller");
    expect(said()).toContain("Chef’s special");
    expect(said()).toContain("Not a pick");
  });

  it("names the dishes holding the three slots", async () => {
    // A rule that says three are taken without saying WHICH three sends
    // an owner hunting their own menu for the one to clear.
    await mount(
      menu(
        dish("Carbonara", "best_seller"),
        dish("Amatriciana", "best_seller"),
        dish("Osso Buco", "chefs_special"),
        dish("Tiramisu", null),
      ),
    );
    // The names in one run of text -- which the table, one dish to a
    // row, cannot produce. Only the note can.
    expect(said()).toContain("Carbonara, Amatriciana, Osso Buco");
  });

  it("says a sold-out pick reaches nobody", async () => {
    /* lib/agent/menu.ts drops `pick` from the payload while the dish is
       out -- praising a dish and refusing it in one breath is worse than
       silence -- but the slot is still spent. Three spent slots can add
       up to no warmth at all, and the restaurant has to be able to see
       why. */
    await mount(menu(dish("Branzino", "best_seller", "close")));
    expect(said()).toMatch(/sold out/i);
    expect(control("Branzino").value).toBe("best_seller");
  });

  it("says the pick is live on the next call, with nothing to re-push", async () => {
    // The claim the surrounding copy already makes about a price.
    await mount(menu(dish("Carbonara", null)));
    expect(said()).toMatch(/next call/i);
  });

  it("binds “once” to the dish and not to the call", async () => {
    /* lib/agent/prompt.ts's rule is once per PICKED DISH, at most twice
       in a whole call. "once on a call ... and at most twice in a whole
       call" said both of those in one sentence, and an owner who catches
       a screen contradicting itself stops believing the two rules after
       it -- the cap and the one-special rule, which are the two they
       have to act on. This is the operator's wording, word for word. */
    await mount(menu(dish("Carbonara", "best_seller")));
    expect(said()).toContain(
      "The agent may say once that a picked dish is one of your best sellers",
    );
    expect(said()).toContain("at most twice in a whole call");
    expect(said()).not.toMatch(/once on a call/i);
  });

  it("names the dish that already holds the chef’s special", async () => {
    /* The one dish among forty, and the harder of the two to find by
       eye. Two picks used, so the cap clause is silent -- this clause
       stands on its own condition, which is the whole point: with the
       cap not binding, "Chef's special" is still greyed on every other
       row and this is the only thing on screen that explains it. The
       refusal that would name the holder is unreachable from here
       precisely because the option is shut. */
    await mount(
      menu(
        dish("Carbonara", "best_seller"),
        dish("Osso Buco", "chefs_special"),
        dish("Tiramisu", null),
      ),
    );

    expect(said()).toContain(
      "“Osso Buco” is already your chef’s special, so that choice is offered on that dish alone.",
    );
    expect(said()).not.toContain("All three are taken");
    // The greyed control that sentence is there to account for.
    expect(option(control("Tiramisu"), "chefs_special").disabled).toBe(true);
  });

  it("says nothing about a chef’s special when no dish holds it", async () => {
    await mount(menu(dish("Carbonara", "best_seller"), dish("Tiramisu", null)));
    expect(said()).not.toContain("is already your chef’s special");
    expect(option(control("Tiramisu"), "chefs_special").disabled).toBe(false);
  });
});

/* ── what crosses the wire ─────────────────────────────────────────── */

describe("setting a pick from the owner's menu", () => {
  it("writes pick_label, on that dish, and writes nothing else", async () => {
    await mount(menu(dish("Carbonara", null), dish("Tiramisu", null)));
    await choose(control("Carbonara"), "best_seller");

    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe("menu_items");
    expect(writes[0].id).toBe("item-carbonara");
    // Not "contains pick_label": the point is that it is ALONE. A write
    // that also carried name, price or sold_out_until would echo props
    // this tab may have rendered minutes ago.
    expect(Object.keys(writes[0].values)).toEqual(["pick_label"]);
    expect(writes[0].values.pick_label).toBe("best_seller");
  });

  it("clears a pick with the empty option, as null and not as a string", async () => {
    await mount(menu(dish("Carbonara", "best_seller")));
    await choose(control("Carbonara"), "");

    expect(Object.keys(writes[0].values)).toEqual(["pick_label"]);
    // "" would fail pick_label's own check constraint, which raises the
    // cap's SQLSTATE and would be reported as a limit nobody has hit.
    expect(writes[0].values.pick_label).toBeNull();
  });

  it("shows the new kind at once, without waiting for the round trip", async () => {
    await mount(menu(dish("Carbonara", null)));
    await choose(control("Carbonara"), "chefs_special");
    expect(control("Carbonara").value).toBe("chefs_special");
  });

  it("never sends a pick when a description, name or price is saved", async () => {
    /* The deliberate exclusion in MenuStore's updateItemAndWrite, held
       from the outside. An owner fixing a typo in a description must not
       silently un-pick the dish somebody made the chef's special. */
    await mount(menu(dish("Carbonara", "chefs_special")));
    await press("Edit");
    const description = container.querySelector<HTMLInputElement>(
      "#item-desc-item-carbonara",
    );
    expect(description).not.toBeNull();
    await type(description!, "Black pepper, pecorino");
    await press("Save");

    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0].values)).not.toContain("pick_label");
    expect(writes[0].values.description).toBe("Black pepper, pecorino");
  });
});

/* ── what the database refuses ─────────────────────────────────────── */

describe("a pick the database refuses", () => {
  it("names the cap for 23514, and puts the row back", async () => {
    await mount(menu(dish("Tiramisu", null)));
    refusal = { code: "23514", message: "A restaurant can mark at most three picks." };
    await choose(control("Tiramisu"), "best_seller");

    expect(said()).toContain(PICK_CAP_REFUSAL);
    // Optimistic, like every write on this screen -- so a refusal has to
    // take the change back off the row.
    expect(control("Tiramisu").value).toBe("");
  });

  it("names the other rule for 23505, and it is a different sentence", async () => {
    await mount(menu(dish("Branzino", null)));
    refusal = { code: "23505", message: "duplicate key value violates unique constraint" };
    await choose(control("Branzino"), "chefs_special");

    expect(said()).toContain(ONE_CHEFS_SPECIAL_REFUSAL);
    expect(said()).not.toContain(PICK_CAP_REFUSAL);
    expect(control("Branzino").value).toBe("");
  });

  it("tells the owner nothing the database said", async () => {
    await mount(menu(dish("Tiramisu", null)));
    refusal = {
      code: "42501",
      message: "new row violates row-level security policy for table \"menu_items\"",
      details: "Failing row contains (a10c…, service_role)",
    };
    await choose(control("Tiramisu"), "best_seller");

    expect(said()).toContain(PICK_WRITE_FAILED);
    expect(said()).not.toContain("menu_items");
    expect(said()).not.toContain("row-level security");
    expect(said()).not.toContain("Failing row");
    expect(control("Tiramisu").value).toBe("");
  });
});

/* ── whose screen the refusal belongs on ───────────────────────────── */

describe("a refused pick and the screen with no pick control", () => {
  it("never puts the cap refusal on the mid-service sync status", async () => {
    /* MenuProvider lives in app/dashboard/layout.tsx, so /dashboard/menu
       and /dashboard/menu/live share one store and the editor links
       straight between them. ManagerScreen's SyncNote renders the
       store-wide `error` INSTEAD of "In sync" / "Saved …", so a pick
       refusal routed through it would tell a manager mid-service to
       "set one of them back to 'not a pick' on its row" -- on the one
       screen that deliberately carries no pick control -- over the only
       line that says their sold-out toggles are landing, until some
       later write cleared it. */
    await mountWithSyncNote(menu(dish("Tiramisu", null)));
    refusal = { code: "23514", message: "A restaurant can mark at most three picks." };
    await choose(control("Tiramisu"), "best_seller");

    expect(syncNote()).not.toContain(PICK_CAP_REFUSAL);
    expect(syncNote()).toContain("live on the next call");
    // Not lost, just addressed to the right screen: the sentence is on
    // the row, under the dish it is about.
    expect(said()).toContain(PICK_CAP_REFUSAL);
    expect(control("Tiramisu").value).toBe("");
  });

  it("keeps a plain write failure off it as well", async () => {
    // The same leak by the same route -- "and choose again" on a screen
    // with nothing to choose.
    await mountWithSyncNote(menu(dish("Tiramisu", null)));
    refusal = { code: "08006", message: "connection failure" };
    await choose(control("Tiramisu"), "best_seller");

    expect(syncNote()).not.toContain(PICK_WRITE_FAILED);
    expect(said()).toContain(PICK_WRITE_FAILED);
  });

  it("still clears a banner an earlier failure left there", async () => {
    /* setError(null) at the top of the writer stays: routing the pick's
       own refusal elsewhere must not turn the store's error into
       something no write can clear. Remove, which does use the shared
       channel, then a pick that lands. */
    await mountWithSyncNote(menu(dish("Tiramisu", null)));
    refusal = { code: "08006", message: "connection failure" };
    await press("Remove");
    expect(syncNote()).toContain("Could not remove that item.");

    await choose(control("Tiramisu"), "best_seller");
    expect(syncNote()).not.toContain("Could not remove that item.");
  });
});

/* ── the courtesy, and the tab order it must not cost ──────────────── */

describe("a restaurant at its three picks", () => {
  const full = () =>
    menu(
      dish("Carbonara", "best_seller"),
      dish("Amatriciana", "best_seller"),
      dish("Osso Buco", "chefs_special"),
      dish("Tiramisu", null),
    );

  it("greys the options on a fourth dish and leaves the control reachable", async () => {
    /* The defect fixed under review on the operator's side, not to be
       re-made here: disabling the BOX takes it out of the tab order, so
       every unpicked row holds a faded control no keyboard and no screen
       reader can reach -- and no click on it can even raise a refusal to
       read. The options carry the cap; the box stays open. */
    await mount(full());
    const select = control("Tiramisu");
    expect(select.disabled).toBe(false);
    expect(option(select, "best_seller").disabled).toBe(true);
    expect(option(select, "chefs_special").disabled).toBe(true);
    expect(option(select, "").disabled).toBe(false);
  });

  it("leaves the three that hold the slots free to change or clear", async () => {
    // The trigger's "already counted" branch allows exactly this, and
    // clearing one is the only way back under the cap.
    await mount(full());
    const held = control("Carbonara");
    expect(held.disabled).toBe(false);
    expect(option(held, "best_seller").disabled).toBe(false);
    expect(option(held, "").disabled).toBe(false);
  });
});

describe("a restaurant that already has a chef's special", () => {
  it("offers that kind on that dish alone, and still offers the other", async () => {
    await mount(menu(dish("Osso Buco", "chefs_special"), dish("Tiramisu", null)));

    const other = control("Tiramisu");
    expect(option(other, "chefs_special").disabled).toBe(true);
    // A restaurant may call any number of dishes a best seller -- the
    // agent says "one of our best sellers", partitive.
    expect(option(other, "best_seller").disabled).toBe(false);

    const holder = control("Osso Buco");
    expect(option(holder, "chefs_special").disabled).toBe(false);
  });
});

/* ── the other console ─────────────────────────────────────────────── */

describe("a pick the operator sets while the owner is looking", () => {
  it("lands on the open screen", async () => {
    /* Both surfaces keep the control, so the two can be used at once.
       MenuStore's subscription carries the whole new row, which is what
       makes pick_label arrive without anybody adding it to a column
       list -- and this is what would catch a filtered subscription that
       dropped it. */
    await mount(menu(dish("Carbonara", null)));
    expect(arrive).not.toBeNull();

    await act(async () => {
      arrive!({ new: { ...dish("Carbonara", "chefs_special"), sort_order: 0 } });
    });

    expect(control("Carbonara").value).toBe("chefs_special");
    // Nothing was written from here: the row arrived, it was not sent.
    expect(writes).toHaveLength(0);
  });
});
