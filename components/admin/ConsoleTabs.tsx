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

/* The operator console's nine subjects, one on screen at a time.
 *
 * WHAT THIS REPLACED, AND WHY
 * ---------------------------
 * /edit used to be nine cards in one column: 8210px of document, with
 * the Menu heading 5346px down it. The operator's words were "it's like
 * a stack ... I just have to scroll all the way to the down. I don't
 * like it ... I just want to click on the section." Asked how a section
 * should open they chose tabs -- swap in place, one section on screen,
 * nothing below it. Not an overlay, not an accordion. That was accepted.
 *
 * THEN THE SAME COMPLAINT ARRIVED ABOUT THE OTHER HALF: "the dashboard
 * looks so clumsy and not properly done ... the dashboard is not at all
 * consistant." /admin/<id> was four unrelated subjects stacked in one
 * .split under five headings, with a strip of eight links across the top
 * pointing at the very tabs this file already owns. Two navigation ideas
 * for one console. So this module stopped being the EDITOR's strip and
 * became the console's: the overview's subjects and the editor's tabs
 * are one set of nine, and there is one act -- press a tab -- for all of
 * them. The name had to stop saying "edit" for that to be readable.
 *
 * NOTHING UNMOUNTS
 * ----------------
 * Every panel is rendered on every render; the inactive ones carry
 * `hidden`. Conditional rendering was rejected outright: the sections'
 * form state (useSeeded's fields, WeeklyHours' days, every half-typed
 * price in MenuAdmin, and now the go-live panel's fallback field) lives
 * in useState, and unmounting destroys it silently. A half-typed week
 * lost because somebody checked the menu is exactly the failure tabs
 * must not introduce. `display: none` also takes the hidden panels out
 * of the a11y tree, out of the focus order and out of find-in-page, so
 * only the visible tab is reachable by Tab, by a screen reader or by
 * Ctrl-F.
 *
 * ...WHICH IS ALSO WHY THE STRIP CARRIES MARKS
 * --------------------------------------------
 * Eight of the nine dirty surfaces are display:none at any moment, so
 * a card's own "Unsaved" flag can be somewhere nobody can read it. The
 * strip is then the only visible sign, which is what useSectionDirty
 * and useSectionReplaced below are for, and why the strip states the
 * unsaved sections in words underneath itself as well as in chips.
 *
 * PRESENTATION ONLY
 * -----------------
 * This module reads no id, calls no action and writes nothing. The tab
 * is client state and the only thing it decides is which panel is
 * visible. app/admin/[locationId]/page.tsx validates `?section=`
 * against a fixed nine-item list before it ever reaches this file; it
 * is never an id, never reaches Postgres or Vapi, and no "use server"
 * export gained a parameter for it. locationId remains the only
 * caller-supplied id on the route and is still uuid-validated.
 */

export type ConsoleSectionId =
  | "line"
  | "calls"
  | "orders"
  | "menu"
  | "hours"
  | "answering"
  | "service"
  | "business"
  | "managed";

/** The tabs, in the order state → evidence → record → audit.
 *
 *  1-3 are what is happening on the phone right now; 4-8 are what is on
 *  file, by how often an operator is asked to change it; 9 is the audit
 *  trail. The editor's old order was only "the order the cards used to
 *  be stacked in" and carried no argument.
 *
 *  TWO COLLAPSES, BOTH EARNED. `recording` folded into Calls -- the
 *  setting and the log it governs are one ticket ("why can't I hear that
 *  call"), and they used to be on two different routes. The overview's
 *  recent-orders list folded into Orders, where the routing setting is,
 *  for the same reason and because "orders" meant two different things
 *  on two screens.
 *
 *  Nine, not the eleven <section id>s across the console: #holidays is a
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
 *  exact device the complaint came from. Dropping "Recording" and adding
 *  "Line" and "Calls" leaves the set at about 654px of 13px Barlow --
 *  still one row on an iPad, and flex-wrap still catches the phone.
 *  Each panel's own <h2> carries the full heading. */
export const CONSOLE_SECTIONS: readonly { id: ConsoleSectionId; label: string }[] = [
  { id: "line", label: "Line" },
  { id: "calls", label: "Calls" },
  { id: "orders", label: "Orders" },
  { id: "menu", label: "Menu" },
  { id: "hours", label: "Hours" },
  { id: "answering", label: "Answering" },
  { id: "service", label: "Money & service" },
  { id: "business", label: "Business" },
  { id: "managed", label: "System" },
];

/** What the console opens on with no ?section=.
 *
 *  Line, because the one question an operator opens /admin/<id> with --
 *  with a restaurant owner on the phone -- is "is this restaurant
 *  answering, and if not what is in the way". Everything else on this
 *  page is reference. */
export const DEFAULT_SECTION: ConsoleSectionId = "line";

function labelOf(id: ConsoleSectionId): string {
  return CONSOLE_SECTIONS.find((section) => section.id === id)?.label ?? id;
}

/** Which tab an old in-page anchor opens.
 *
 *  The hash stays the contract, permanently and not as a migration
 *  step. /edit#menu is pasted into tickets, bookmarked and mailed, and
 *  those URLs can never be rewritten. All the ids stay on their sections
 *  in the DOM; nothing was renamed. #holidays and #sold-out map to their
 *  parent's tab because that is where their card lives.
 *
 *  `recording` still resolves and now opens Calls, which is where the
 *  recording setting moved to -- the anchor is unchanged, its
 *  destination is one tab over, and the <section id="recording"> is
 *  still in that panel so the browser's own scroll still lands on it.
 *
 *  READ IT THROUGH sectionOfAnchor(), NEVER BY INDEXING IT. */
export const SECTION_OF_ANCHOR: Record<string, ConsoleSectionId> = {
  line: "line",
  golive: "line",
  calls: "calls",
  recording: "calls",
  orders: "orders",
  menu: "menu",
  "sold-out": "menu",
  hours: "hours",
  holidays: "hours",
  answering: "answering",
  service: "service",
  business: "business",
  managed: "managed",
};

/** The map read safely: an unknown anchor is undefined, and so is an
 *  inherited one.
 *
 *  The hash is the one part of the URL the browser hands over unfiltered
 *  and it is not validated anywhere upstream, so `SECTION_OF_ANCHOR[hash]`
 *  is a lookup on attacker-chosen text. An object literal inherits from
 *  Object.prototype, so #constructor -- and #toString, #valueOf,
 *  #hasOwnProperty, #__proto__ -- returned a truthy value that is not a
 *  ConsoleSectionId at all, sailed past a `if (!section)` guard, and left
 *  the console blank: no tab checked, every panel hidden, the arrow
 *  keys dead (findIndex returns -1), and `?section=function%20Object()...`
 *  written into the URL so a reload did it again. There is no way back
 *  from that except editing the address bar.
 *
 *  Two guards, because either alone is a trap for the next reader:
 *  Object.hasOwn keeps the prototype out, and the membership check keeps
 *  the answer inside the tabs the strip can actually show. */
export function sectionOfAnchor(hash: string): ConsoleSectionId | undefined {
  if (!Object.hasOwn(SECTION_OF_ANCHOR, hash)) return undefined;
  const section = SECTION_OF_ANCHOR[hash];
  return CONSOLE_SECTIONS.some((known) => known.id === section) ? section : undefined;
}

/** Which tab a `?section=` on the address bar names, or undefined.
 *
 *  The client's own copy of the check app/admin/[locationId]/page.tsx
 *  makes on the server, and it exists for the same reason
 *  sectionOfAnchor does: on the way BACK through history the query
 *  string is read by this file and by nothing else, so nothing upstream
 *  has vetted it. A popstate can land on any entry the operator has --
 *  including one whose URL they typed -- and `?section=<anything>` must
 *  resolve to one of the nine tabs the strip can show or to nothing at
 *  all. It is never an id, never reaches Postgres or Vapi and is never
 *  passed to a server action; the one thing it decides is which panel is
 *  visible.
 *
 *  A membership test over the array rather than a map lookup, so there
 *  is no object literal to inherit `constructor` from. */
export function sectionOfSearch(search: string): ConsoleSectionId | undefined {
  const value = new URLSearchParams(search).get("section");
  return CONSOLE_SECTIONS.find((known) => known.id === value)?.id;
}

const tabDomId = (id: ConsoleSectionId) => `console-tab-${id}`;
const panelDomId = (id: ConsoleSectionId) => `console-panel-${id}`;

/* ── what each section has to say about itself ─────────────────────── */

/** `unsaved` -- typing that has not been written yet.
 *  `replaced` -- typing that a fresh server value has already taken
 *  away. Both are reported by the components that own the state, since
 *  only they know. */
type SectionMark = "unsaved" | "replaced";

type ConsoleTabsContextValue = {
  active: ConsoleSectionId;
  /** Swap the panel in place. Referentially stable. */
  goTo: (section: ConsoleSectionId) => void;
  /** `mark: null` unregisters. Referentially stable. */
  report: (reporterId: string, section: ConsoleSectionId, mark: SectionMark | null) => void;
};

const NO_SECTIONS: ReadonlySet<ConsoleSectionId> = new Set<ConsoleSectionId>();

/* The default is a no-op on purpose: HoursEditor, MenuAdmin and GoLive
   all claim in their own headers that they can be rendered standalone
   and from a test, and calling these hooks must not make that untrue.
   Outside a <ConsoleTabs> the report goes nowhere, goTo does nothing,
   and nothing renders differently. */
const ConsoleTabsContext = createContext<ConsoleTabsContextValue>({
  active: DEFAULT_SECTION,
  goTo: () => {},
  report: () => {},
});

function useSectionMark(section: ConsoleSectionId, mark: SectionMark, on: boolean): void {
  const { report } = useContext(ConsoleTabsContext);
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
 *  What beforeunload cannot see is a client-side route change -- the
 *  back link in the page head, an item in the operator bar. That half is
 *  <ConsoleTabs>'s own, in useLeaveGuard below: it has the whole dirty
 *  set and can therefore name the sections, which a beforeunload dialog
 *  is not allowed to do.
 *
 *  One line per dirty-capable component; several reporters may sit in
 *  one section (Hours has the week, every holiday row and the add form)
 *  and they are OR'd, keyed by useId(), and unregistered on unmount. */
export function useSectionDirty(section: ConsoleSectionId, dirty: boolean): void {
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
export function useSectionReplaced(section: ConsoleSectionId, replaced: boolean): void {
  useSectionMark(section, "replaced", replaced);
}

/** Swap the console to another tab from inside a panel.
 *
 *  What the go-live checklist's three "Fix in …" buttons press. They are
 *  still real anchors -- `?section=<id>` on this same path -- so
 *  Cmd-click, middle-click and open-in-new-tab all still work and land
 *  on the right tab from the first byte of HTML; this only intercepts
 *  the plain left-click, which would otherwise cost a full navigation, a
 *  fresh Vapi read and every panel's unsaved typing. */
export function useConsoleGoTo(): (section: ConsoleSectionId) => void {
  return useContext(ConsoleTabsContext).goTo;
}

/** A press that moves the console to another tab.
 *
 *  A REAL ANCHOR, and that is the whole design. `?section=<id>` on this
 *  same path is a URL the server already understands, so Cmd-click,
 *  middle-click, "open in new tab" and a copied link all land on the
 *  right panel in the first byte of HTML. Only the plain left-click is
 *  intercepted, and only to save what the navigation would cost: four
 *  reads, one of them a Vapi round trip, and every panel's unsaved
 *  typing.
 *
 *  The same modifier tests as useLeaveGuard's, for the same reasons and
 *  in the same order -- see its header. And it never fights that guard:
 *  the guard ignores a link whose pathname is the current one, which
 *  every one of these is. */
export function SectionLink({
  section,
  className,
  label,
  children,
}: {
  section: ConsoleSectionId;
  className?: string;
  /** An accessible name, where the visible text repeats down a column
   *  and would otherwise be the ninth identical "Fix". */
  label?: string;
  children: ReactNode;
}) {
  const goTo = useConsoleGoTo();

  return (
    <a
      href={`?section=${section}`}
      className={className}
      aria-label={label}
      onClick={(event) => {
        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        goTo(section);
      }}
    >
      {children}
    </a>
  );
}

/** What an operator gets instead of silence when their typing is gone.
 *
 *  Every action on this route calls revalidatePath, success or refusal,
 *  so ONE write anywhere on the page hands every panel fresh props at
 *  once. Each form then re-seeds during render if its own server values
 *  moved -- which is right, and deliberately so: a tab left open must
 *  not sit there showing an edit the database has already replaced. But
 *  it used to happen without a word. Flip one dish to sold out while the
 *  owner's own screen changes a weekly row, and the week somebody had
 *  retyped in the Hours tab was simply gone, on a panel that is
 *  display:none, with the tab's "Unsaved" chip disappearing in the same
 *  commit -- indistinguishable from their own save landing.
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

function sameMembers(a: ReadonlySet<ConsoleSectionId>, b: ReadonlySet<ConsoleSectionId>): boolean {
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
 *  change is none of those: the back link in the page head and the items
 *  in the operator bar are <Link>s, so Next swaps the tree in place,
 *  this component unmounts, and nine panels of useState go with it
 *  without a single event the browser would call an unload.
 *
 *  HOW THIS CATCHES IT, AND WHY NOT onNavigate. next/link takes an
 *  `onNavigate(e)` prop whose e.preventDefault() cancels the navigation,
 *  and for a link this module rendered that would be the tidier hook.
 *  It is per-link, and not one of the links that loses the work is in
 *  this file: they are in app/admin/[locationId]/page.tsx, in
 *  components/admin/EditSections.tsx, and in
 *  components/admin/AdminNav.tsx and app/admin/layout.tsx -- the shell,
 *  which knows nothing about a console panel and would have to be handed
 *  the console's dirty state to use the prop at all. A route with that
 *  many ways out needs one guard, not one per anchor that the next
 *  anchor is added without.
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
 *      mounted through it; that is the whole design, and it is what the
 *      checklist's own "Fix in …" buttons ride on.
 *    * The browser's own Back button, and every other history move.
 *      Still no popstate guard, and the reason changed shape when
 *      choose() started pushing (see its comment): a Back press inside
 *      this console is now a move BETWEEN TABS. Nothing unmounts through
 *      it, nothing is lost by it, and there is therefore nothing for a
 *      guard to ask about -- which is the whole point of the push. The
 *      one Back that still leaves is the one pressed on the tab the
 *      console was arrived on, and that one is not cancellable from
 *      here: popstate arrives AFTER the entry has already changed, the
 *      App Router's own popstate listener has already started the
 *      traverse, and "cancelling" it would mean pushing a state back on
 *      to fight the operator's own button. beforeunload covers it
 *      whenever this page was loaded as a document; when it was reached
 *      by a soft route change it is the last uncovered press on the
 *      route, down from every Back press before this change. The
 *      sentence under the strip says so in those words.
 *    * Sign out. It is a <form> posting a server action, not a link.
 *      Intercepting submits would put this listener in front of every
 *      save on the page, which is a far worse thing to get wrong. */
function useLeaveGuard(dirtySections: ReadonlySet<ConsoleSectionId>) {
  const router = useRouter();
  const [exit, setExit] = useState<PendingExit | null>(null);
  const stayRef = useRef<HTMLButtonElement>(null);

  /* Registered only while something is unsaved, so a clean console
     behaves exactly as it did before this existed. `dirtySections` is a
     new Set only when its MEMBERS change (see report()), so this is not
     re-registered on every keystroke. */
  useEffect(() => {
    if (dirtySections.size === 0) return;

    const labels = CONSOLE_SECTIONS.filter((section) => dirtySections.has(section.id)).map(
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

export function ConsoleTabs({
  initial,
  behind,
  children,
}: {
  /** From ?section=, already validated on the server, so the right
   *  panel is in the first byte of HTML and there is no wrong-tab
   *  flash to correct after hydration. */
  initial: ConsoleSectionId;
  /** Sections whose assistant is stale, from the server's one Vapi
   *  read. Passed in rather than computed here so the chip is in the
   *  first paint and never appears mid-session. */
  behind: readonly ConsoleSectionId[];
  /** The nine <ConsolePanel>s, rendered on the server. */
  children: ReactNode;
}) {
  const [active, setActive] = useState<ConsoleSectionId>(initial);
  /* The same value the callbacks read, because they may not read the
     state. choose() is handed to eight panels as `goTo` and its identity
     is what decides whether their reporting effects re-fire, so it has
     to stay referentially stable -- and a stable callback cannot close
     over `active`. The ref is written by show() and by nothing else. */
  const activeRef = useRef<ConsoleSectionId>(initial);
  const [dirtySections, setDirtySections] = useState<ReadonlySet<ConsoleSectionId>>(NO_SECTIONS);
  const [replacedSections, setReplacedSections] =
    useState<ReadonlySet<ConsoleSectionId>>(NO_SECTIONS);
  const reporters = useRef<Map<string, { section: ConsoleSectionId; mark: SectionMark }>>(
    new Map(),
  );
  const tabs = useRef<(HTMLInputElement | null)[]>([]);

  /* Stable for the life of the strip, so a keystroke that does not flip
     a mark costs no parent render, and so the reporting effects do not
     re-fire on every render of their own section. */
  const report = useCallback(
    (reporterId: string, section: ConsoleSectionId, mark: SectionMark | null) => {
      const map = reporters.current;
      if (mark) {
        const held = map.get(reporterId);
        if (held && held.section === section && held.mark === mark) return;
        map.set(reporterId, { section, mark });
      } else {
        if (!map.has(reporterId)) return;
        map.delete(reporterId);
      }
      const unsaved = new Set<ConsoleSectionId>();
      const replaced = new Set<ConsoleSectionId>();
      for (const held of map.values()) {
        (held.mark === "unsaved" ? unsaved : replaced).add(held.section);
      }
      setDirtySections((prev) => (sameMembers(prev, unsaved) ? prev : unsaved));
      setReplacedSections((prev) => (sameMembers(prev, replaced) ? prev : replaced));
    },
    [],
  );

  /** Put a tab on screen. The one writer of `active`, so the state and
   *  the ref the callbacks read can never disagree. Says nothing about
   *  history: choose() writes an entry, popstate reads one. */
  const show = useCallback((id: ConsoleSectionId) => {
    activeRef.current = id;
    setActive(id);
  }, []);

  /** A tab the operator chose. */
  const choose = useCallback(
    (id: ConsoleSectionId) => {
      /* Already here. A "Fix in …" button on the panel it points at, or
         a re-press of the checked radio, must not write a second history
         entry for a move that did not happen -- that is how a back stack
         fills with duplicates of one tab. The scroll below still runs:
         the press meant "show me that", and from halfway down a long
         panel it has somewhere to go. */
      if (activeRef.current !== id) {
        show(id);

        /* Kept in the URL so a reload, a bookmark and a pasted link all
           land back here -- and written with history rather than with a
           <Link>. A navigation would re-run this route's server function
           on every tab press: getAdminLocation plus getGoLiveState plus
           getEditableRecord plus the drift read, four of them against
           Postgres and Vapi, per press, and a server re-render that
           risks the unsaved client state this whole design exists to
           protect.

           PUSH, AND IT USED TO BE REPLACE. THE ARGUMENT, IN FULL,
           BECAUSE IT WAS DECIDED THE OTHER WAY ONCE.

           The case for replace was that nine tab presses fill the back
           stack, so Back stops returning to /admin in one press. That is
           true and it is the entire cost. What it was weighed against
           was not measured: with replace there is exactly ONE history
           entry for the whole console, so the operator's first Back --
           from the Menu tab, from Hours, from anywhere -- LEAVES THE
           RESTAURANT. It is a client-side route change, so this
           component unmounts and nine panels of useState go with it;
           beforeunload does not fire for a soft navigation and
           useLeaveGuard's click listener never sees a button press. One
           press, no dialog, no undo, and the thing destroyed is exactly
           what the rest of this file exists to protect. Back after a tab
           press also does not do what the address bar says it will: the
           URL reads ?section=hours and Back does not undo the move that
           put it there.

           So: push. Back now steps back through the tabs that were
           opened, which is what a Back button means, and every one of
           those steps is same-document -- nothing unmounts, nothing is
           lost, and the guard has nothing to ask about. Leaving the
           restaurant takes as many presses as there were tab presses,
           which is the honest price of nine navigations, and the way out
           in ONE press is the "← Every restaurant" link at the top of
           the page -- which is guarded, names the unsaved sections and
           has been sitting there the whole time.

           Only a real change pushes (see the test above it), so the
           stack holds the tabs that were actually visited and not one
           entry per press.

           window.history.state is passed through rather than null
           because Next keeps its router tree in there: an entry without
           it is one the App Router does not recognise, and popping onto
           it makes it reload the document. */
        const params = new URLSearchParams(window.location.search);
        params.set("section", id);
        window.history.pushState(window.history.state, "", `?${params.toString()}`);
      }

      /* Switching from deep inside a two-hundred-item Menu to a
         one-screen Business panel would otherwise leave the operator
         staring at the clamped bottom of a short document. Instant: the
         5275px slide that once needed smooth scrolling no longer exists. */
      window.scrollTo({ top: 0 });
    },
    [show],
  );

  /* Back and Forward, which are now moves between tabs.
   *
   * The other half of the push above: an entry this component wrote is
   * an entry it has to be able to read back. Without this the URL would
   * walk backwards while the panel stood still -- the address bar
   * reading ?section=line over an open Menu tab, and a reload then
   * "losing" a tab the operator never left.
   *
   * The section is taken from the URL rather than from a stack of our
   * own, because the URL is the thing the entry actually carries: a
   * reload, a Forward press, a bookmark and a session restored by the
   * browser all arrive with nothing but this. It goes through
   * sectionOfSearch for the reason that function's header gives -- on
   * the way back through history nothing upstream has vetted it.
   *
   * ?section= missing means the arrival entry, which rendered
   * DEFAULT_SECTION.
   *
   * A popstate that has left this path is NOT ours: it is the operator
   * leaving the restaurant, the App Router already owns it, and setting
   * a tab on a page that is going away is noise. `path` is read once, at
   * registration, so it is the console's own pathname and not whatever
   * the address bar has become by the time the listener runs.
   *
   * Nothing scrolls here, deliberately. choose() sends the page to the
   * top because a tab press is a new subject; a Back press is a RETURN,
   * and the browser restores that entry's own scroll offset, which is
   * where the operator was standing when they left it. */
  useEffect(() => {
    const path = window.location.pathname;
    const onPopState = () => {
      if (window.location.pathname !== path) return;
      show(sectionOfSearch(window.location.search) ?? DEFAULT_SECTION);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [show]);

  /* An arrival by hash: /admin/<id>#menu from a bookmark, or one of the
     old /edit#… links arriving through the redirect, which re-applies
     the fragment. The hash is the most specific, most recently pressed
     thing on the URL, so it wins over ?section=, and it is then
     rewritten to ?section= and dropped so a reload does not fight it.
     A URL with neither is left exactly as it is -- a page that rewrites
     its own address on load with no user action is rude and pointless.

     sectionOfAnchor rather than an index: the hash is unvalidated text
     and the map is an object literal. Its comment has the detail.

     replaceState here and pushState in choose(), and the difference is
     not an oversight. This is a REWRITE of the entry the console
     arrived on into the form the rest of the file reads -- the operator
     made no move, so there is no move to put in the history. Pushing
     here would put a dead entry under every /edit#menu link that comes
     through the redirect, and Back off it would appear to do nothing. */
  useEffect(() => {
    const applyHash = () => {
      const hash = window.location.hash.slice(1);
      if (hash === "") return;
      const section = sectionOfAnchor(hash);
      if (!section) return;
      show(section);
      const params = new URLSearchParams(window.location.search);
      params.set("section", section);
      window.history.replaceState(window.history.state, "", `?${params.toString()}`);
      window.scrollTo({ top: 0 });
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [show]);

  /* Arrow keys, Home and End across the strip, with the section
     changing as focus reaches it -- which costs nothing here: no fetch,
     no unmount, no loss.

     Handled rather than left to the radio group's own arrow behaviour so
     the movement is one explicit rule (Home and End are not native to a
     radio group at all) and so preventDefault stops Up and Down
     scrolling the page out from under the strip. preventDefault is also
     what keeps this from double-stepping: it suppresses the platform's
     own radio traversal, and this handler makes the single move. The
     group's shared `name` is still what gives the nine one tab stop,
     with only the selected one tabbable -- the roving tabindex, from
     the platform, free. */
  const onStripKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = CONSOLE_SECTIONS.length - 1;
    const from = CONSOLE_SECTIONS.findIndex((section) => section.id === active);
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
    choose(CONSOLE_SECTIONS[to].id);
    // preventScroll: the strip is already at the top of the document and
    // choose() has just scrolled there; nothing should move twice.
    tabs.current[to]?.focus({ preventScroll: true });
  };

  const value = useMemo<ConsoleTabsContextValue>(
    () => ({ active, goTo: choose, report }),
    [active, choose, report],
  );

  const unsavedLabels = CONSOLE_SECTIONS.filter((section) => dirtySections.has(section.id)).map(
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
      <div className="console-tabs-head">
        {/* The house segmented control, worn rather than
            re-implemented: the same <div class="seg"> of
            <label class="seg-opt"> radios components/LoginForm.tsx
            already uses to swap a form in place, so the layout, the
            divider, the checked fill, the hover and the inset focus
            ring all come from app/industry.css and stay in step with
            it. .console-tabs is the delta app/app.css adds on top -- it
            takes the panel column's width and wraps rather than
            scrolling sideways, which is what keeps all nine inside
            375px, since .seg is overflow: hidden and an option past the
            edge would be unreachable rather than merely awkward.

            .seg and not .nav because these are not routes: one of
            nine, chosen in place with the panel swapping under it, is
            what a segmented control means.

            AND IT IS A RADIO GROUP, WHICH IS WHAT IT IS MADE OF. This
            wore role="tablist" with role="tab" on the radios, and both
            halves were wrong. The tablist owned no tabs -- every radio
            sits inside a <label>, so the accessibility tree read
            tablist > LabelText > tab and nothing could compute "7 of
            9". And role="tab" replaced the input's own `radio` role
            while the code went on depending on the radio group for the
            roving tabindex, on a node industry.css makes
            position:absolute, 0x0 and opacity:0. A native radio group
            gives set position and count from the shared `name`, with no
            ARIA to keep in step, and it is what the house's other two
            .seg strips already are. aria-controls stays: it is a global
            attribute and it is the only thing tying a choice to the
            panel it swaps in. */}
        <div
          className="seg console-tabs"
          role="radiogroup"
          aria-label="Which part of this restaurant to work on"
          onKeyDown={onStripKeyDown}
        >
          {CONSOLE_SECTIONS.map((section, index) => {
            const on = section.id === active;
            return (
              <label key={section.id} className="seg-opt">
                <input
                  ref={(node) => {
                    tabs.current[index] = node;
                  }}
                  type="radio"
                  id={tabDomId(section.id)}
                  name="console-section-tab"
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

        {/* The chips say WHICH; this says WHAT HAPPENS NEXT. Eight of
            the nine surfaces holding typing are display:none at any
            moment, which is exactly what the stacked cards did not have
            to say out loud.

            It still says it now that useLeaveGuard asks before a route
            change, and the wording changed to match: a warning that
            arrives only in a dialog arrives after the operator has
            already committed to the press, and the point of this line
            is that they can decide to save FIRST. It also stays honest
            about the case the guard does not cover -- the back button.

            AND THAT LAST CLAUSE IS NARROWER THAN IT WAS, because the
            code under it changed. choose() pushes a history entry now,
            so Back is a move between tabs and keeps everything; the one
            press that still leaves is Back on the tab the console was
            arrived on. The sentence names that press rather than the
            button, because a line that says "Back loses your work" while
            Back plainly does not is a line that stops being believed --
            and the one press that IS still lossy gets disbelieved with
            it.

            Absent when nothing is unsaved: a standing warning is
            furniture, and furniture is not read. */}
        {unsavedLabels.length > 0 ? (
          <p className="setup-note">
            Unsaved edits on {sentenceList(unsavedLabels)}. Moving between tabs keeps them, and
            so does the browser&rsquo;s own Back button — it steps back through the tabs you
            opened. A link out of this page asks first; on the tab you arrived on, where the
            next press leaves the restaurant, the Back button does not, and loses them.
          </p>
        ) : null}
      </div>

      <ConsoleTabsContext.Provider value={value}>{children}</ConsoleTabsContext.Provider>

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
          className="dialog-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="console-leave-title"
        >
          <div className="dialog blueprint">
            <Corners />
            <div id="console-leave-title" className="dialog-title">
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

/** One section's panel. Shown when its tab is chosen, and MOUNTED FOR
 *  GOOD from the first time it is.
 *
 *  `hidden` is what hides it, and it needs help: `[hidden] { display:
 *  none }` is the user agent's own rule at specificity 0,0,1 and
 *  `.setup-stack { display: flex }` is 0,1,0, so the attribute alone is
 *  inert and every panel would paint at once. app/app.css carries the
 *  one line that settles it -- `.setup-stack[hidden] { display: none }`
 *  -- and this element must keep wearing .setup-stack for it to bite.
 *  Do not "tidy" either half away.
 *
 *  What that buys: display: none takes the eight hidden panels out of
 *  the focus order, out of the accessibility tree and out of
 *  find-in-page, so only the chosen section is reachable by Tab, by a
 *  screen reader or by Ctrl-F -- while their React state, and the
 *  beforeunload guards registered by the sections inside them, stay
 *  exactly where they were.
 *
 *  role="group" with the tab's own label as its name, not
 *  role="tabpanel": there is no tablist on this page to belong to. It
 *  is the target of the radio's aria-controls and it says which of the
 *  nine the reader has landed in.
 *
 *  ── `defer`, AND THE ONE PROPERTY IT MAY NOT COST ──────────────────
 *
 *  WHAT IT IS FOR. Every panel used to be built on every load, so every
 *  load paid for the largest section on the page whichever tab was open:
 *  nine panels, ~1213 elements measured on a small restaurant, and the
 *  Menu panel alone reported at 3627px of layout on one with a real
 *  menu. The Business panel is worse than it looks -- its timezone
 *  <select> is one <option> per zone Intl knows, 418 of them on this
 *  machine -- and none of it can be read, tabbed to, found with Ctrl-F
 *  or reached by a screen reader until its tab is pressed, because
 *  display:none has already taken it out of all four.
 *
 *  WHAT IT DOES. A deferred panel renders its own <div> -- the tab's
 *  aria-controls target, the id a hash lands on -- and no children,
 *  until the first time its tab is chosen. From that moment it renders
 *  them and NEVER STOPS: `opened` is one-way, and nothing in this file
 *  or any caller can set it back.
 *
 *  THAT ONE-WAY LATCH IS THE LOAD-BEARING PART. It has been lost once
 *  already and caught in review. The whole reason nothing unmounts is
 *  that the sections' form state -- useSeeded's fields, WeeklyHours'
 *  days, every half-typed price in MenuAdmin, the go-live panel's
 *  fallback field -- lives in useState, and unmounting destroys it
 *  silently. Deferral does not weaken that by one line, because it only
 *  ever applies BEFORE the first open: a panel that has never been shown
 *  has never been typed into, holds no state, and has nothing to lose.
 *  After the first press it is an ordinary always-mounted panel and
 *  behaves exactly as every panel did before this prop existed. A
 *  `defer` that could go back to true, or an `opened` recomputed from
 *  `active`, would be the unmount this design forbids, wearing a
 *  different word.
 *
 *  WHY THE LATCH IS SET DURING RENDER and not in an effect: an effect
 *  runs after paint, so the operator would see one frame of empty panel
 *  on every first press. Setting state during a component's own render
 *  is React's documented way to derive state from props, and it cannot
 *  fire on the server or on the hydrating render -- `opened` is seeded
 *  from the same `on` the condition tests, so the two agree until a
 *  press moves one of them.
 *
 *  WHAT IS NOT SAVED. The RSC payload is unchanged: the children were
 *  rendered on the server either way, so a deferred panel's contents
 *  travel with the document and its first open is instant and needs no
 *  request. What is saved is the HTML, the elements, the hydration and
 *  the layout of a section nobody asked for. */
export function ConsolePanel({
  id,
  defer = false,
  children,
}: {
  id: ConsoleSectionId;
  /** Hold this panel's contents back until its tab is first chosen.
   *  Never for the section the console opens on -- that one is on
   *  screen -- and never for a panel whose absence would cost
   *  something; app/admin/[locationId]/page.tsx states which nine are
   *  which and why. */
  defer?: boolean;
  children: ReactNode;
}) {
  const { active } = useContext(ConsoleTabsContext);
  const on = active === id;

  const [opened, setOpened] = useState(on || !defer);
  if (on && !opened) setOpened(true);

  return (
    <div
      id={panelDomId(id)}
      role="group"
      aria-label={labelOf(id)}
      className="setup-stack"
      hidden={!on}
    >
      {opened ? children : null}
    </div>
  );
}
