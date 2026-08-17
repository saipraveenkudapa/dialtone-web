import Link from "next/link";
import { notFound } from "next/navigation";
import { Corners } from "@/components/Corners";
import {
  AnsweringSection,
  BusinessSection,
  ServiceSection,
} from "@/components/admin/EditSections";
import { CallsTab } from "@/components/admin/CallsTab";
import {
  ConsolePanel,
  ConsoleTabs,
  DEFAULT_SECTION,
  type ConsoleSectionId,
} from "@/components/admin/ConsoleTabs";
import { GoLive } from "@/components/admin/GoLive";
import { HoursEditor } from "@/components/admin/HoursEditor";
import { MenuAdmin } from "@/components/admin/MenuAdmin";
import { OrdersTab } from "@/components/admin/OrdersTab";
import { SystemTab } from "@/components/admin/SystemTab";
import {
  createMenuCategoryAction,
  createMenuItemAction,
  deleteHolidayAction,
  deleteMenuCategoryAction,
  deleteMenuItemAction,
  saveHolidayAction,
  saveHoursAction,
  saveMenuCategoryAction,
  saveMenuItemAction,
  setMenuItemSoldOutAction,
} from "@/app/admin/[locationId]/edit/actions";
import { getAdminLocation } from "@/lib/admin/data";
import { readAssistantDrift } from "@/lib/admin/drift";
import { TIMEZONES, getEditableRecord, type EditableRecord } from "@/lib/admin/edit";
import { LocationReadError, getGoLiveState } from "@/lib/provisioning/go-live";
import type { DriftCell } from "@/components/admin/EditSections";

/* THE OPERATOR CONSOLE. One page, nine tabs, one restaurant.
 *
 * WHAT THIS REPLACED, AND WHY
 * ---------------------------
 * Two routes and two navigation ideas. /admin/<id> was an overview:
 * four unrelated subjects -- "Going live", "Recent calls", "Sold out",
 * "Recent orders" -- stacked inside one .split under five headings, with
 * a strip of eight links across the top pointing at /edit's eight tabs.
 * /edit was those eight tabs. The operator's report was "the dashboard
 * looks so clumsy and not properly done ... the dashboard is not at all
 * consistant", and it was a measurement as much as a feeling: 1367px of
 * document with nothing expanded, and two different shapes -- a bar of
 * links and a segmented control -- pointing at the same sections.
 *
 * Asked how a section should open, the operator chose tabs, and the
 * editor was built that way and accepted. So the console has ONE
 * structure and it is that one. The overview's subjects and the editor's
 * became one set of nine (components/admin/ConsoleTabs.tsx documents the
 * order and the two collapses), the strip of links is gone because the
 * tab strip IS the section index, and /edit is a redirect.
 *
 * NOTHING WAS REMOVED. Recent calls moved onto Calls, above the
 * recording setting that governs them. Recent orders moved onto Orders,
 * under the routing setting they are the evidence for. Sold out was
 * always on Menu -- the overview's copy was a second READ of data the
 * Menu panel already holds, so the duplicate went and the capability did
 * not. The twelve account facts split three ways: the ones with a field
 * are on the tab that holds the field, the phone's own three are in the
 * Line panel's meta row, and every one of them is still listed verbatim
 * on System.
 *
 * WHAT THE DEFAULT VIEW IS FOR. One question: is this restaurant
 * answering its phone right now, and if not what is in the way. That is
 * the go-live panel and nothing else. Everything else is one press of a
 * strip that is already on screen.
 */

/* How long a server action on this route may run.
 *
 * Route segment config, so it covers the actions in ./actions.ts as well
 * as this page -- and "Make it live" is why it is here. One press can
 * cost three full derivations at three Vapi reads each, an assistant
 * provisioning, and a POST /phone-number, every one of them against a
 * third party whose own ceiling is twenty seconds. That is minutes in
 * the worst case, against a platform default of ten to fifteen seconds.
 *
 * The failure this prevents is specific and it is the only one in the
 * feature that loses money silently: a request killed between
 * `createPhoneNumber` resolving and the column write landing leaves a
 * real, billed, dialable number that exists on no screen and in no
 * column. Every other timeout is a run that has to be pressed again.
 *
 * 300 is the ceiling this asks for; a plan whose limit is lower clamps
 * it, which is still further than the default gets.
 *
 * AND IT NOW COVERS THE EDITOR'S SAVES TOO -- WRITTEN DOWN SO THE NEXT
 * READER DOES NOT "TIDY" IT. edit/actions.ts used to be invoked from
 * /edit, whose own segment config set 120. A server action inherits the
 * config of the route that INVOKES it, and every one of those actions is
 * invoked from here now, so the ceiling they run under is 300. That is
 * strictly the safer direction: 120 existed to bound a save that has a
 * Vapi write in it, and a save KILLED mid-flight -- column written,
 * assistant not rebuilt, no result to say so -- is the failure it was
 * guarding against, not one it was causing. */
export const maxDuration = 300;

/* The RFC shape. The old test here was /^[0-9a-f-]{36}$/i, which happily
   accepts thirty-six dashes and hands PostgREST a malformed uuid cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Which tab this page opens on, and the only new caller-supplied input
 * on the route.
 *
 * SECURITY. `section` is matched against this nine-item literal list
 * and used for exactly one thing: which panel is visible first. It is
 * never an id, it never reaches Postgres or Vapi, it is never passed to
 * a server action, and no "use server" export gained a parameter for it.
 * locationId is still the only caller-supplied id and is still
 * uuid-validated before anything is read; getAdminLocation,
 * getGoLiveState, getEditableRecord and every action still re-check
 * currentPlatformAdmin() themselves.
 *
 * Written out here rather than imported from ConsoleTabs because that
 * module is "use client", and a server component that dots into a client
 * module's export gets a client reference rather than an array. The TYPE
 * is imported, so a renamed or dropped tab fails to compile here rather
 * than drifting quietly. */
const SECTION_IDS: readonly ConsoleSectionId[] = [
  "line",
  "calls",
  "orders",
  "menu",
  "hours",
  "answering",
  "service",
  "business",
  "managed",
];

const isSection = (value: unknown): value is ConsoleSectionId =>
  typeof value === "string" && (SECTION_IDS as readonly string[]).includes(value);

/** A drift cell the phone is actually behind on. Same test the sections
 *  themselves use, so a tab and the card under it can never disagree. */
const isStale = (cell: DriftCell) => cell.state === "stale";

/* ── the record read, which must not be able to take the line down ──── */

/** What the eight field tabs are made of, or the fact that it could not
 *  be read. `gone` is the row itself having vanished between two reads,
 *  which is a 404; `unreadable` is a blip, which is not. */
type RecordRead =
  | { state: "read"; record: EditableRecord }
  | { state: "gone" }
  | { state: "unreadable" };

/** getEditableRecord, WITHOUT the power to delete the kill switch off
 *  the screen.
 *
 *  THIS IS THE WHOLE POINT OF THE FUNCTION, so it is written down rather
 *  than left to a `try`. getEditableRecord throws LocationReadError if
 *  ANY of hours, holiday_hours, menu_categories or menu_items refuses --
 *  four tables the go-live panel does not read and does not care about.
 *  Before the console was one page, /admin/<id> awaited getAdminLocation
 *  (which throws on the `locations` row alone) and getGoLiveState (same),
 *  so a blip on the menu left the panel standing. Merged into one
 *  Promise.all it stopped doing that: the rejection took the whole
 *  document to app/admin/error.tsx, and with it Go live, Take offline
 *  and the kill switch -- the control this codebase documents as the one
 *  somebody reaches for while a caller is being handled badly, which
 *  must answer on the first press every time.
 *
 *  So the four menu-and-hours reads get to fail on their own. The Line
 *  panel reads none of them; it is drawn from getGoLiveState, which has
 *  its own row read and its own refusal.
 *
 *  ONLY LocationReadError is caught. Anything else -- a real bug in
 *  edit.ts -- still reaches the boundary, because "could not be read,
 *  try again" is a lie about a TypeError and the operator would press
 *  reload forever. getEditableRecord has already logged the Postgres
 *  code (never the message) before it throws, so nothing is lost by
 *  swallowing the object here. */
async function readRecord(locationId: string): Promise<RecordRead> {
  try {
    const record = await getEditableRecord(locationId);
    return record === null ? { state: "gone" } : { state: "read", record };
  } catch (err) {
    if (err instanceof LocationReadError) return { state: "unreadable" };
    throw err;
  }
}

/** What a field tab says when the record behind it could not be read.
 *
 *  One panel-shaped sentence per tab rather than one error page for the
 *  document: the tab strip stays, the Line tab stays live, and the
 *  operator can still take a restaurant off the air while the menu read
 *  is misbehaving. Same offer app/admin/error.tsx makes -- try again --
 *  and the same silence about why, for the same reason: a server error's
 *  text can carry things a browser has no business holding. */
function RecordUnreadable() {
  return (
    <section className="card blueprint setup-card">
      <Corners />
      <h2>This could not be read</h2>
      <p className="text-muted empty-note">
        The restaurant&rsquo;s record — its hours, its menu and the fields on this tab — could not
        be read just now. Nothing was changed, and the Line tab is unaffected: going live, taking
        this restaurant off and the kill switch all still work. Most often this is the database
        refusing one read for a moment, and reloading the page is enough.
      </p>
    </section>
  );
}

export default async function AdminLocationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locationId } = await params;
  if (!UUID.test(locationId)) notFound();

  /* Read on the server so the chosen panel is in the first byte of HTML.
     A hash never reaches the server, so a #menu arrival would render
     Line and correct itself after hydration -- a visible wrong-tab
     flash. ?section= removes it; the hash still works and ConsoleTabs
     rewrites it to this form on arrival. */
  const query = await searchParams;
  const initial: ConsoleSectionId = isSection(query.section) ? query.section : DEFAULT_SECTION;

  /* FOUR READS, AND WHY THEY ALL RUN. Every panel is mounted on every
     render -- that is the contract that makes switching tabs lossless --
     so the page cannot read only what the chosen tab needs.

     The row comes first because three of the others are derived from it
     or race it, and it is the cheap one: four Postgres queries already
     in parallel inside getAdminLocation, no third party. Then the three
     expensive ones go together. getGoLiveState makes three Vapi reads,
     readAssistantDrift makes one, and getEditableRecord makes five
     Postgres reads; concurrently, the wall clock is the slowest of them,
     which is getGoLiveState -- exactly what /admin/<id> already cost
     before the merge.

     getGoLiveState deliberately asks Vapi rather than trusting the
     columns: a cached answer is exactly what let a live restaurant's
     assistant id drift to null without anyone noticing.

     Every one of the four re-checks currentPlatformAdmin() itself.

     AND THE RECORD READ CANNOT TAKE THE PAGE DOWN WITH IT. It is the
     only one of the four that throws over tables the Line panel does
     not read -- hours, holidays, categories, items -- so it goes
     through readRecord() above, which turns that one failure into eight
     panels that say so instead of a document that is gone. See its
     header: the control at stake is the kill switch. */
  const data = await getAdminLocation(locationId);
  if (!data) notFound();

  const [goLive, read, drift] = await Promise.all([
    getGoLiveState(locationId),
    readRecord(locationId),
    readAssistantDrift(data.location),
  ]);
  if (!goLive || read.state === "gone") notFound();

  /** The eight field tabs' contents, or null when that read failed.
   *  Nothing on the Line tab, in the page head or in the strip is
   *  derived from it. */
  const record = read.state === "read" ? read.record : null;

  const { calls, orders } = data;

  /* The page's own facts come off getAdminLocation's row and not off the
     record, so the head, the empty-log sentence and the drift read all
     survive a record read that did not. Both are the same `locations`
     row; this one was already in hand. */
  const row = data.location;
  const tz = row.timezone;
  const hasAssistant = row.vapi_assistant_id !== null;

  /* Which tabs carry "Phone not updated" before anything is touched.
     Computed here, off the one Vapi read above, so the chip is painted
     with the strip and never appears mid-session -- the strip does not
     reflow under the operator's hand. The groupings are the sections'
     own: BusinessSection weighs name and address, AnsweringSection the
     greeting and the transfer destination, ServiceSection the order
     types. Without this, tabs would bury the drift warning the flag
     exists to raise. */
  const behind: ConsoleSectionId[] = [];
  if (isStale(drift.name) || isStale(drift.address)) behind.push("business");
  if (isStale(drift.greeting) || isStale(drift.transfer)) behind.push("answering");
  if (isStale(drift.orderTypes)) behind.push("service");

  const answering = row.is_live && !row.kill_switch_on;

  const noCallsYet = !row.is_live
    ? "Nothing yet. This restaurant is not answering — the Line tab says what is in the way."
    : row.kill_switch_on
      ? "Nothing yet. The kill switch is on, so calls are going straight to a person instead."
      : "Nothing yet. The line is open, so the next caller lands here.";

  return (
    <>
      {/* .console-head is the page head OBEYING THE COLUMN THE PAGE IS.
          Measured at 1280px: .page-head came out 1224px -- the whole
          content box of .page -- while .console-tabs, .console-tabs-head
          and every panel came out 760px. A 464px overhang, so the
          restaurant's name and the way out sat on a rule of their own,
          wider than the strip that names the sections and wider than any
          section, with the right of the screen empty under them.

          760 IS THE ONE THAT IS RIGHT, and the head is the outlier. 760
          is a reading measure: it is what .setup-stack has always been,
          what .console-tabs was deliberately capped to so the strip and
          the panels it names cannot disagree, and what the eight field
          panels are laid out inside (.setup-card > .card-body caps prose
          at 70ch under it, .menu-grid resolves to two ~370px columns in
          it). Widening the console to fill 1280 would widen all of that
          and would put ~466px of empty box inside .seg, whose nine
          labels measure ~654px and whose options do not grow -- trading
          a head that is too wide for a strip that is too wide.

          The one thing that could argue for a wider column is the call
          log, and it does not: inside a 760px .setup-card the table gets
          719.2px, and its six columns -- time, caller, outcome, length,
          cost, Open -- need roughly 510px, or about 600px once the date
          is on the timestamp. It fits, with room. .table-scroll is still
          there and is doing its job on a phone, which is the width it
          was written for. See the report; if a column is ever added that
          does not fit, the honest fix is to let THAT CARD out of the
          measure, not to widen every form on the page to suit it. */}
      <div className="page-head console-head">
        <div>
          {/* The same .row-link every other detail page in this product
              puts above its h1 (/admin/new, /dashboard/calls/<id>). */}
          <Link href="/admin" className="row-link">
            ← Every restaurant
          </Link>
          <h1>{row.name}</h1>
          <div className="text-muted sub">{row.address ?? "no address on file"}</div>
        </div>
        {/* No actions. "Edit details" used to live here and was the way
            in to a second route; the strip below is the way in to every
            field now, and it names the sections rather than making the
            operator guess which of forty fields is behind one verb. */}
      </div>

      {/* One section on screen, nothing below it.

          ONCE A PANEL IS OPEN IT STAYS MOUNTED, and that is the contract
          this whole design rests on: a half-typed price in Menu survives
          a trip to Hours and back, because the inactive panels are
          display:none rather than unmounted -- which also takes them out
          of the focus order, out of the a11y tree and out of
          find-in-page.

          WHAT CHANGED, AND WHAT DID NOT. Eight of the nine were also
          BUILT on every load, whether or not anybody opened them: ~1213
          elements on a small restaurant, the Menu panel reported at
          3627px of layout on one with a real menu, and 418 <option>s in
          the Business panel's timezone select on every single page view.
          Every load paid for the largest section on the page regardless
          of which tab was open. So the eight below are `defer`: their
          contents are held back until the first time their tab is
          chosen, and from that moment they are mounted for good, exactly
          like every panel was before. The one-way latch is in
          <ConsolePanel>; its header says why it may never be reversed.

          WHAT A USER LOSES BY NEVER OPENING ONE: nothing. A panel that
          has never been shown has never been typed into, so there is no
          state to keep, no "Unsaved" chip it could have raised and no
          beforeunload it needed to register; and display:none had
          already taken its markup out of Tab order, out of the
          accessibility tree, out of Ctrl-F and out of print. All nine
          are still RENDERED here on the server and all nine still travel
          in the payload, so a first press paints immediately and asks
          the network for nothing; what a deferred panel costs nobody is
          the HTML, the elements, the hydration and the layout of a
          section that was never asked for. The page's OWN state -- which
          tabs are behind on the phone, which are unsaved -- is computed
          here and in the strip, not in the panels, so every chip is on
          screen from the first paint whether its panel has been opened
          or not.

          LINE IS THE EXCEPTION AND IT IS DELIBERATE. It is what the
          console opens on, so it is built anyway -- but it is left
          eager so that it is still built when it ISN'T: an operator who
          arrives on ?section=menu from a ticket has the go-live panel,
          Take offline and the kill switch already in the document. That
          control is the one this file goes out of its way elsewhere to
          keep answering (see readRecord above), and a tab press is a
          poor time to find out it has to be built first. */}
      <ConsoleTabs initial={initial} behind={behind}>
        <ConsolePanel id="line">
          {/* The one question this page exists to answer, and the one
              set of controls that can change the answer. Nothing else is
              on this tab, and that is the whole point of the pass: four
              unrelated subjects used to be stacked under it. */}
          <GoLive state={goLive} />
        </ConsolePanel>

        {/* THE EIGHT FIELD TABS. Every one of them is drawn from the
            record, and every one of them says so on its own when that
            read failed -- the tab strip stays whole, the Line tab above
            stays live, and one refused read of menu_items no longer
            costs an operator the kill switch. */}
        <ConsolePanel id="calls" defer>
          {record ? (
            <CallsTab
              locationId={record.location.id}
              timezone={tz}
              calls={calls}
              recordingEnabled={record.location.recording_enabled}
              recordingRetentionDays={record.location.recording_retention_days}
              updatedAt={record.location.updated_at}
              noCallsYet={noCallsYet}
            />
          ) : (
            <RecordUnreadable />
          )}
        </ConsolePanel>

        <ConsolePanel id="orders" defer>
          {record ? (
            <OrdersTab
              locationId={record.location.id}
              timezone={tz}
              orders={orders}
              orderDelivery={record.location.order_delivery}
              orderSmsTo={record.location.order_sms_to}
              orderEmailTo={record.location.order_email_to}
              updatedAt={record.location.updated_at}
              hasNumber={record.location.twilio_number !== null}
              answering={answering}
            />
          ) : (
            <RecordUnreadable />
          )}
        </ConsolePanel>

        <ConsolePanel id="menu" defer>
          {/* #menu and #sold-out. The overview used to print the
              sold-out list a second time beside the call log; this panel
              already holds it AND the toggles that write it, so what
              went was a duplicate read and not a capability. */}
          {record ? (
            <MenuAdmin
              locationId={record.location.id}
              categories={record.categories}
              items={record.items}
              createCategoryAction={createMenuCategoryAction}
              saveCategoryAction={saveMenuCategoryAction}
              deleteCategoryAction={deleteMenuCategoryAction}
              createItemAction={createMenuItemAction}
              saveItemAction={saveMenuItemAction}
              deleteItemAction={deleteMenuItemAction}
              setSoldOutAction={setMenuItemSoldOutAction}
            />
          ) : (
            <RecordUnreadable />
          )}
        </ConsolePanel>

        <ConsolePanel id="hours" defer>
          {/* #hours and #holidays. Both stay in one panel: a holiday
              is an override of a weekly row, and "we close at 3 on
              Christmas Eve" is unjudgeable without Tuesday's normal
              hours on the same screen. The actions are passed in rather
              than imported by the component: every one of them gates on
              currentPlatformAdmin() itself, so nothing is lost, and the
              editor stays a thing that can be rendered from a test. */}
          {record ? (
            <HoursEditor
              locationId={record.location.id}
              timezone={tz}
              hours={record.hours}
              holidays={record.holidays}
              saveHoursAction={saveHoursAction}
              saveHolidayAction={saveHolidayAction}
              deleteHolidayAction={deleteHolidayAction}
            />
          ) : (
            <RecordUnreadable />
          )}
        </ConsolePanel>

        <ConsolePanel id="answering" defer>
          {record ? (
            <AnsweringSection
              locationId={record.location.id}
              greetingText={record.location.greeting_text}
              fallbackNumber={record.location.fallback_human_number}
              updatedAt={record.location.updated_at}
              drift={drift}
              hasAssistant={hasAssistant}
            />
          ) : (
            <RecordUnreadable />
          )}
        </ConsolePanel>

        <ConsolePanel id="service" defer>
          {record ? (
            <ServiceSection
              locationId={record.location.id}
              taxRateBps={record.location.tax_rate_bps}
              orderTypes={record.location.order_types}
              pickupPromiseMinutes={record.location.pickup_promise_minutes}
              deliveryPromiseMinutes={record.location.delivery_promise_minutes}
              seats={record.location.seats}
              maxPartySize={record.location.max_party_size}
              reservationSlotMinutes={record.location.reservation_slot_minutes}
              updatedAt={record.location.updated_at}
              drift={drift}
              hasAssistant={hasAssistant}
            />
          ) : (
            <RecordUnreadable />
          )}
        </ConsolePanel>

        <ConsolePanel id="business" defer>
          {record ? (
            <BusinessSection
              locationId={record.location.id}
              orgName={record.org.name}
              plan={record.org.plan}
              name={record.location.name}
              timezone={record.location.timezone}
              address={record.location.address}
              businessPhone={record.location.business_phone}
              carrierName={record.location.carrier_name}
              timezones={TIMEZONES}
              updatedAt={record.location.updated_at}
              drift={drift}
              hasAssistant={hasAssistant}
            />
          ) : (
            <RecordUnreadable />
          )}
        </ConsolePanel>

        <ConsolePanel id="managed" defer>
          {record ? (
            <SystemTab location={record.location} org={record.org} timezone={tz} />
          ) : (
            <RecordUnreadable />
          )}
        </ConsolePanel>
      </ConsoleTabs>
    </>
  );
}
