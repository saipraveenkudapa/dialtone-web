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

/* EditTabs' leave guard holds the router, because answering "leave" has
   to complete the navigation it just cancelled. useRouter() reads a
   React context that only the App Router mounts, and throws "invariant
   expected app router to be mounted" anywhere else -- including here,
   where renderToStaticMarkup is deliberately rendering one client
   component on its own with no app around it.

   So this mock is the router the same way the mock above is the actions
   module: the environment the component is entitled to assume in the
   place it actually runs, supplied so the assertions below can be about
   markup.

   It is not a stand-in for testing the guard, and nothing here may
   assert on `push`, because nothing here can make it fire: this suite is
   the "node" project, which has no DOM, so no effect runs and no click
   is dispatched. WHAT THE GUARD ACTUALLY DOES IS TESTED IN
   components/admin/EditTabs.guard.test.tsx -- the "jsdom" project added
   to vitest.config.ts for exactly this -- where real anchors are pressed
   with real MouseEvents and the assertions are on defaultPrevented, on
   which presses are let through, and on where router.push is called
   with. What remains below is a claim about the SENTENCE an operator
   reads, which is a different thing and belongs here. */
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
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

/* ══════════════════════════════════════════════════════════════════════
   The tab strip, and the four ways it could take an operator's typing.
   Each block below is a defect that shipped in the first tabs pass.
   ══════════════════════════════════════════════════════════════════════ */

const { EditPanel, EditTabs, ReplacedNote, sectionOfAnchor, EDIT_SECTIONS } = await import(
  "@/components/admin/EditTabs"
);

function strip(over: Partial<Parameters<typeof EditTabs>[0]> = {}): string {
  const { children, ...props } = { initial: "menu" as const, behind: [], ...over };
  return renderToStaticMarkup(
    createElement(
      EditTabs,
      props as Parameters<typeof EditTabs>[0],
      children ??
        createElement(
          EditPanel,
          // Both components take their children as the third argument
          // here, so the props object is legitimately short of the
          // `children` its type declares.
          { id: "menu" } as Parameters<typeof EditPanel>[0],
          "the menu panel",
        ),
    ),
  );
}

describe("an anchor the browser will hand over unchecked", () => {
  it("opens the tab its section lives on", () => {
    // All ten ids stay on their sections; #holidays and #sold-out are
    // sub-cards and open their parent's tab. GoLive.tsx's three checklist
    // rows and every link on /admin/<id> ride on this map.
    expect(sectionOfAnchor("menu")).toBe("menu");
    expect(sectionOfAnchor("sold-out")).toBe("menu");
    expect(sectionOfAnchor("holidays")).toBe("hours");
    expect(sectionOfAnchor("hours")).toBe("hours");
    expect(sectionOfAnchor("answering")).toBe("answering");
    expect(sectionOfAnchor("managed")).toBe("managed");
  });

  it("does not resolve an inherited property, which blanked the editor", () => {
    // SECTION_OF_ANCHOR is an object literal, so it inherits from
    // Object.prototype: `SECTION_OF_ANCHOR[hash]` returned a TRUTHY
    // function for /edit#constructor and sailed past `if (!section)`.
    // setActive then held a function, so no radio was checked and every
    // panel's `hidden` was true -- a tab strip with nothing selected
    // above an empty page, with the arrow keys dead (findIndex -> -1)
    // and ?section=function%20Object()... written into the URL so a
    // reload did it again. There is no way back except the address bar.
    for (const hash of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ]) {
      expect(sectionOfAnchor(hash)).toBeUndefined();
    }
    expect(sectionOfAnchor("")).toBeUndefined();
    expect(sectionOfAnchor("not-a-section")).toBeUndefined();
  });

  it("answers with one of the eight tabs, and every tab is reachable by its own id", () => {
    for (const { id } of EDIT_SECTIONS) expect(sectionOfAnchor(id)).toBe(id);
  });
});

describe("what the strip is made of", () => {
  it("is a radio group and not a tablist that owns no tabs", () => {
    // It wore role="tablist" with role="tab" on the radios. Both halves
    // were wrong: every radio sits inside a <label>, so the tablist
    // owned eight generic elements and nothing could compute "7 of 8";
    // and role="tab" destroyed the input's own `radio` role while the
    // code went on depending on the radio group's shared `name` for the
    // roving tabindex, on a node industry.css renders 0x0 and
    // opacity:0. A native radio group is what the house's other two
    // .seg strips already are.
    const html = strip();
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain("aria-selected");
    // The one ARIA that ties a choice to what it swaps in, kept.
    expect(html).toContain('aria-controls="edit-panel-menu"');
    expect(html).toContain('name="ed-section-tab"');
  });

  it("names each panel rather than calling it a tabpanel with no tablist", () => {
    const html = strip();
    expect(html).not.toContain('role="tabpanel"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Menu"');
  });

  it("still renders the chosen panel visible and says which section it is", () => {
    const html = strip();
    expect(html).toContain('id="edit-panel-menu"');
    // The chosen panel is the one WITHOUT hidden, and it keeps
    // .setup-stack, which is what app.css's [hidden] rule needs to bite.
    expect(html).toMatch(/id="edit-panel-menu"[^>]*class="setup-stack"/);
    expect(html).not.toMatch(/id="edit-panel-menu"[^>]*hidden/);
  });
});

describe("a re-seed that lands on typing", () => {
  /* Every action on /edit calls revalidatePath, success or refusal, so
     ONE write anywhere on the page re-renders all eight panels with
     fresh props, and each form re-seeds if its own values moved. That
     is right and stays. What it may not be is silent: seven of the
     eight panels are display:none, so the loss AND the tab's "Unsaved"
     chip disappearing both happen off screen, which is
     indistinguishable from the operator's own save landing.

     Asserted against the source because it is a claim about the SECOND
     render with new props, and this suite has no DOM to re-render
     into -- the same reason the re-seed comparisons above are. */

  const editSections = source("../../components/admin/EditSections.tsx");
  const editor = source("../../components/admin/HoursEditor.tsx");
  const menuAdmin = source("../../components/admin/MenuAdmin.tsx");

  it("says so, in the card and on the tab", () => {
    const html = renderToStaticMarkup(createElement(ReplacedNote, { when: true }));
    expect(html).toContain("setup-error");
    expect(prose(html)).toMatch(/replaced by what is now on file/i);
    expect(prose(html)).toMatch(/Nothing was saved from it/i);
    // Absent when there is nothing to report -- a standing warning is
    // furniture, and furniture is not read.
    expect(renderToStaticMarkup(createElement(ReplacedNote, { when: false }))).toBe("");
  });

  it("is reported by all five forms that can be re-seeded", () => {
    // useSeeded covers business, answering, service, orders, recording.
    expect(editSections).toContain("useSectionReplaced(section, replaced)");
    expect(editSections.match(/<ReplacedNote when=\{replaced\} \/>/g)).toHaveLength(5);
    expect(editor.match(/useSectionReplaced\("hours", replaced\)/g)).toHaveLength(2);
    expect(menuAdmin.match(/useSectionReplaced\("menu", replaced\)/g)).toHaveLength(2);
  });

  it("stays quiet on the operator's own save", () => {
    // Two conditions everywhere: there WAS typing (the form does not
    // match what it was seeded from) and what arrived is not it (the
    // form does not match what has just landed). A save satisfies the
    // first and fails the second, so it must never raise this.
    expect(editSections).toContain("setReplaced(!same(form, seen) && !same(form, server))");
    expect(editor).toContain(
      "setReplaced(daysDiffer(days, seededDays) && daysDiffer(days, fresh))",
    );
    expect(editor).toContain(
      "setReplaced(holidayDiffers(typed, seenSeed) && holidayDiffers(typed, seed))",
    );
    expect(menuAdmin).toContain("setReplaced(typedCat !== seen && typedCat !== seedCat)");
    expect(menuAdmin).toContain("setReplaced(typedItem !== seen && typedItem !== seedItem)");
  });
});

describe("the beforeunload guard", () => {
  /* It was written out by hand in two components and missing from six.
     A half-edited dish, a half-typed category rename, a half-typed
     holiday and a half-typed new dish were all destroyed by Ctrl-R with
     no browser prompt of any kind -- which lib/admin/edit.ts's
     stale-save refusal actively instructs the operator to do ("Reload
     the page and make the change again"). Tabs made it likelier still,
     because the typing is now behind a tab rather than on screen. */

  it("lives in one place, beside the thing that already knows the answer", () => {
    const tabs = source("../../components/admin/EditTabs.tsx");
    expect(tabs).toContain("export function useSectionDirty");
    expect(tabs).toContain('window.addEventListener("beforeunload", warn)');
  });

  it("is not hand-rolled anywhere on this screen any more", () => {
    for (const file of [
      "../../components/admin/EditSections.tsx",
      "../../components/admin/HoursEditor.tsx",
      "../../components/admin/MenuAdmin.tsx",
    ]) {
      expect(source(file)).not.toContain('addEventListener("beforeunload"');
    }
  });

  it("covers every surface on the page that can hold unsaved typing", () => {
    // Eight reporters: the five useSeeded sections, the week, a holiday
    // row, the new-holiday form, the category rename, an item row, the
    // new-item form and the new-category field.
    const editSections = source("../../components/admin/EditSections.tsx");
    const editor = source("../../components/admin/HoursEditor.tsx");
    const menuAdmin = source("../../components/admin/MenuAdmin.tsx");
    expect(editSections).toContain("useSectionDirty(section, dirty)");
    expect(editor.match(/useSectionDirty\("hours",/g)).toHaveLength(3);
    expect(menuAdmin.match(/useSectionDirty\(\s*"menu",/g)).toHaveLength(4);
  });
});

describe("putting the add-item form away", () => {
  it("does not take what was typed into it", () => {
    // Cancel used to unmount <AddItemForm>, which took its name, price
    // and description useState with it -- no dialog, no dirty check, no
    // undo -- from a button 6.8px from the one that adds the dish. That
    // is the identical hazard this file's own Remove dialog exists for.
    // Hidden, not unmounted: the same mechanism EditPanel uses.
    const html = menu();
    expect(html).toContain("add-item-form");
    // Present in the markup while the disclosure is shut, and hidden.
    expect(html).toMatch(/class="add-item-form"[^>]*hidden/);
    expect(prose(html)).toContain("Add item");

    const menuAdmin = source("../../components/admin/MenuAdmin.tsx");
    expect(menuAdmin).toContain("hidden={!adding}");
    // ...and never conditionally rendered again.
    expect(menuAdmin).not.toMatch(/\{adding \? \(\s*<AddItemForm/);
  });
});

/* ── what only the stylesheet can hold ─────────────────────────────── */

describe("the tab strip's stylesheet", () => {
  const css = source("../../app/app.css");
  const head = css.indexOf("/* ── the editor's tab strip");
  /* Comments stripped: this block argues at length about the rules it no
     longer has, and a search over the prose would find `position:
     sticky` in the paragraph explaining why it was taken out. */
  const block = css
    .slice(head, css.indexOf(".setup-stack[hidden] { display: none; }", head))
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("does not pin the strip over the panel it names", () => {
    // `position: sticky; top: 0` put an opaque 36-110px bar over the
    // top of the viewport, and a control that takes focus underneath it
    // is not scrolled clear -- the browser considers a field inside the
    // layout viewport already visible, so Shift+Tab upwards landed on
    // an .input entirely covered by the strip with no scroll at all.
    // WCAG 2.2 2.4.11 Focus Not Obscured (Minimum), at AA, on the
    // ordinary keyboard path through an eight-field card.
    expect(block).not.toMatch(/position:\s*sticky/);
    expect(block).not.toMatch(/\.edit-tabs\s*\{[^}]*top:\s*0/);
  });

  it("draws the divider per option rather than per sibling, because it wraps", () => {
    // industry.css's `.seg-opt + .seg-opt { border-left }` is DOM
    // adjacency, not row adjacency: on a wrapped strip the first option
    // of every row after the first drew a stray hairline one pixel
    // inside the container's own border, and nothing at all separated
    // the rows. Every option carrying its own top and left edge, pulled
    // onto its neighbour by a one-pixel negative margin, is what makes
    // .seg's `overflow: hidden` clip exactly the hairlines that would
    // have doubled an edge.
    expect(block).toMatch(/\.edit-tabs \.seg-opt\s*\{[\s\S]*border-left:\s*1px solid var\(--color-divider\)/);
    expect(block).toMatch(/\.edit-tabs \.seg-opt\s*\{[\s\S]*border-top:\s*1px solid var\(--color-divider\)/);
    expect(block).toMatch(/\.edit-tabs \.seg-opt\s*\{[\s\S]*margin-left:\s*-1px/);
    expect(block).toMatch(/\.edit-tabs \.seg-opt\s*\{[\s\S]*margin-top:\s*-1px/);
  });

  it("keeps the one hidden panel rule the whole design rests on", () => {
    expect(css).toContain(".setup-stack[hidden] { display: none; }");
    expect(css).toContain(".add-item-form[hidden] { display: none; }");
  });
});

describe("a menu row in a 300px card", () => {
  const css = source("../../app/app.css");

  it("keeps its three controls on one line, so Remove never moves", () => {
    // Measured at 768px: the card is 357.8px, the row 328.6px, and the
    // controls block gets 230px. At the 160px select cap this shipped
    // with, the three controls needed 261.6px and wrapped -- putting
    // Remove, which destroys a dish with no undo, on the second line
    // for a dish with a description and beside Edit for one without. At
    // 130px they are 231.6px: one bar, and Remove at the same x on
    // every row.
    expect(css).toContain(".menu-item-row .input { max-width: 130px; }");
    expect(css).toContain(".menu-item-row .menu-edit-row-actions { flex-wrap: nowrap; }");
    // The same cap .hours-times .input takes, which is what the comment
    // above it claims to be following.
    expect(css).toContain(".hours-times .input { max-width: 130px; }");
  });
});

describe("a dish the assistant is refusing", () => {
  /** WCAG 2.x relative luminance of an 8-bit sRGB triple. */
  function luminance([r, g, b]: number[]): number {
    const chan = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  }

  function hex(value: string): number[] {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim());
    if (!m) throw new Error(`not a hex colour: ${value}`);
    return [m[1], m[2], m[3]].map((pair) => parseInt(pair, 16));
  }

  function token(css: string, name: string): string {
    const m = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
    if (!m) throw new Error(`no ${name}`);
    return m[1];
  }

  it("has its struck-through name still legible", () => {
    // The name is dimmed with a colour rather than opacity, so the
    // "Not offered" chip beside it keeps its own contrast -- that part
    // was right. The percentage was not: 45% was carried over from
    // .lv-name .name.out, which is 15px on the manager screen, and at
    // this row's 13px it composited to 2.75:1 -- under the 4.5:1 WCAG
    // 1.4.3 asks of body text, and dimmer than .text-muted's own 55%,
    // which made a sold-out dish's NAME the least readable text on the
    // page.
    const app = source("../../app/app.css");
    const industry = source("../../app/industry.css");

    const text = hex(token(industry, "--color-text"));
    const bg = hex(token(industry, "--color-bg"));

    const rule = app.slice(app.indexOf(".menu-item-row.is-out .name"));
    const mix = /color-mix\(in srgb, var\(--color-text\) (\d+)%, transparent\)/.exec(rule);
    expect(mix).not.toBeNull();
    const alpha = Number(mix![1]) / 100;

    const composited = text.map((channel, i) => alpha * channel + (1 - alpha) * bg[i]);
    const light = luminance(bg);
    const dark = luminance(composited);
    const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);

    expect(ratio).toBeGreaterThanOrEqual(4.5);
    // And still visibly stood down: not simply the same ink as a name
    // that is on sale.
    expect(alpha).toBeLessThan(1);
  });
});

describe("the sentence under the strip", () => {
  it("names the tabs holding unsaved work and what a navigation does to them", () => {
    // beforeunload cannot see a client-side route change, and this page
    // offers six of them -- "Overview & go-live" (the largest button in
    // the page head), the back link, three AdminNav items and
    // SystemManaged's own link. Under tabs, seven of the eight surfaces
    // holding typing are display:none while one of those is pressed, so
    // a chip on a tab is not enough on its own. Rendered only when
    // something is actually unsaved.
    const tabs = source("../../components/admin/EditTabs.tsx");
    expect(tabs).toContain("unsavedLabels.length > 0");
    expect(tabs).toContain("Unsaved edits on {sentenceList(unsavedLabels)}");

    /* This sentence used to end "leaving this page loses them", which was
       the truth while beforeunload was the only guard. It is now a lie:
       a link out of the page is intercepted and asks first. A warning
       that overstates the danger gets disbelieved, and then the one case
       that IS still lossy gets disbelieved with it -- so the sentence has
       to draw the line where the code draws it.

       Both halves are asserted, and deliberately so. The first is the
       promise the guard makes -- and it is a promise the guard is now
       held to by an actual dispatched click, in
       components/admin/EditTabs.guard.test.tsx; this assertion is only
       that the page SAYS it. The second is the hole it does not cover,
       because popstate arrives after the history entry has already
       changed and "cancelling" it means fighting the operator's own Back
       button. If someone ever guards Back too, this test is what tells
       them the sentence has to stop saying it doesn't. */
    expect(tabs).toMatch(/link out of this page asks first/i);
    expect(tabs).toMatch(/Back button does not, and\s+loses them/i);

    // Not on screen when there is nothing to say.
    expect(strip()).not.toContain("edit-tabs-note");
  });
});

describe("the two sort orders on a category card", () => {
  it("are told apart, because they are different numbers", () => {
    // The card's .card-meta prints the CATEGORY's sort order and each
    // row prints its ITEM's. They read alike and were once reported as
    // duplicated ink; they are not, and the tie warning under the list
    // names the row number, so an operator who cannot see it has to open
    // every dish to find which two collide.
    const html = menu({
      categories: [{ id: CATEGORY, name: "Pasta", sort_order: 3 }],
      items: [
        {
          id: ITEM,
          category_id: CATEGORY,
          name: "Carbonara",
          description: null,
          price_cents: 2200,
          allergen_note: null,
          sort_order: 7,
          sold_out_until: null,
        },
      ],
    });
    const meta = html.slice(html.indexOf("card-meta"), html.indexOf("menu-item-list"));
    expect(prose(meta)).toContain("sort 3");
    expect(prose(meta)).not.toContain("sort 7");
    const row = html.slice(html.indexOf("menu-item-list"));
    expect(prose(row)).toContain("sort 7");
  });
});
