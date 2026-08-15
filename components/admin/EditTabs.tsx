"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Corners } from "@/components/Corners";

/* The editor's eight subjects, one on screen at a time.
 *
 * WHAT THIS REPLACED, AND WHY
 * ---------------------------
 * /edit used to be nine cards in one column: 8210px of document, with
 * the Menu heading 5346px down it. The operator's words were "it's like
 * a stack ... I just have to scroll all the way to the down. I don't
 * like it ... I just want to click on the section." Asked how a section
 * should open they chose tabs -- swap in place, one section on screen,
 * nothing below it. Not an overlay, not an accordion.
 *
 * NOTHING UNMOUNTS
 * ----------------
 * Every panel is rendered on every render; the inactive ones carry
 * `hidden`. Conditional rendering was rejected outright: the sections'
 * form state (useSeeded's fields, WeeklyHours' days, every half-typed
 * price in MenuAdmin) lives in useState, and unmounting destroys it
 * silently. A half-typed week lost because somebody checked the menu is
 * exactly the failure tabs must not introduce. `display: none` also
 * takes the hidden panels out of the a11y tree, out of the focus order
 * and out of find-in-page, so only the visible tab is reachable by Tab,
 * by a screen reader or by Ctrl-F.
 *
 * ...WHICH IS ALSO WHY THE STRIP CARRIES MARKS
 * --------------------------------------------
 * Seven of the eight dirty surfaces are display:none at any moment, so
 * a card's own "Unsaved" flag can be somewhere nobody can read it. The
 * strip is then the only visible sign, which is what useSectionDirty
 * and useSectionReplaced below are for, and why the strip states the
 * unsaved sections in words underneath itself as well as in chips.
 *
 * PRESENTATION ONLY
 * -----------------
 * This module reads no id, calls no action and writes nothing. The tab
 * is client state and the only thing it decides is which panel is
 * visible. app/admin/[locationId]/edit/page.tsx validates `?section=`
 * against a fixed eight-item list before it ever reaches this file; it
 * is never an id, never reaches Postgres or Vapi, and no "use server"
 * export gained a parameter for it. locationId remains the only
 * caller-supplied id on the route and is still uuid-validated.
 */

export type EditSectionId =
  | "business"
  | "hours"
  | "answering"
  | "service"
  | "orders"
  | "recording"
  | "menu"
  | "managed";

/** The tabs, in the order the page used to render the cards.
 *
 *  Eight, not the ten <section id>s on the page: #holidays is a
 *  sub-card of Hours and #sold-out a sub-card of Menu, and both stay
 *  inside their parent's panel. A holiday is an override of a weekly
 *  row -- "we close at 3 on Christmas Eve" is unjudgeable without
 *  Tuesday's normal hours on the same screen -- so splitting them would
 *  put the two halves of one decision behind a click.
 *
 *  The labels are the cards' own headings, shortened. That is a
 *  measurement rather than taste: at 768px the column is 712px wide, and
 *  the full headings ("The business", "Answering the phone", "Where
 *  orders go") measure past it, so the strip would wrap at rest on the
 *  exact device the complaint came from. The short set leaves about
 *  130px of headroom -- one "Unsaved" chip -- before anything wraps.
 *  Each panel's own <h2> still carries the full heading, so an operator
 *  who pressed "Answering the phone" on /admin/<id> lands on a tab
 *  reading Answering over a card reading Answering the phone. */
export const EDIT_SECTIONS: readonly { id: EditSectionId; label: string }[] = [
  { id: "business", label: "Business" },
  { id: "hours", label: "Hours" },
  { id: "answering", label: "Answering" },
  { id: "service", label: "Money & service" },
  { id: "orders", label: "Orders" },
  { id: "recording", label: "Recording" },
  { id: "menu", label: "Menu" },
  { id: "managed", label: "System" },
];

export const DEFAULT_SECTION: EditSectionId = "business";

function labelOf(id: EditSectionId): string {
  return EDIT_SECTIONS.find((section) => section.id === id)?.label ?? id;
}

/** Which tab an old in-page anchor opens.
 *
 *  The hash stays the contract, permanently and not as a migration
 *  step. /edit#menu is pasted into tickets, bookmarked and mailed, and
 *  those URLs can never be rewritten. All ten ids stay on their sections
 *  in the DOM; nothing was renamed. #holidays and #sold-out map to their
 *  parent's tab because that is where their card now lives.
 *
 *  components/admin/GoLive.tsx still sends its three checklist rows to
 *  #menu, #hours and #answering and needs no edit for this to work.
 *
 *  READ IT THROUGH sectionOfAnchor(), NEVER BY INDEXING IT. */
export const SECTION_OF_ANCHOR: Record<string, EditSectionId> = {
  business: "business",
  hours: "hours",
  holidays: "hours",
  answering: "answering",
  service: "service",
  orders: "orders",
  recording: "recording",
  menu: "menu",
  "sold-out": "menu",
  managed: "managed",
};

/** The map read safely: an unknown anchor is undefined, and so is an
 *  inherited one.
 *
 *  The hash is the one part of the URL the browser hands over unfiltered
 *  and it is not validated anywhere upstream, so `SECTION_OF_ANCHOR[hash]`
 *  is a lookup on attacker-chosen text. An object literal inherits from
 *  Object.prototype, so /edit#constructor -- and #toString, #valueOf,
 *  #hasOwnProperty, #__proto__ -- returned a truthy value that is not an
 *  EditSectionId at all, sailed past a `if (!section)` guard, and left
 *  the editor blank: no tab checked, all eight panels hidden, the arrow
 *  keys dead (findIndex returns -1), and `?section=function%20Object()...`
 *  written into the URL so a reload did it again. There is no way back
 *  from that except editing the address bar.
 *
 *  Two guards, because either alone is a trap for the next reader:
 *  Object.hasOwn keeps the prototype out, and the membership check keeps
 *  the answer inside the eight tabs the strip can actually show. */
export function sectionOfAnchor(hash: string): EditSectionId | undefined {
  if (!Object.hasOwn(SECTION_OF_ANCHOR, hash)) return undefined;
  const section = SECTION_OF_ANCHOR[hash];
  return EDIT_SECTIONS.some((known) => known.id === section) ? section : undefined;
}

const tabDomId = (id: EditSectionId) => `edit-tab-${id}`;
const panelDomId = (id: EditSectionId) => `edit-panel-${id}`;

/* ── what each section has to say about itself ─────────────────────── */

/** `unsaved` -- typing that has not been written yet.
 *  `replaced` -- typing that a fresh server value has already taken
 *  away. Both are reported by the components that own the state, since
 *  only they know. */
type SectionMark = "unsaved" | "replaced";

type EditTabsContextValue = {
  active: EditSectionId;
  /** `mark: null` unregisters. Referentially stable. */
  report: (reporterId: string, section: EditSectionId, mark: SectionMark | null) => void;
};

const NO_SECTIONS: ReadonlySet<EditSectionId> = new Set<EditSectionId>();

/* The default is a no-op on purpose: HoursEditor and MenuAdmin claim in
   their own headers that they can be rendered standalone and from a
   test, and calling these hooks must not make that untrue. Outside an
   <EditTabs> the report goes nowhere and nothing renders differently. */
const EditTabsContext = createContext<EditTabsContextValue>({
  active: DEFAULT_SECTION,
  report: () => {},
});

function useSectionMark(section: EditSectionId, mark: SectionMark, on: boolean): void {
  const { report } = useContext(EditTabsContext);
  const reporterId = useId();

  useEffect(() => {
    report(reporterId, section, on ? mark : null);
    return () => report(reporterId, section, null);
  }, [report, reporterId, section, mark, on]);
}

/** Tell the page this component is holding unsaved typing.
 *
 *  TWO THINGS, AND THE SECOND ONE IS THE GUARD. It puts an "Unsaved"
 *  chip on the section's tab, and while `dirty` it registers the
 *  beforeunload warning -- so closing the tab or reloading asks first,
 *  from a panel that is display:none as much as from the one on screen.
 *
 *  The guard lives here rather than being copied into each caller
 *  because it was copied into two of them and missing from six: a
 *  half-edited dish, a half-typed category rename, a half-typed holiday
 *  and a half-typed new dish could all be destroyed by Ctrl-R with no
 *  prompt of any kind. lib/admin/edit.ts's stale-save refusal ends with
 *  "Reload the page and make the change again", so the operator was
 *  being told to do the thing that threw the other tab's work away.
 *  Every caller already computes exactly the boolean the guard needs.
 *
 *  What beforeunload cannot see is a client-side route change --
 *  pressing "Overview & go-live" in the page head. That half is
 *  <EditTabs>'s own, in useLeaveGuard below: it has the whole dirty set
 *  and can therefore name the sections, which a beforeunload dialog is
 *  not allowed to do.
 *
 *  One line per dirty-capable component; several reporters may sit in
 *  one section (Hours has the week, every holiday row and the add form)
 *  and they are OR'd, keyed by useId(), and unregistered on unmount. */
export function useSectionDirty(section: EditSectionId, dirty: boolean): void {
  useSectionMark(section, "unsaved", dirty);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

/** Tell the page this component's unsaved typing has already been taken
 *  away by a fresh server value. See <ReplacedNote /> for what happened. */
export function useSectionReplaced(section: EditSectionId, replaced: boolean): void {
  useSectionMark(section, "replaced", replaced);
}

/** What an operator gets instead of silence when their typing is gone.
 *
 *  Every action on this route calls revalidatePath, success or refusal,
 *  so ONE write anywhere on the page hands all eight panels fresh props
 *  at once. Each form then re-seeds during render if its own server
 *  values moved -- which is right, and deliberately so: a tab left open
 *  must not sit there showing an edit the database has already
 *  replaced. But it used to happen without a word. Flip one dish to
 *  sold out while the owner's own screen changes a weekly row, and the
 *  week somebody had retyped in the Hours tab was simply gone, on a
 *  panel that is display:none, with the tab's "Unsaved" chip
 *  disappearing in the same commit -- indistinguishable from their own
 *  save landing.
 *
 *  So the re-seed still happens, and now it says so: this line in the
 *  card, and a "Replaced" chip on the tab so it is legible from
 *  whichever tab the operator is actually looking at. It fires only
 *  when there was typing AND what arrived is not what was typed, so an
 *  operator's own save never trips it. Nothing about the write path,
 *  the fields or the saving changed. */
export function ReplacedNote({ when }: { when: boolean }) {
  if (!when) return null;
  return (
    <p className="setup-error">
      Another change to this restaurant arrived while this was open, so what had been typed here
      was replaced by what is now on file. Nothing was saved from it — retype it if it still
      applies.
    </p>
  );
}

function sameMembers(a: ReadonlySet<EditSectionId>, b: ReadonlySet<EditSectionId>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** "Hours", "Hours and Menu", "Hours, Menu and System". */
function sentenceList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/* ── leaving the page with typing still in it ──────────────────────── */

/** A press this guard stopped, and what it stopped it over. */
type PendingExit = {
  /** Where the press was going, as a path this app can route to. */
  href: string;
  /** The unsaved sections' labels, FROZEN at the moment of the press.
   *  Read live, a revalidation landing while the dialog is open could
   *  empty the set and leave the dialog asking about nothing. */
  labels: string[];
};

/** The other half of the unsaved-edits guard: an in-app route change.
 *
 *  WHAT beforeunload DOES NOT COVER. useSectionDirty above registers
 *  beforeunload, which is the browser's own hook and fires for a reload,
 *  a tab close and a real document navigation. A client-side route
 *  change is none of those: "Overview & go-live", the back link beside
 *  it and the three items in the operator bar are <Link>s, so Next
 *  swaps the tree in place, this component unmounts, and eight panels of
 *  useState go with it without a single event the browser would call an
 *  unload.
 *
 *  HOW THIS CATCHES IT, AND WHY NOT onNavigate. next/link takes an
 *  `onNavigate(e)` prop whose e.preventDefault() cancels the navigation,
 *  and for a link this module rendered that would be the tidier hook.
 *  It is per-link, and not one of the links that loses the work is in
 *  this file: three are in app/admin/[locationId]/edit/page.tsx, two
 *  more in components/admin/EditSections.tsx, and the last two are in
 *  components/admin/AdminNav.tsx and app/admin/layout.tsx -- the shell,
 *  which knows nothing about an editor and would have to be handed the
 *  editor's dirty state to use the prop at all. Eight anchors in four
 *  files, nine when the operator also owns a restaurant. A route with
 *  eight ways out needs one guard, not eight that a ninth link is added
 *  without.
 *
 *  So: one capture-phase click listener, which sees the press before the
 *  router does. React attaches its delegated listeners to the ROOT
 *  CONTAINER, and in the App Router that container is `document` itself
 *  (next/dist/client/app-index.js: `const appElement = document`), so
 *  <Link>'s onClick is a bubble-phase listener on document. A capture
 *  listener on document runs on the way down, before any of that.
 *
 *  preventDefault() alone is the whole stop, and both halves of it are
 *  checked rather than hoped for: it is what suppresses the anchor's own
 *  navigation, and next/dist/client/app-dir/link.js opens its click
 *  handler with `if (e.defaultPrevented) return` -- React copies
 *  defaultPrevented off the native event when it builds the synthetic
 *  one, so the router stands down on the same call. Nothing here calls
 *  stopPropagation: that would silence every other handler on the way
 *  up for a stop that does not need it.
 *
 *  WHAT IT DELIBERATELY LETS THROUGH.
 *    * Cmd/Ctrl/Shift/Alt-click, middle-click, target=_blank, download.
 *      All of them open somewhere else and LEAVE THIS PAGE STANDING, so
 *      there is nothing to lose and nothing to ask about.
 *    * A cross-origin href. That is a real document navigation, so
 *      beforeunload already fires -- guarding it here as well would ask
 *      twice for one press.
 *    * A link to this same pathname (?section=, #menu). The panels stay
 *      mounted through it; that is the whole design.
 *    * The browser's own Back button, and every other history move. No
 *      popstate guard, on purpose: popstate arrives AFTER the entry has
 *      already changed, so "cancelling" it means pushing a state back on
 *      to fight the operator's own button. beforeunload is what covers
 *      Back off this page to another origin; a Back that is a soft
 *      route change is not caught, and losing that is worth not
 *      breaking the button.
 *    * Sign out. It is a <form> posting a server action, not a link.
 *      Intercepting submits would put this listener in front of every
 *      save on the page, which is a far worse thing to get wrong. */
function useLeaveGuard(dirtySections: ReadonlySet<EditSectionId>) {
  const router = useRouter();
  const [exit, setExit] = useState<PendingExit | null>(null);
  const stayRef = useRef<HTMLButtonElement>(null);

  /* Registered only while something is unsaved, so a clean editor
     behaves exactly as it did before this existed. `dirtySections` is a
     new Set only when its MEMBERS change (see report()), so this is not
     re-registered on every keystroke. */
  useEffect(() => {
    if (dirtySections.size === 0) return;

    const labels = EDIT_SECTIONS.filter((section) => dirtySections.has(section.id)).map(
      (section) => section.label,
    );

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      // Left button only, unmodified: everything else either opens a new
      // tab or is not a navigation at all.
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      // instanceof rather than the selector's word: an <a> inside an SVG
      // is an SVGAElement, whose .href is not a string at all.
      const anchor = target.closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (!anchor.hasAttribute("href")) return;
      if (anchor.hasAttribute("download")) return;
      if (anchor.target !== "" && anchor.target !== "_self") return;

      // .href is already absolute; the base is belt and braces.
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;

      event.preventDefault();
      setExit({ href: `${url.pathname}${url.search}${url.hash}`, labels });
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirtySections]);

  /* The safe choice takes focus, and Escape is the safe choice too, so a
     stray Enter or Escape keeps the typing rather than throwing it away.
     Same shape as components/admin/GoLive.tsx's dialogs. */
  useEffect(() => {
    if (!exit) return;
    stayRef.current?.focus();
    /* globalThis. because this module imports React's own KeyboardEvent
       type for the strip's handler, and the bare name would resolve to
       that synthetic one rather than to the DOM's. */
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setExit(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [exit]);

  const stay = useCallback(() => setExit(null), []);

  /* Leaving stays possible, and it goes by the router rather than by
     re-firing the click: router.push is not a click, so this guard
     cannot catch its own answer, and it is a soft navigation, so the
     beforeunload guard the sections are still holding does not fire
     either. One press, one question, one answer. */
  const leave = () => {
    if (!exit) return;
    const { href } = exit;
    setExit(null);
    router.push(href);
  };

  return { exit, stay, leave, stayRef };
}

/* ── the strip ─────────────────────────────────────────────────────── */

export function EditTabs({
  initial,
  behind,
  children,
}: {
  /** From ?section=, already validated on the server, so the right
   *  panel is in the first byte of HTML and there is no wrong-tab
   *  flash to correct after hydration. */
  initial: EditSectionId;
  /** Sections whose assistant is stale, from the server's one Vapi
   *  read. Passed in rather than computed here so the chip is in the
   *  first paint and never appears mid-session. */
  behind: readonly EditSectionId[];
  /** The eight <EditPanel>s, rendered on the server. */
  children: ReactNode;
}) {
  const [active, setActive] = useState<EditSectionId>(initial);
  const [dirtySections, setDirtySections] = useState<ReadonlySet<EditSectionId>>(NO_SECTIONS);
  const [replacedSections, setReplacedSections] =
    useState<ReadonlySet<EditSectionId>>(NO_SECTIONS);
  const reporters = useRef<Map<string, { section: EditSectionId; mark: SectionMark }>>(new Map());
  const tabs = useRef<(HTMLInputElement | null)[]>([]);

  /* Stable for the life of the strip, so a keystroke that does not flip
     a mark costs no parent render, and so the reporting effects do not
     re-fire on every render of their own section. */
  const report = useCallback(
    (reporterId: string, section: EditSectionId, mark: SectionMark | null) => {
      const map = reporters.current;
      if (mark) {
        const held = map.get(reporterId);
        if (held && held.section === section && held.mark === mark) return;
        map.set(reporterId, { section, mark });
      } else {
        if (!map.has(reporterId)) return;
        map.delete(reporterId);
      }
      const unsaved = new Set<EditSectionId>();
      const replaced = new Set<EditSectionId>();
      for (const held of map.values()) {
        (held.mark === "unsaved" ? unsaved : replaced).add(held.section);
      }
      setDirtySections((prev) => (sameMembers(prev, unsaved) ? prev : unsaved));
      setReplacedSections((prev) => (sameMembers(prev, replaced) ? prev : replaced));
    },
    [],
  );

  /** A tab the operator chose. */
  const choose = useCallback((id: EditSectionId) => {
    setActive(id);

    /* Kept in the URL so a reload, a bookmark and a pasted link all
       land back here -- but with replaceState rather than a <Link>.
       A navigation would re-run this route's server function on every
       tab press: the whole getEditableRecord read plus readAssistantDrift,
       which is a Vapi GET with a five-second ceiling, per press, and a
       server re-render that risks the unsaved client state this whole
       design exists to protect.

       replaceState and never pushState: with push, nine tab presses fill
       the back stack and Back stops returning to /admin/<id>, which is
       where the operator came from and the one place Back must go.
       window.history.state is passed through rather than null because
       Next keeps its router tree in there. */
    const params = new URLSearchParams(window.location.search);
    params.set("section", id);
    window.history.replaceState(window.history.state, "", `?${params.toString()}`);

    /* Switching from deep inside a two-hundred-item Menu to a
       one-screen Business panel would otherwise leave the operator
       staring at the clamped bottom of a short document. Instant: the
       5275px slide that once needed smooth scrolling no longer exists. */
    window.scrollTo({ top: 0 });
  }, []);

  /* An arrival by hash: /edit#menu from a bookmark, or one of GoLive's
     three checklist rows. The hash is the most specific, most recently
     pressed thing on the URL, so it wins over ?section=, and it is then
     rewritten to ?section= and dropped so a reload does not fight it.
     A URL with neither is left exactly as it is -- a page that rewrites
     its own address on load with no user action is rude and pointless.

     sectionOfAnchor rather than an index: the hash is unvalidated text
     and the map is an object literal. Its comment has the detail. */
  useEffect(() => {
    const applyHash = () => {
      const hash = window.location.hash.slice(1);
      if (hash === "") return;
      const section = sectionOfAnchor(hash);
      if (!section) return;
      setActive(section);
      const params = new URLSearchParams(window.location.search);
      params.set("section", section);
      window.history.replaceState(window.history.state, "", `?${params.toString()}`);
      window.scrollTo({ top: 0 });
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  /* Arrow keys, Home and End across the strip, with the section
     changing as focus reaches it -- which costs nothing here: no fetch,
     no unmount, no loss.

     Handled rather than left to the radio group's own arrow behaviour so
     the movement is one explicit rule (Home and End are not native to a
     radio group at all) and so preventDefault stops Up and Down
     scrolling the page out from under the strip. preventDefault is also
     what keeps this from double-stepping: it suppresses the platform's
     own radio traversal, and this handler makes the single move. The
     group's shared `name` is still what gives the eight one tab stop,
     with only the selected one tabbable -- the roving tabindex, from
     the platform, free. */
  const onStripKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = EDIT_SECTIONS.length - 1;
    const from = EDIT_SECTIONS.findIndex((section) => section.id === active);
    if (from < 0) return;

    let to: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        to = from === last ? 0 : from + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        to = from === 0 ? last : from - 1;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = last;
        break;
      default:
        return;
    }

    event.preventDefault();
    choose(EDIT_SECTIONS[to].id);
    // preventScroll: the strip is already at the top of the document and
    // choose() has just scrolled there; nothing should move twice.
    tabs.current[to]?.focus({ preventScroll: true });
  };

  const value = useMemo<EditTabsContextValue>(() => ({ active, report }), [active, report]);

  const unsavedLabels = EDIT_SECTIONS.filter((section) => dirtySections.has(section.id)).map(
    (section) => section.label,
  );

  /* The in-app half of the unsaved-edits guard. It is here rather than
     in useSectionDirty because only this component has the whole dirty
     set, and naming the sections is the point: beforeunload is not
     allowed to say anything at all, so "Hours and Menu have unsaved
     changes" is a sentence only this side of the guard can write. */
  const { exit, stay, leave, stayRef } = useLeaveGuard(dirtySections);

  return (
    <>
      <div className="edit-tabs-head">
        {/* The house segmented control, worn rather than
            re-implemented: the same <div class="seg"> of
            <label class="seg-opt"> radios components/LoginForm.tsx
            already uses to swap a form in place, so the layout, the
            divider, the checked fill, the hover and the inset focus
            ring all come from app/industry.css and stay in step with
            it. .edit-tabs is the delta app/app.css adds on top -- it
            takes the panel column's width and wraps rather than
            scrolling sideways, which is what keeps all eight inside
            375px, since .seg is overflow: hidden and an option past the
            edge would be unreachable rather than merely awkward.

            .seg and not .nav because these are not routes: one of
            eight, chosen in place with the panel swapping under it, is
            what a segmented control means.

            AND IT IS A RADIO GROUP, WHICH IS WHAT IT IS MADE OF. This
            wore role="tablist" with role="tab" on the radios, and both
            halves were wrong. The tablist owned no tabs -- every radio
            sits inside a <label>, so the accessibility tree read
            tablist > LabelText > tab and nothing could compute "7 of
            8". And role="tab" replaced the input's own `radio` role
            while the code went on depending on the radio group for the
            roving tabindex, on a node industry.css makes
            position:absolute, 0x0 and opacity:0. A native radio group
            gives set position and count from the shared `name`, with no
            ARIA to keep in step, and it is what the house's other two
            .seg strips already are. aria-controls stays: it is a global
            attribute and it is the only thing tying a choice to the
            panel it swaps in. */}
        <div
          className="seg edit-tabs"
          role="radiogroup"
          aria-label="Which part of the record to edit"
          onKeyDown={onStripKeyDown}
        >
          {EDIT_SECTIONS.map((section, index) => {
            const on = section.id === active;
            return (
              <label key={section.id} className="seg-opt">
                <input
                  ref={(node) => {
                    tabs.current[index] = node;
                  }}
                  type="radio"
                  id={tabDomId(section.id)}
                  name="ed-section-tab"
                  aria-controls={panelDomId(section.id)}
                  checked={on}
                  onChange={() => choose(section.id)}
                />
                {section.label}
                {/* Words, never colour alone, and all of them inside the
                    label so the state is read out with the section it
                    belongs to: "Menu, Phone not updated". */}
                {behind.includes(section.id) ? (
                  <span className="tag tag-out">Phone not updated</span>
                ) : null}
                {replacedSections.has(section.id) ? (
                  <span className="tag tag-out">Replaced</span>
                ) : null}
                {dirtySections.has(section.id) ? (
                  <span className="tag tag-neutral">Unsaved</span>
                ) : null}
              </label>
            );
          })}
        </div>

        {/* The chips say WHICH; this says WHAT HAPPENS NEXT. Seven of
            the eight surfaces holding typing are display:none at any
            moment, which is exactly what the stacked cards did not have
            to say out loud.

            It still says it now that useLeaveGuard asks before a route
            change, and the wording changed to match: a warning that
            arrives only in a dialog arrives after the operator has
            already committed to the press, and the point of this line
            is that they can decide to save FIRST. It also stays honest
            about the case the guard does not cover -- the back button.

            Absent when nothing is unsaved: a standing warning is
            furniture, and furniture is not read. */}
        {unsavedLabels.length > 0 ? (
          <p className="setup-note edit-tabs-note">
            Unsaved edits on {sentenceList(unsavedLabels)}. Moving between tabs keeps them. A
            link out of this page asks first; the browser&rsquo;s own Back button does not, and
            loses them.
          </p>
        ) : null}
      </div>

      <EditTabsContext.Provider value={value}>{children}</EditTabsContext.Provider>

      {/* The house dialog, not window.confirm: confirm() cannot be
          styled, cannot be read by the section names it is about
          without shouting them in a system font, and blocks the whole
          thread while it is up.

          Stay is FIRST and takes focus, so Enter and Escape both keep
          the typing; Leave is .btn-danger and has to be aimed at, the
          same shape MenuAdmin's remove-a-category confirm uses for a
          loss of the same kind. */}
      {exit ? (
        <div
          className="dialog-backdrop edit-leave-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-leave-title"
        >
          <div className="dialog blueprint">
            <Corners />
            <div id="edit-leave-title" className="dialog-title">
              {sentenceList(exit.labels)} {exit.labels.length === 1 ? "has" : "have"} unsaved
              changes
            </div>
            <div className="dialog-body">
              <p>
                Leaving this page throws that typing away. None of it has been written to the
                record and there is no undo — staying leaves it exactly where it is, on the tab it
                was typed on.
              </p>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" ref={stayRef} onClick={stay}>
                Stay on this page
              </button>
              <button type="button" className="btn btn-danger" onClick={leave}>
                Leave and lose them
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** One section's panel. Mounted always, shown when its tab is chosen.
 *
 *  `hidden` is what hides it, and it needs help: `[hidden] { display:
 *  none }` is the user agent's own rule at specificity 0,0,1 and
 *  `.setup-stack { display: flex }` is 0,1,0, so the attribute alone is
 *  inert and all eight panels would paint at once. app/app.css carries
 *  the one line that settles it -- `.setup-stack[hidden] { display:
 *  none }` -- and this element must keep wearing .setup-stack for it to
 *  bite. Do not "tidy" either half away.
 *
 *  What that buys: display: none takes the seven hidden panels out of
 *  the focus order, out of the accessibility tree and out of
 *  find-in-page, so only the chosen section is reachable by Tab, by a
 *  screen reader or by Ctrl-F -- while their React state, and the
 *  beforeunload guards registered by the sections inside them, stay
 *  exactly where they were.
 *
 *  role="group" with the tab's own label as its name, not
 *  role="tabpanel": there is no tablist on this page to belong to. It
 *  is the target of the radio's aria-controls and it says which of the
 *  eight the reader has landed in. */
export function EditPanel({ id, children }: { id: EditSectionId; children: ReactNode }) {
  const { active } = useContext(EditTabsContext);

  return (
    <div
      id={panelDomId(id)}
      role="group"
      aria-label={labelOf(id)}
      className="setup-stack"
      hidden={active !== id}
    >
      {children}
    </div>
  );
}
