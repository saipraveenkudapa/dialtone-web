import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditTabs, useSectionDirty } from "@/components/admin/EditTabs";

/* The unsaved-edits guard, dispatched at rather than read.
 *
 * WHY THIS FILE IS NOT UNDER lib/. Everything else in this repo is
 * tested in the "node" project, where a component is put through
 * renderToStaticMarkup and the assertion is about what a reader reads.
 * That cannot reach this: useLeaveGuard has no markup and no return
 * value until a click has happened. It is a capture-phase listener on
 * `document` that either calls preventDefault or does not, and with no
 * DOM there is no effect to run it and no click to give it. The only
 * assertions available were regexes over EditTabs.tsx's own source --
 * which prove the file contains a string, not that anything guards
 * anything. A typo'd selector, an effect that never registered, or a
 * listener attached in bubble phase would have left them all green.
 *
 * So: vitest.config.ts's "jsdom" project, real <a> elements, real
 * MouseEvents, and assertions on event.defaultPrevented -- which is the
 * entire mechanism. next/dist/client/app-dir/link.js opens its click
 * handler with `if (e.defaultPrevented) return`, and React copies
 * defaultPrevented off the native event when it builds the synthetic
 * one, so preventDefault on the way down is what stands the router down.
 *
 * THE CASES THAT MUST BE LET THROUGH ARE HALF THE TEST. A guard that
 * intercepts a Cmd-click has broken open-in-new-tab for a page that
 * loses nothing by it; one that intercepts a same-pathname link has
 * broken the editor's own ?section= links. Those get as many assertions
 * as the interception does.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const EDITOR = "/admin/a10c0000-0000-0000-0000-00000000000a/edit";

/* React's own switch for act(): without it every act() call warns that
   the test environment was not configured for it. Declared rather than
   cast because globalThis has no index signature under `strict`. */
declare global {
  // `var` and not let/const: a global augmentation has to be one.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;

/** A section that reports itself unsaved, or not. Real reporter, real
 *  context -- the dirty set the guard registers on is the one the
 *  product's own hook produces. */
function Section({ dirty }: { dirty: boolean }) {
  useSectionDirty("hours", dirty);
  return <p>a half-typed week</p>;
}

function mount(dirty: boolean) {
  act(() => {
    root.render(
      <EditTabs initial="business" behind={[]}>
        <Section dirty={dirty} />
      </EditTabs>,
    );
  });
}

/** A real anchor in the real document, pressed with a real MouseEvent.
 *
 *  `prevented` is read from a listener on the ANCHOR ITSELF, and that
 *  placement is the assertion about phase. Dispatch order is: capture
 *  listeners from the top down, then the target's own listeners, then
 *  bubble listeners upward. So a listener here sees defaultPrevented
 *  only if the guard ran in CAPTURE phase on document. Were the guard a
 *  bubble-phase listener on document -- which is where next/link's own
 *  handler sits, since the App Router's root container is `document`
 *  itself (`const appElement = document`, next/dist/client/app-index.js)
 *  -- it would run after this and this would read false. Registration
 *  order on document would hide that difference; a listener on the
 *  target cannot.
 *
 *  It also calls preventDefault unconditionally, AFTER reading. jsdom
 *  otherwise attempts the anchor's default action for every press the
 *  guard lets through and floods the run with "Not implemented:
 *  navigation to another Document". The read has already happened by
 *  then, so nothing is masked. */
function press(
  attrs: Record<string, string>,
  init: MouseEventInit = {},
): { prevented: boolean } {
  const anchor = document.createElement("a");
  for (const [name, value] of Object.entries(attrs)) anchor.setAttribute(name, value);
  anchor.textContent = "Overview & go-live";
  document.body.appendChild(anchor);

  let prevented = false;
  anchor.addEventListener("click", (event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  });

  act(() => {
    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }),
    );
  });

  anchor.remove();
  return { prevented };
}

const dialog = () => container.querySelector(".edit-leave-backdrop");

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
  if (!found) throw new Error(`no button reading "${label}"`);
  return found;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  push.mockClear();
  window.history.replaceState({}, "", `${EDITOR}?section=hours`);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("a link out of the editor with typing still in it", () => {
  it("is stopped, and stopped before the router sees it", () => {
    mount(true);

    const { prevented } = press({ href: "/admin/a10c0000-0000-0000-0000-00000000000a" });

    // Read on the anchor itself, so this is a claim about PHASE: the
    // guard had already stopped the press before the target's own
    // handlers, let alone next/link's on the way back up.
    expect(prevented).toBe(true);
    expect(dialog()).not.toBeNull();
  });

  it("names the section the typing is in, so the dialog is about something", () => {
    mount(true);
    press({ href: "/admin/x" });

    expect(dialog()?.textContent).toContain("Hours has unsaved changes");
  });

  it("keeps the typing when the answer is Stay, and goes nowhere", () => {
    mount(true);
    press({ href: "/admin/x" });

    act(() => button("Stay on this page").click());

    expect(dialog()).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("completes the navigation, exactly as pressed, when the answer is Leave", () => {
    mount(true);
    press({ href: "/admin/x/edit?section=menu#sold-out" });

    act(() => button("Leave and lose them").click());

    expect(dialog()).toBeNull();
    // Path AND search AND hash: dropping the query would land the
    // operator on the wrong tab of the page they chose.
    expect(push).toHaveBeenCalledWith("/admin/x/edit?section=menu#sold-out");
  });

  it("escapes to Stay, never to Leave", () => {
    mount(true);
    press({ href: "/admin/x" });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(dialog()).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("what the guard deliberately lets through", () => {
  beforeEach(() => mount(true));

  /* Every one of these either opens somewhere else and LEAVES THIS PAGE
     STANDING -- so there is nothing to lose -- or is already covered by
     the beforeunload guard the sections hold, and asking twice for one
     press is worse than not asking. */
  it.each([
    ["Cmd-click", { metaKey: true }],
    ["Ctrl-click", { ctrlKey: true }],
    ["Shift-click", { shiftKey: true }],
    ["Alt-click", { altKey: true }],
    ["middle-click", { button: 1 }],
  ])("%s, which opens elsewhere and leaves this page up", (_name, init) => {
    expect(press({ href: "/admin/x" }, init).prevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("a link to this same pathname, which the panels survive", () => {
    // ?section= and #menu are how the editor navigates itself. Nothing
    // unmounts through them; that is the whole design.
    expect(press({ href: `${EDITOR}?section=menu` }).prevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("a cross-origin href, which beforeunload already covers", () => {
    expect(press({ href: "https://dashboard.vapi.ai/calls" }).prevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("target=_blank and download, which open without leaving", () => {
    expect(press({ href: "/admin/x", target: "_blank" }).prevented).toBe(false);
    expect(press({ href: "/export.csv", download: "" }).prevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("an anchor with no href at all, which is not a navigation", () => {
    expect(press({}).prevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("a press that something else already cancelled", () => {
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "/admin/x");
    document.body.appendChild(anchor);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    event.preventDefault();
    act(() => {
      anchor.dispatchEvent(event);
    });
    anchor.remove();

    // Already stopped by someone else; this guard does not get to put a
    // dialog in front of a press that was never going anywhere.
    expect(dialog()).toBeNull();
  });
});

describe("a clean editor", () => {
  it("behaves exactly as it did before this guard existed", () => {
    mount(false);

    expect(press({ href: "/admin/x" }).prevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("stops guarding the moment the typing is saved", () => {
    mount(true);
    // The save lands: the section reports itself clean, the dirty set
    // empties, and the effect's cleanup has to take the listener with
    // it. A guard that outlives its reason asks about a page with
    // nothing on it.
    mount(false);

    expect(press({ href: "/admin/x" }).prevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("leaves nothing on document after the editor unmounts", () => {
    mount(true);
    act(() => root.unmount());

    expect(press({ href: "/admin/x" }).prevented).toBe(false);

    // Re-rooted so afterEach's unmount has something to unmount.
    root = createRoot(container);
  });
});
