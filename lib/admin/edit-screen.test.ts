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

/* ConsoleTabs' leave guard holds the router, because answering "leave" has
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
   components/admin/ConsoleTabs.guard.test.tsx -- the "jsdom" project added
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
          pick_label: null,
        },
      ],
      createCategoryAction: noop,
      saveCategoryAction: noop,
      deleteCategoryAction: noop,
      createItemAction: noop,
      saveItemAction: noop,
      deleteItemAction: noop,
      setSoldOutAction: noop,
      setPickAction: noop,
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

const { ConsolePanel, ConsoleTabs, ReplacedNote, sectionOfAnchor, CONSOLE_SECTIONS } =
  await import("@/components/admin/ConsoleTabs");

type StripProps = Parameters<typeof ConsoleTabs>[0];

function strip(over: Partial<StripProps> = {}): string {
  const { children, ...props } = {
    initial: "menu" as const,
    behind: [] as StripProps["behind"],
    ...over,
  };
  return renderToStaticMarkup(
    createElement(
      ConsoleTabs,
      props as StripProps,
      children ??
        createElement(
          ConsolePanel,
          // Both components take their children as the third argument
          // here, so the props object is legitimately short of the
          // `children` its type declares.
          { id: "menu" } as Parameters<typeof ConsolePanel>[0],
          "the menu panel",
        ),
    ),
  );
}

describe("an anchor the browser will hand over unchecked", () => {
  it("opens the tab its section lives on", () => {
    // Every id that ever shipped still resolves; #holidays and #sold-out
    // are sub-cards and open their parent's tab.
    expect(sectionOfAnchor("menu")).toBe("menu");
    expect(sectionOfAnchor("sold-out")).toBe("menu");
    expect(sectionOfAnchor("holidays")).toBe("hours");
    expect(sectionOfAnchor("hours")).toBe("hours");
    expect(sectionOfAnchor("answering")).toBe("answering");
    expect(sectionOfAnchor("managed")).toBe("managed");
  });

  it("still resolves the anchors whose panel MOVED, rather than 404ing a bookmark", () => {
    /* The console merge collapsed two tabs into others. Neither anchor
       was renamed and neither <section id> was dropped -- they open a
       different tab now, and the browser's own scroll still lands on the
       card. #recording is pasted into tickets and is what
       /edit?section=recording redirects through; #golive and #calls are
       the overview's two subjects, which had no anchor at all before
       because they were not sections of anything. */
    expect(sectionOfAnchor("recording")).toBe("calls");
    expect(sectionOfAnchor("golive")).toBe("line");
    expect(sectionOfAnchor("line")).toBe("line");
    expect(sectionOfAnchor("calls")).toBe("calls");
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

  it("answers with one of the nine tabs, and every tab is reachable by its own id", () => {
    for (const { id } of CONSOLE_SECTIONS) expect(sectionOfAnchor(id)).toBe(id);
  });
});

describe("what the strip is made of", () => {
  it("is a radio group and not a tablist that owns no tabs", () => {
    // It wore role="tablist" with role="tab" on the radios. Both halves
    // were wrong: every radio sits inside a <label>, so the tablist
    // owned nine generic elements and nothing could compute "7 of 9";
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
    expect(html).toContain('aria-controls="console-panel-menu"');
    expect(html).toContain('name="console-section-tab"');
  });

  it("names each panel rather than calling it a tabpanel with no tablist", () => {
    const html = strip();
    expect(html).not.toContain('role="tabpanel"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Menu"');
  });

  it("still renders the chosen panel visible and says which section it is", () => {
    const html = strip();
    expect(html).toContain('id="console-panel-menu"');
    // The chosen panel is the one WITHOUT hidden, and it keeps
    // .setup-stack, which is what app.css's [hidden] rule needs to bite.
    expect(html).toMatch(/id="console-panel-menu"[^>]*class="setup-stack"/);
    expect(html).not.toMatch(/id="console-panel-menu"[^>]*hidden/);
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
    const tabs = source("../../components/admin/ConsoleTabs.tsx");
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
  const head = css.indexOf("/* ── the console's tab strip");
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
    expect(block).not.toMatch(/\.console-tabs\s*\{[^}]*top:\s*0/);
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
    expect(block).toMatch(/\.console-tabs \.seg-opt\s*\{[\s\S]*border-left:\s*1px solid var\(--color-divider\)/);
    expect(block).toMatch(/\.console-tabs \.seg-opt\s*\{[\s\S]*border-top:\s*1px solid var\(--color-divider\)/);
    expect(block).toMatch(/\.console-tabs \.seg-opt\s*\{[\s\S]*margin-left:\s*-1px/);
    expect(block).toMatch(/\.console-tabs \.seg-opt\s*\{[\s\S]*margin-top:\s*-1px/);
  });

  it("keeps the one hidden panel rule the whole design rests on", () => {
    expect(css).toContain(".setup-stack[hidden] { display: none; }");
    expect(css).toContain(".add-item-form[hidden] { display: none; }");
  });
});

describe("a menu row in a 300px card", () => {
  const css = source("../../app/app.css");

  it("keeps Edit and Remove on one line, so Remove never moves", () => {
    // Measured at 768px: the card is 357.8px, the row 328.6px, and the
    // controls block gets 230px. At the 160px select cap this shipped
    // with, the sold-out select plus Edit and Remove needed 261.6px and
    // wrapped -- putting Remove, which destroys a dish with no undo, on
    // the second line for a dish with a description and beside Edit for
    // one without. At 130px they were 231.6px: one bar, and Remove at
    // the same x on every row.
    //
    // The row now carries a second select -- the pick, which used to be
    // reachable only by opening the dish -- and four controls do not fit
    // one line of a 328.6px row at any cap that leaves "Out until close"
    // readable. So the two selects sit outside .menu-edit-row-actions
    // and the row's own flex-wrap breaks the line between them and the
    // buttons; the block itself keeps nowrap, which is what holds Remove
    // beside Edit. Inside the block, nowrap would have hung 369.6px of
    // controls past the card's edge instead.
    expect(css).toContain(".menu-item-row .input { max-width: 130px; }");
    expect(css).toContain(".menu-item-row .menu-edit-row-actions { flex-wrap: nowrap; }");
    // The same cap .hours-times .input takes, which is what the comment
    // above it claims to be following.
    expect(css).toContain(".hours-times .input { max-width: 130px; }");
    // Both selects are the row's own children, and the block holds the
    // two buttons and nothing else.
    const menuAdmin = source("../../components/admin/MenuAdmin.tsx");
    const row = menuAdmin.slice(
      menuAdmin.indexOf('className={out ? "menu-item-row is-out" : "menu-item-row"}'),
    );
    const actions = row.indexOf('<div className="menu-edit-row-actions">');
    expect(row.indexOf("${item.name} on the phone")).toBeLessThan(actions);
    expect(row.indexOf("${item.name} as a pick")).toBeLessThan(actions);
    expect(row.slice(actions, row.indexOf("</div>", actions))).not.toContain("<select");
  });

  it("keeps the row's controls a thumb's width apart once they are 44px", () => {
    /* The other half of moving the selects out of .menu-edit-row-actions.
       That block is named in the coarse-pointer "separation" rule, so
       while every control on a dish lived inside it, all of them got
       --touch-gap. Out on the row they take .menu-item-row's own gap,
       which is --space-2's 6.8px -- under the 8px floor that block
       exists to enforce, and enforced against controls the SAME media
       query has just raised to 44px: `.input, select` and the row's own
       buttons. Three adjacencies regressed at once -- select to select,
       select to the actions block, and, on the wrapped line, the select
       above Remove, which destroys a dish with no undo.

       So the row is in the list. It is not a new class and not a new
       number; --touch-gap is --space-3, 10.2px, which is the next step
       on the system's own scale. */
    const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
    const rule = coarse.slice(
      coarse.indexOf("── separation "),
      coarse.indexOf("gap: var(--touch-gap);", coarse.indexOf("── separation ")),
    );
    expect(rule).toContain(".menu-item-row,");
    expect(rule).toContain(".menu-edit-row-actions,");

    // The gap it is being raised FROM, still declared once, unchanged
    // for a fine pointer -- the coarse rule is a floor, not a redesign.
    // (no dotAll flag: the target predates es2018, and `[^}]` already
    // spans the newlines inside the block.)
    expect(css).toMatch(/\.menu-item-row \{[^}]*gap: var\(--space-2\);/);

    // And the raise cannot push the pair of selects off the card: 130 +
    // 10.2 + 130 = 270.2 in the 328.6px row the cap above was measured
    // against.
    expect(css).toContain("--touch-gap: var(--space-3);");
    expect(source("../../app/industry.css")).toContain("--space-3: 10.2px;");
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
    // offers several -- the back link in the page head and three
    // AdminNav items. Under tabs, eight of the nine surfaces holding
    // typing are display:none while one of those is pressed, so a chip
    // on a tab is not enough on its own. Rendered only when something is
    // actually unsaved.
    const tabs = source("../../components/admin/ConsoleTabs.tsx");
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
       components/admin/ConsoleTabs.guard.test.tsx; this assertion is only
       that the page SAYS it. The second is the hole it does not cover,
       because popstate arrives after the history entry has already
       changed and "cancelling" it means fighting the operator's own Back
       button. If someone ever guards Back too, this test is what tells
       them the sentence has to stop saying it doesn't. */
    expect(tabs).toMatch(/link out of this page asks first/i);
    expect(tabs).toMatch(/Back button does not, and\s+loses them/i);

    // Not on screen when there is nothing to say.
    expect(strip()).not.toContain("setup-note");
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
          pick_label: null,
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

/* ── the pick has to be visible without opening the row ─────────────── */

describe("a dish the restaurant nominated", () => {
  // The collapsed row -- editing=false, MenuAdmin's default render, the
  // same branch "Not offered" and "sort N" already render in -- because
  // the control that sets pick_label lives one level deeper, inside a
  // row's own edit form, and an operator hits the three-pick cap before
  // they have any reason to expand all of them looking for which dishes
  // are already marked.
  function pick(label: "best_seller" | "chefs_special", sold: boolean): string {
    return menu({
      items: [
        {
          id: ITEM,
          category_id: CATEGORY,
          name: "Carbonara",
          description: null,
          price_cents: 2200,
          allergen_note: null,
          sort_order: 0,
          sold_out_until: sold ? "close" : null,
          pick_label: label,
        },
      ],
    });
  }

  // The chip has to name WHICH kind now, not just that there is one:
  // there are two, they are different sentences out of the agent's
  // mouth, and "pick" on its own no longer tells an operator which one
  // this restaurant chose for this dish.
  it("says which kind of pick it is, on the collapsed row", () => {
    expect(prose(pick("best_seller", false))).toContain("Best seller");
    // The curly apostrophe is the rendered one: the option labels come
    // from lib/menu.ts's PICK_LABEL, and JSX text may not carry a bare
    // ' anyway (react/no-unescaped-entities).
    expect(prose(pick("chefs_special", false))).toContain("Chef\u2019s special");
    expect(pick("best_seller", false)).toContain("tag tag-outline edit-flag");
  });

  it("is silent, and says so, once the pick is also sold out", () => {
    // lib/agent/menu.ts drops `pick` from the payload while the item is
    // sold out -- a sold-out pick still fills one of the trigger's three
    // slots (the trigger and this form's own picksUsed agree on that)
    // but reaches no caller, so it produces no warmth. Three spent slots
    // can add up to zero warmth with nothing on the card saying why; the
    // one marker has to carry which of the two states a pick is in as
    // well as which kind it is.
    const html = pick("best_seller", true);
    expect(html).toContain("tag tag-out edit-flag");
    expect(prose(html)).toContain("Not offered");
    expect(html).toContain("tag tag-neutral edit-flag");
    expect(prose(html)).toContain("Silent best seller");

    expect(prose(pick("chefs_special", true))).toContain("Silent chef\u2019s special");
  });

  it("is absent from a dish that was never nominated", () => {
    // Asserted against the CHIP rather than against the page's prose:
    // both kinds are now named on every row by the pick control itself,
    // which is the whole point of that control existing. What must not
    // appear on an un-nominated dish is the mark that claims the
    // restaurant chose it.
    const html = menu();
    expect(html).not.toContain("edit-flag");
    expect(prose(html)).not.toContain("Silent");
  });
});

describe("the pick control on a dish's row", () => {
  /* IT MOVED, and that is the defect this block now guards. The control
     used to sit inside the row's own edit form, behind the Edit button:
     the words "pick", "best seller" and "chef's special" appeared
     NOWHERE on the Menu tab until an operator had already opened a dish
     and scrolled past six other fields. The owner's report was "i see no
     option in the menu to label them", on a screen where fourteen rows
     each carried a sold-out select on the row itself.

     The asymmetry was the bug. The sold-out control is on the collapsed
     row so that a scan down the card shows what the agent is refusing
     without reading every dropdown; the identical reasoning applies to
     what the agent is PRAISING, and to whether the operator knows they
     may praise anything at all. So this is the same shape of control,
     beside it, writing on change through its own action. */

  const OTHER = "17e00000-0000-0000-0000-0000000000e2";
  const THIRD = "17e00000-0000-0000-0000-0000000000e3";
  const FOURTH = "17e00000-0000-0000-0000-0000000000e4";

  function dish(id: string, name: string, pick: "best_seller" | "chefs_special" | null) {
    return {
      id,
      category_id: CATEGORY,
      name,
      description: null,
      price_cents: 2200,
      allergen_note: null,
      sort_order: 0,
      sold_out_until: null,
      pick_label: pick,
    };
  }

  /** The row as it is actually rendered -- editing=false, MenuAdmin's
   *  default branch, the one renderToStaticMarkup enters. Nothing below
   *  needs the source to see this control any more. */
  function rows(...items: ReturnType<typeof dish>[]): string {
    return menu({ items });
  }

  it("is on the collapsed row, beside the sold-out select", () => {
    const html = rows(dish(ITEM, "Carbonara", null));

    // Named for the dish, the way the sold-out control beside it is.
    expect(html).toContain('aria-label="Carbonara on the phone"');
    expect(html).toContain('aria-label="Carbonara as a pick"');

    // Both selects stand ahead of Edit and Remove, and outside the block
    // that holds them: .menu-edit-row-actions is nowrap so that Remove
    // never comes apart from Edit, and a fourth control inside it would
    // be a bar too wide for a 300px card to wrap out of.
    const soldOut = html.indexOf('aria-label="Carbonara on the phone"');
    const pick = html.indexOf('aria-label="Carbonara as a pick"');
    const actions = html.indexOf("menu-edit-row-actions");
    expect(soldOut).toBeGreaterThan(-1);
    expect(pick).toBeGreaterThan(soldOut);
    expect(actions).toBeGreaterThan(pick);

    // ...and it is no longer inside the edit form, where an operator had
    // to open a dish to find out the feature existed.
    expect(source("../../components/admin/MenuAdmin.tsx")).not.toContain("ma-item-pick-");
  });

  it("is a select over the two kinds plus not-a-pick, like the sold-out one", () => {
    // The neighbouring control on this same row is already a select over
    // a constrained set with an explicit "none of them" option, and this
    // is the same shape of choice. A second shape for the same job is
    // how a 34-class system became a 73-class one.
    const menuAdmin = source("../../components/admin/MenuAdmin.tsx");
    const control = menuAdmin.slice(menuAdmin.indexOf("${item.name} as a pick"));
    expect(control).toMatch(/<option value="">Not a pick<\/option>/);
    /* Both kinds wear the CAP, because the cap counts both: at three
       picks neither label can be added to a fourth dish. It is worn by
       the options and not by the select -- see "keeps the control
       reachable" below for why that distinction is the whole point. */
    expect(control).toMatch(
      /<option value="best_seller" disabled=\{capReached\}>\s*\n\s*\{PICK_LABEL\.best_seller\}\s*\n\s*<\/option>/,
    );
    // And one of them wears the one-per-restaurant courtesy as well, on
    // top of the cap -- the test at the bottom of this block pins that
    // the OTHER one never grows it.
    expect(control).toMatch(
      /<option value="chefs_special" disabled=\{capReached \|\| specialTaken\}>\s*\n\s*\{PICK_LABEL\.chefs_special\}\s*\n\s*<\/option>/,
    );
    // The wearing of .input is what puts it on the same rail as every
    // other field on the row, and what the coarse-pointer rule below
    // reaches.
    expect(control).toMatch(/className="input"/);

    // Rendered, the three choices are the three the column admits.
    // (renderToStaticMarkup marks the chosen one with `selected`, which
    // is why the "not a pick" option is matched rather than compared.)
    const html = rows(dish(ITEM, "Carbonara", null));
    expect(html).toMatch(/<option value=""[^>]*>Not a pick<\/option>/);
    expect(html).toContain('<option value="best_seller">Best seller</option>');
    expect(html).toContain("Chef\u2019s special</option>");
  });

  it("writes on the change, through an action of its own", () => {
    // One control, one write, exactly as the sold-out select beside it:
    // no Save button, no edit form, no six other columns re-sent. The
    // row's own pending helper is what disables it while the write is in
    // flight, so a double change cannot race itself.
    const menuAdmin = source("../../components/admin/MenuAdmin.tsx");
    expect(menuAdmin).toContain(
      "onChange={(e) => run(() => setSoldOutAction(locationId, item.id, e.target.value))}",
    );
    expect(menuAdmin).toContain(
      "onChange={(e) => run(() => setPickAction(locationId, item.id, e.target.value))}",
    );
    // And the edit form no longer carries a second control for the same
    // column that would save at a different moment: its patch sends the
    // empty string, which lib/admin/edit.ts's saveMenuItem drops on the
    // floor along with sold-out.
    expect(menuAdmin).toContain('pickLabel: ""');
    expect(menuAdmin).not.toMatch(/pickLabel: pickLabel/);
  });

  it("shows the kind that is on file as the selected one", () => {
    // The control must never sit on "Not a pick" while the chip beside
    // it says the dish is the chef's special: they are one fact.
    const html = rows(dish(ITEM, "Carbonara", "chefs_special"));
    expect(html).toContain('<option value="chefs_special" selected="">');
    expect(html).toContain("tag tag-outline edit-flag");
  });

  it("takes its touch target from the rule every select on the page uses", () => {
    // This replaced a checkbox, which needed a class of its own
    // (.menu-edit-pick) and a label wrapped round it, because a checkbox
    // is 13px of chrome CSS cannot resize. A <select> is not: `.input,
    // select { min-height: var(--touch-target) }` already covers it, so
    // the bespoke class went with the checkbox rather than lingering as
    // dead CSS naming a control that no longer exists.
    const css = source("../../app/app.css");
    const head = css.indexOf("── fields ");
    const rule = css.slice(head, css.indexOf("}", css.indexOf("min-height", head)) + 1);
    expect(rule).toContain(".input,");
    expect(rule).toContain("select");
    expect(rule).toContain("min-height: var(--touch-target);");

    expect(css).not.toContain("menu-edit-pick");
    expect(source("../../components/admin/MenuAdmin.tsx")).not.toContain("menu-edit-pick");
  });

  it("says why it is unavailable when the restaurant is at its three", () => {
    // The trigger is the guarantee; this only stops an operator spending
    // a round trip to be told. picksUsed counts LABELS, not `true`s --
    // counting truthiness of a string would count "" as a pick.
    const menuAdmin = source("../../components/admin/MenuAdmin.tsx");
    expect(menuAdmin).toContain(
      "allItems.filter((other) => other.pick_label !== null).length",
    );
    expect(menuAdmin).toContain("picksUsed >= 3 && item.pick_label === null");
    expect(menuAdmin).toMatch(/Three dishes are already picked/);

    /* Rendered: at three picks the two labels are shut on a dish that is
       NOT one of them, because either one is a write the trigger will
       refuse. */
    const full = rows(
      dish(ITEM, "Carbonara", "best_seller"),
      dish(OTHER, "Amatriciana", "best_seller"),
      dish(THIRD, "Cacio e Pepe", "chefs_special"),
      dish(FOURTH, "Tiramisu", null),
    );
    const shut = full.slice(full.indexOf('aria-label="Tiramisu as a pick"'));
    expect(shut.slice(0, 300)).toContain('<option value="best_seller" disabled=""');
    expect(shut.slice(0, 300)).toContain('<option value="chefs_special" disabled=""');

    // The three that hold a slot keep their labels open: the trigger's
    // "already counted" branch lets a pick be re-worded or cleared, and
    // clearing one is the only way back under the cap. The whole opening
    // tag is compared, so a `disabled` on it would fail this.
    expect(full).toContain('<select class="input" aria-label="Carbonara as a pick">');
    expect(full).toContain('<select class="input" aria-label="Cacio e Pepe as a pick">');
    const holder = full.slice(full.indexOf('aria-label="Carbonara as a pick"'));
    expect(holder.slice(0, 300)).toContain('<option value="best_seller"');
    expect(holder.slice(0, 300)).not.toContain('<option value="best_seller" disabled');
  });

  it("keeps the control reachable at the cap instead of shutting it", () => {
    /* THE CAP CLOSES THE OPTIONS, NEVER THE SELECT. Shutting the select
       was the first shape of this and it re-made the reported bug on the
       far side: `disabled` takes an element out of the tab order, so on
       the fourteen-item restaurant that had used its three picks, the
       eleven other rows carried a faded box that no keyboard and no
       screen reader could reach at all -- "i see no option in the menu to
       label them" all over again, for the operator with the fewest ways
       to go looking. It also swallowed the click: nothing fired, so no
       action ran, so not even a refusal was printed under the row.

       A disabled OPTION cannot be chosen either -- the courtesy is
       whole, nothing certain to be refused is offered -- but the control
       is still tabbed to, still announced with its label, and still
       reads out the kind on file. And it is the mechanism this row
       already used for the chef's special, so there is one of them. */
    const menuAdmin = source("../../components/admin/MenuAdmin.tsx");
    const control = menuAdmin.slice(menuAdmin.indexOf("${item.name} as a pick"));
    expect(control.slice(0, 1400)).toContain("disabled={pending}");
    expect(control.slice(0, 1400)).not.toContain("disabled={pending || capReached}");

    /* Rendered, on the dish the cap applies to: the opening tag carries
       the label and nothing else. Compared whole, so a `disabled` on it
       fails here. */
    const full = rows(
      dish(ITEM, "Carbonara", "best_seller"),
      dish(OTHER, "Amatriciana", "best_seller"),
      dish(THIRD, "Cacio e Pepe", "chefs_special"),
      dish(FOURTH, "Tiramisu", null),
    );
    expect(full).toContain('<select class="input" aria-label="Tiramisu as a pick">');
    expect(full).not.toContain('aria-label="Tiramisu as a pick" disabled');
    // The sold-out select beside it is disabled by the same one thing
    // and nothing else, which is the shape being matched.
    expect(full).toContain('<select class="input" aria-label="Tiramisu on the phone">');
  });

  it("names the dishes that are holding the three slots", () => {
    /* A rule that says three are taken without saying WHICH three sends
       an operator hunting a grid of category cards for chips -- and the
       note sits above SoldOutNow and the whole grid, so it is a scroll
       away from the row it is explaining. SoldOutNow answers the sibling
       question by naming every dish in the blocking state where it can
       be read from the top of the page; the cap now does the same, in
       the sentence it was already rendering. */
    const full = rows(
      dish(ITEM, "Carbonara", "best_seller"),
      dish(OTHER, "Amatriciana", "best_seller"),
      dish(THIRD, "Cacio e Pepe", "chefs_special"),
      dish(FOURTH, "Tiramisu", null),
    );
    const text = prose(full);
    expect(text).toContain(
      "Three dishes are already picked \u2014 Carbonara, Amatriciana, Cacio e Pepe.",
    );
    expect(text).toContain("Set one of those back to \u201cnot a pick\u201d on its row");
    // The dish that is NOT a pick is not in that list.
    expect(text).not.toMatch(/already picked[^.]*Tiramisu/);

    // Under the cap there is no such sentence to name anything in.
    expect(prose(rows(dish(ITEM, "Carbonara", "best_seller")))).not.toContain(
      "already picked",
    );
  });

  it("offers the chef's special to one dish at a time, and says why", () => {
    // menu_items_one_chefs_special_idx (23505) is the guarantee, exactly
    // as the cap trigger is for the count above -- this is the courtesy
    // in front of it. The rule is not a matter of taste: lib/agent/menu.ts
    // sends "the chef's special", definite, and the prompt lets the agent
    // name two picks in one call, so two dishes holding the label is the
    // assistant contradicting itself to a caller.
    const menuAdmin = source("../../components/admin/MenuAdmin.tsx");
    expect(menuAdmin).toContain('other.pick_label === "chefs_special"');
    // Excludes this row: the dish that already holds the label has to be
    // able to keep it, and to be re-worded or cleared -- the same reason
    // capReached is not a bare `picksUsed >= 3`.
    expect(menuAdmin).toContain("other.id !== item.id && other.pick_label ===");
    // The sentence moved to the Menu card with the count, because it is
    // a fact about the RESTAURANT and not about the row it was written
    // under -- thirteen rows repeating it is furniture, and furniture is
    // not read. It NAMES the dish, for the reason the cap's sentence
    // names its three: a card-width above the grid, "that dish alone" is
    // an instruction to go and find out which.
    expect(menuAdmin).toMatch(
      /is already the chef&rsquo;s special, so that option is\s+offered on that dish alone/,
    );
    expect(menuAdmin).toContain("\u201c{special.name}\u201d is already the chef&rsquo;s special");
    /* "best seller" carries no ONE-AT-A-TIME rule and must not grow one:
       any number of dishes can be one of several best sellers, which is
       what makes the phrase lib/agent/menu.ts sends partitive. The cap
       is a different rule and applies to both kinds, so the claim is
       pinned where it is actually made -- specialTaken must never reach
       this option -- rather than by forbidding the word `disabled` on
       it, which the cap now legitimately puts there. */
    const control = menuAdmin.slice(menuAdmin.indexOf("${item.name} as a pick"));
    const bestSeller = control.slice(control.indexOf('<option value="best_seller"'));
    expect(bestSeller.slice(0, 120)).not.toContain("specialTaken");

    /* Rendered: the option is shut on every OTHER dish, and open on the
       one that holds it. */
    const html = rows(
      dish(ITEM, "Carbonara", "chefs_special"),
      dish(OTHER, "Amatriciana", null),
    );
    const other = html.slice(html.indexOf('aria-label="Amatriciana as a pick"'));
    expect(other.slice(0, 300)).toContain('<option value="chefs_special" disabled=""');
    const holder = html.slice(html.indexOf('aria-label="Carbonara as a pick"'));
    expect(holder.slice(0, 300)).toContain('<option value="chefs_special" selected=""');
    /* And rendered: "best seller" stays open on the dish that is not the
       special. One pick is in use here, so the cap is nowhere near and
       the only rule in play is the one that must not touch this option. */
    expect(other.slice(0, 300)).toContain('<option value="best_seller">');
    expect(prose(html)).toContain(
      "\u201cCarbonara\u201d is already the chef\u2019s special, so that option is offered on that dish alone.",
    );
  });
});

describe("finding out that a dish can be picked at all", () => {
  it("is said on the Menu card, before any dish has ever been picked", () => {
    /* The chip on a row names the picks a restaurant HAS. Production
       holds zero, so on the screen this was reported from no chip
       rendered anywhere and the feature was invisible until after it had
       been used. A control on every row is most of the answer; the
       sentence that says what the control is for, and what the two rules
       are, is the rest of it. */
    const text = prose(menu());
    expect(text).toMatch(/best sellers/i);
    expect(text).toMatch(/chef\u2019s special/i);
    expect(text).toMatch(/three dishes/i);
    // Not the cap's refusal: nothing has been picked here.
    expect(text).not.toContain("Three dishes are already picked");
  });

  it("does not promise more warmth than the prompt allows", () => {
    /* The card is describing something the agent does, so the two have
       to agree. lib/agent/prompt.ts -- hash-pinned, and not this
       change's to edit -- allows "you may say once that it is that pick"
       and "At most twice in a whole call". A card that reads as though
       every pick is named on every call is a promise an operator repeats
       to a restaurant owner down the phone. */
    expect(source("../agent/prompt.ts")).toContain("At most twice in a whole call");
    expect(prose(menu())).toMatch(/at most twice in a whole call/i);
  });

  it("says nothing at all on a restaurant with no menu yet", () => {
    // A rule about rows that do not exist is furniture on the emptiest
    // version of this screen, where the only useful sentence is "add a
    // category".
    const text = prose(menu({ categories: [], items: [] }));
    expect(text).not.toMatch(/best sellers/i);
    expect(text).toContain("No categories yet");
  });
});
