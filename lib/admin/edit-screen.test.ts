import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* The record editor's shipped surface.
 *
 * Under lib/ deliberately: vitest.config.ts sets
 * `include: ["lib/**\/*.test.ts"]`, so the same file under components/
 * would never run. Same convention, and the same rendering trick, as
 * lib/provisioning/go-live-panel.test.ts -- renderToStaticMarkup over a
 * client component is enough to hold a claim about what an operator
 * actually reads, which is the only kind of claim a type checker cannot.
 *
 * Three things here are not testable by rendering, because they are
 * about what happens on the SECOND render with new props, and there is
 * no DOM in this suite to re-render into. Those are asserted against the
 * source, which is what the repo already does for the panel's own
 * shipped surface. They are marked where they appear.
 */

/* "use server" modules are HTTP endpoints, not functions to import: the
   real one pulls in next/headers and the service-role client. The
   components take everything they call from it, so the mock is the whole
   dependency. */
vi.mock("@/app/admin/[locationId]/edit/actions", () => ({
  resyncAssistantAction: vi.fn(),
  saveAnsweringAction: vi.fn(),
  saveBusinessAction: vi.fn(),
  saveOrderRoutingAction: vi.fn(),
  saveRecordingAction: vi.fn(),
  saveServiceAction: vi.fn(),
}));

const { AnsweringSection, BusinessSection, ServiceSection } = await import(
  "@/components/admin/EditSections"
);
const { HoursEditor } = await import("@/components/admin/HoursEditor");
const { MenuAdmin } = await import("@/components/admin/MenuAdmin");

type Drift = Parameters<typeof AnsweringSection>[0]["drift"];

const LOCATION = "d7be1400-7c38-4933-a248-407ff339cd73";
const CATEGORY = "c0000000-0000-0000-0000-0000000000c1";
const ITEM = "17e00000-0000-0000-0000-0000000000e1";

/** The state the whole design turns on: Vapi could not be read, so every
 *  cell is `unknown` and NOT ONE DriftNote renders anywhere. */
function unreadable(): Drift {
  const cell = { state: "unknown", onPhone: null } as const;
  return {
    state: "unreadable",
    greeting: cell,
    transfer: cell,
    name: cell,
    address: cell,
    orderTypes: cell,
  };
}

/** Tags dropped, entities put back, whitespace collapsed -- so the
 *  assertions are about what an operator reads rather than where the
 *  tags fell. */
function prose(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

const noop = async () => ({ ok: true as const, message: "", phone: { state: "not-needed" as const } });

function answering(over: Partial<Parameters<typeof AnsweringSection>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(AnsweringSection, {
      locationId: LOCATION,
      greetingText: "Hi, thanks for calling Marty's!",
      fallbackNumber: "+18787787878",
      updatedAt: "2026-01-01T00:00:00Z",
      drift: unreadable(),
      hasAssistant: true,
      ...over,
    }),
  );
}

function business(over: Partial<Parameters<typeof BusinessSection>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(BusinessSection, {
      locationId: LOCATION,
      orgName: "Marty's Group",
      plan: "starter",
      name: "Marty's",
      timezone: "America/Los_Angeles",
      address: "1 Main St, Oakland CA",
      businessPhone: null,
      carrierName: null,
      timezones: ["America/Los_Angeles", "America/New_York"],
      updatedAt: "2026-01-01T00:00:00Z",
      drift: unreadable(),
      hasAssistant: true,
      ...over,
    }),
  );
}

function hours(over: Partial<Parameters<typeof HoursEditor>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(HoursEditor, {
      locationId: LOCATION,
      timezone: "America/Los_Angeles",
      hours: [
        { id: "h-0", day_of_week: 0, open_time: null, close_time: null, is_closed: true },
        { id: "h-1", day_of_week: 1, open_time: "09:00:00", close_time: "21:00:00", is_closed: false },
        { id: "h-2", day_of_week: 2, open_time: "09:00:00", close_time: "21:00:00", is_closed: false },
        { id: "h-3", day_of_week: 3, open_time: "09:00:00", close_time: "21:00:00", is_closed: false },
        { id: "h-4", day_of_week: 4, open_time: "09:00:00", close_time: "21:00:00", is_closed: false },
        { id: "h-5", day_of_week: 5, open_time: "09:00:00", close_time: "22:00:00", is_closed: false },
        { id: "h-6", day_of_week: 6, open_time: "09:00:00", close_time: "22:00:00", is_closed: false },
      ],
      holidays: [
        { id: "hol-1", date: "2026-11-26", is_closed: true, open_time: null, close_time: null },
      ],
      saveHoursAction: noop,
      saveHolidayAction: noop,
      deleteHolidayAction: noop,
      ...over,
    }),
  );
}

function menu(over: Partial<Parameters<typeof MenuAdmin>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(MenuAdmin, {
      locationId: LOCATION,
      categories: [{ id: CATEGORY, name: "Pasta", sort_order: 0 }],
      items: [
        {
          id: ITEM,
          category_id: CATEGORY,
          name: "Carbonara",
          description: "Guanciale, pecorino, egg",
          price_cents: 2200,
          allergen_note: null,
          sort_order: 0,
          sold_out_until: null,
        },
      ],
      createCategoryAction: noop,
      saveCategoryAction: noop,
      deleteCategoryAction: noop,
      createItemAction: noop,
      saveItemAction: noop,
      deleteItemAction: noop,
      setSoldOutAction: noop,
      ...over,
    }),
  );
}

/* ── the push has to be reachable when the drift read failed ───────── */

describe("the control that pushes a pending rebuild", () => {
  it("is on the card even when Vapi could not be read", () => {
    // The state this exists for: readAssistantDrift times out (or the
    // key is unset), so every cell is `unknown` and no DriftNote
    // renders. Save is disabled until the form is dirty. On a restaurant
    // whose columns are already right and whose assistant is behind --
    // exactly what go-live's setFallbackNumber leaves, since it writes
    // the column and cannot rebuild -- there would be nothing to press,
    // and the phone would go on transferring to the old number.
    const html = answering();
    expect(prose(html)).toContain("Update the phone");
    expect(html).not.toContain("edit-note is-drift");
  });

  it("is on all three cards that can rebuild", () => {
    expect(prose(business())).toContain("Update the phone");
    expect(
      prose(
        renderToStaticMarkup(
          createElement(ServiceSection, {
            locationId: LOCATION,
            taxRateBps: 875,
            orderTypes: "pickup",
            pickupPromiseMinutes: 25,
            deliveryPromiseMinutes: 45,
            seats: 40,
            maxPartySize: 8,
            reservationSlotMinutes: 90,
            updatedAt: "2026-01-01T00:00:00Z",
            drift: unreadable(),
            hasAssistant: true,
          }),
        ),
      ),
    ).toContain("Update the phone");
  });

  it("is not offered on a restaurant that has no assistant to push to", () => {
    expect(prose(answering({ hasAssistant: false }))).not.toContain("Update the phone");
  });
});

/* ── the one baked column with no detector ─────────────────────────── */

describe("the timezone", () => {
  it("says plainly that it cannot be checked against the assistant", () => {
    // timezone is in SYNCED_COLUMNS -- it reaches the prompt through the
    // frozen date-and-time line -- but readAssistantDrift has no cell
    // for it. Without this sentence a timezone save whose rebuild failed
    // leaves no evidence at all after one reload: the card claims
    // agreement while the assistant goes on working out "tomorrow" in
    // the old zone.
    const text = prose(business());
    expect(text).toMatch(/nothing on the assistant to compare it against/i);
    expect(text).toMatch(/tomorrow/);
  });

  it("does not say it on a restaurant with no assistant", () => {
    expect(prose(business({ hasAssistant: false }))).not.toMatch(
      /nothing on the assistant to compare it against/i,
    );
  });
});

/* ── one chip, one meaning ─────────────────────────────────────────── */

describe("the rebuild chip", () => {
  it("means rebuild, and only rebuild", () => {
    // .tag-outline is this feature's rebuild mark: the flag on every
    // baked field label and the opener of every "this also rebuilds"
    // note. Worn on a live note to assert the opposite, one page meets
    // outline=rebuild, no-chip=live, outline=LIVE -- which is the single
    // thing most likely to make an operator push a rebuild they did not
    // need or skip one they did.
    expect(answering()).toContain("tag tag-outline");
    expect(hours()).not.toContain("tag-outline");
    expect(menu()).not.toContain("tag-outline");
  });

  it("still leaves the live cards saying they are live", () => {
    expect(hours()).toContain("edit-note is-live");
    expect(menu()).toContain("edit-note is-live");
    expect(prose(menu())).toMatch(/quotes on the very next call/);
  });
});

/* ── the alarm colour is only for the alarm ────────────────────────── */

describe("a weekday with no row on file", () => {
  it("is not dressed as a screen-and-phone disagreement", () => {
    // .edit-note.is-drift and .tag-out are "the screen and the phone
    // disagree", the one actively wrong state on this page -- and this
    // card has just said there is nothing on the phone that can
    // disagree. Spending the alarm here devalues it everywhere it is
    // used correctly.
    const html = hours({
      hours: [
        { id: "h-0", day_of_week: 0, open_time: null, close_time: null, is_closed: true },
      ],
    });

    expect(prose(html)).toContain("Not on file");
    expect(html).toContain("tag tag-neutral");
    expect(html).not.toContain("is-drift");
    expect(html).not.toContain("tag tag-out");
  });
});

/* ── the frame the mockup draws ────────────────────────────────────── */

describe("the menu's cards", () => {
  it("wear the blueprint frame the rest of the stack wears", () => {
    // These sit as direct children of /edit's .setup-stack, among nine
    // framed blueprint sections. Without the marks they drop out across
    // the tallest region of the page and it stops reading as the console.
    const html = menu();
    expect(html).toContain('class="card blueprint menu-edit-cat"');
    for (const mark of ["corner tl", "corner tr", "corner bl", "corner br"]) {
      expect(html).toContain(mark);
    }
  });

  it("keeps its notes inside a card rather than loose in the stack", () => {
    const html = menu({ categories: [], items: [] });
    const note = html.indexOf("No categories yet");
    const soldOut = html.indexOf('id="sold-out"');
    expect(note).toBeGreaterThan(-1);
    // Before the next section starts, i.e. still inside #menu.
    expect(note).toBeLessThan(soldOut);
  });
});

/* ── what only the source can hold ─────────────────────────────────── */

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("re-seeding a form from the server", () => {
  /* Every action on /edit calls revalidatePath on it, so a save anywhere
     on the page hands EVERY client component a freshly deserialised
     props object -- same contents, new identity. A guard written as
     `seen !== prop` therefore fires on every save, throwing away a week
     of hours, a rename or a price the operator had typed and not yet
     saved, with the Unsaved tag and the beforeunload guard disappearing
     along with it. EditSections' own useSeeded compares by value
     (`same(seen, server)`); these four did not.

     Asserted against the source because it is a claim about the SECOND
     render with new props, and this suite has no DOM to re-render into. */

  const editor = source("../../components/admin/HoursEditor.tsx");
  const menuAdmin = source("../../components/admin/MenuAdmin.tsx");

  it("compares the weekly grid and the holiday row by value", () => {
    expect(editor).not.toMatch(/seenHours !== hours/);
    expect(editor).toContain("if (seenSignature !== signature)");
    expect(editor).not.toMatch(/if \(seen !== holiday\)/);
    expect(editor).toContain("if (seen !== seed4)");
  });

  it("compares the category card and the item row by value", () => {
    expect(menuAdmin).not.toMatch(/if \(seen !== category\)/);
    expect(menuAdmin).toContain("if (seen !== seedCat)");
    expect(menuAdmin).not.toMatch(/if \(seen !== item\)/);
    expect(menuAdmin).toContain("if (seen !== seedItem)");
  });

  it("sends the week it was seeded from back with the save", () => {
    // The hours upsert replaces all seven rows, and `hours` carries no
    // timestamp of its own, so the signature is the only thing that can
    // stop a stale tab putting a whole week back.
    expect(editor).toContain("saveHoursAction(locationId, input, signature)");
  });
});

describe("removing a menu item", () => {
  it("asks first, like every other irreversible act on this screen", () => {
    // .menu-edit-row-actions is a 4px flex gap, so Remove is the
    // neighbour of the Edit button an operator is aiming at while a
    // restaurant owner talks. Deleting a category asks; changing a price
    // asks; this destroyed the row's name, description, price, allergen
    // note and sold-out state straight off the row's onClick, with no
    // undo and nothing to restore it from.
    const menuAdmin = source("../../components/admin/MenuAdmin.tsx");
    expect(menuAdmin).toContain("ma-item-confirm-");
    expect(menuAdmin).toContain("setConfirmingRemove(true)");
    // The action is reachable from the dialog and from nowhere else.
    expect(menuAdmin.match(/deleteItemAction\(locationId, item\.id\)/g)).toHaveLength(1);
    expect(menuAdmin).not.toMatch(/onClick=\{\(\) => run\(\(\) => deleteItemAction/);
  });

  it("does not carry a stale sold-out flag into an ordinary save", () => {
    const menuAdmin = source("../../components/admin/MenuAdmin.tsx");
    expect(menuAdmin).not.toMatch(/soldOutUntil: item\.sold_out_until/);
    expect(menuAdmin).toContain('soldOutUntil: ""');
  });
});

describe("the two menu editors", () => {
  it("are both named where their shared CSS lives", () => {
    // components/admin/MenuAdmin.tsx forks components/MenuEditor.tsx's
    // furniture against a different write transport, and the two have
    // already drifted (MenuEditor's .btn-icon reorder controls have no
    // counterpart). Whoever changes a .menu-edit-* rule has two call
    // sites to check, and the only place that can tell them so is the
    // block header.
    const css = source("../../app/app.css");
    const header = css.slice(css.indexOf("/* ── menu editor"), css.indexOf(".menu-edit {"));
    expect(header).toContain("components/MenuEditor.tsx");
    expect(header).toContain("components/admin/MenuAdmin.tsx");
    expect(header).toContain("btn-icon");
  });
});
