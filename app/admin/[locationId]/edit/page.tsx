import Link from "next/link";
import { notFound } from "next/navigation";
import { Corners } from "@/components/Corners";
import {
  AnsweringSection,
  BusinessSection,
  OrderRoutingSection,
  RecordingSection,
  ServiceSection,
  type AssistantDrift,
  type DriftCell,
} from "@/components/admin/EditSections";
import { EditPanel, EditTabs, type EditSectionId } from "@/components/admin/EditTabs";
import { HoursEditor } from "@/components/admin/HoursEditor";
import { MenuAdmin } from "@/components/admin/MenuAdmin";
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
import { TIMEZONES, getEditableRecord, isUuid, type EditableLocation } from "@/lib/admin/edit";
import { buildGreeting, buildSystemPrompt } from "@/lib/agent/prompt";
import { getAssistant, type VapiAssistant } from "@/lib/vapi/provision";
import { dateTimeIn, relative } from "@/lib/format";
import type { LocationRow } from "@/lib/supabase/types";

export const metadata = { title: "Edit a restaurant · Dialtone" };

/* How long a server action on this route may run.
 *
 * Route segment config, so it covers ./actions.ts as well as this page.
 * Six of the columns edited here are baked into the Vapi assistant, so a
 * save that touches one of them costs a Vapi read plus a Vapi write
 * after the Postgres write -- two round trips against a third party
 * whose own ceiling is VAPI_TIMEOUT_MS (20s) each. The platform default
 * of ten to fifteen seconds would kill that mid-flight.
 *
 * The failure this prevents is specific: a request killed between the
 * column write landing and the assistant rebuild finishing leaves the
 * screen and the phone disagreeing, with no result to say so. Lower than
 * the overview's 300 because nothing here can buy a phone number -- the
 * one act in the console with no undo. */
export const maxDuration = 120;

/* How long this page will wait on Vapi before it gives up and says so.
 *
 * Short, and for the same reason app/admin/[locationId]'s panel is
 * short: a page that has not painted cannot be edited, and the drift
 * check below is the least urgent thing on the screen. When it times out
 * the sections say the assistant could not be read rather than claiming
 * the phone agrees. */
const PAGE_VAPI_TIMEOUT_MS = 5_000;

/* Which tab this page opens on, and the only new caller-supplied input
 * on the route.
 *
 * SECURITY. `section` is matched against this eight-item literal list
 * and used for exactly one thing: which panel is visible first. It is
 * never an id, it never reaches Postgres or Vapi, it is never passed to
 * a server action, and no "use server" export gained a parameter for it.
 * locationId is still the only caller-supplied id and is still
 * uuid-validated before anything is read; getEditableRecord and every
 * action still re-check currentPlatformAdmin() themselves.
 *
 * Written out here rather than imported from EditTabs because that
 * module is "use client", and a server component that dots into a client
 * module's export gets a client reference rather than an array -- the
 * same reason app/admin/[locationId]/page.tsx keeps its own copy. The
 * TYPE is imported, so a renamed or dropped tab fails to compile here
 * rather than drifting quietly. */
const SECTION_IDS: readonly EditSectionId[] = [
  "business",
  "hours",
  "answering",
  "service",
  "orders",
  "recording",
  "menu",
  "managed",
];

const isSection = (value: unknown): value is EditSectionId =>
  typeof value === "string" && (SECTION_IDS as readonly string[]).includes(value);

/** A drift cell the phone is actually behind on. Same test the sections
 *  themselves use, so a tab and the card under it can never disagree. */
const isStale = (cell: DriftCell) => cell.state === "stale";

export default async function EditLocationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();

  /* Read on the server so the chosen panel is in the first byte of HTML.
     A hash never reaches the server, so a #menu arrival would render
     Business and correct itself after hydration -- a visible wrong-tab
     flash. ?section= removes it; the hash still works and EditTabs
     rewrites it to this form on arrival. */
  const query = await searchParams;
  const initial: EditSectionId = isSection(query.section) ? query.section : "business";

  // Gated inside: getEditableRecord re-checks currentPlatformAdmin() and
  // returns null for a non-admin, a bad id and a location that does not
  // exist alike. It THROWS LocationReadError when the row could not be
  // read, which app/admin/error.tsx catches -- a transient Postgres blip
  // must not delete a restaurant from the console.
  const record = await getEditableRecord(locationId);
  if (!record) notFound();

  const { location, org, hours, holidays, categories, items } = record;
  const tz = location.timezone;

  // One read-only GET against Vapi, so the "the phone is still on the
  // old value" banner is a fact about the assistant rather than a memory
  // of somebody's last click. That is what makes it survive a reload, a
  // closed tab, and a different operator opening this page.
  const drift = await readAssistantDrift(location);
  const hasAssistant = location.vapi_assistant_id !== null;

  /* Which tabs carry "Phone not updated" before anything is touched.
     Computed here, off the one Vapi read above, so the chip is painted
     with the strip and never appears mid-session -- the strip does not
     reflow under the operator's hand. The groupings are the sections'
     own: BusinessSection weighs name and address, AnsweringSection the
     greeting and the transfer destination, ServiceSection the order
     types. Without this, tabs would bury the drift warning the flag
     exists to raise. */
  const behind: EditSectionId[] = [];
  if (isStale(drift.name) || isStale(drift.address)) behind.push("business");
  if (isStale(drift.greeting) || isStale(drift.transfer)) behind.push("answering");
  if (isStale(drift.orderTypes)) behind.push("service");

  return (
    <>
      <div className="page-head">
        <div>
          <Link href={`/admin/${location.id}`} className="row-link">
            ← {location.name}
          </Link>
          <h1>Edit details</h1>
          <div className="text-muted sub">
            Everything a restaurant can ring up and ask you to change. Almost all of it is read out
            of the database inside the call, so it is live on the very next one — the handful of
            fields that were built into the assistant instead are marked, and saving one of those
            rebuilds it.
          </div>
        </div>
        <div className="actions">
          <Link href={`/admin/${location.id}`} className="btn btn-secondary">
            Overview &amp; go-live
          </Link>
        </div>
      </div>

      {/* One section on screen, nothing below it.

          The operator's words: "it's like a stack ... I just have to
          scroll all the way to the down. I don't like it ... I just want
          to click on the section." Nine cards were 8210px of document
          with the Menu heading 5346px down; asked how a section should
          open, they chose tabs.

          Every panel below is rendered on every render and the inactive
          ones are display:none, so a half-typed price in Menu survives a
          trip to Hours and back -- and so a hidden panel is out of the
          focus order, out of the a11y tree and out of find-in-page. */}
      <EditTabs initial={initial} behind={behind}>
        <EditPanel id="business">
          <BusinessSection
            locationId={location.id}
            orgName={org.name}
            plan={org.plan}
            name={location.name}
            timezone={location.timezone}
            address={location.address}
            businessPhone={location.business_phone}
            carrierName={location.carrier_name}
            timezones={TIMEZONES}
            updatedAt={location.updated_at}
            drift={drift}
            hasAssistant={hasAssistant}
          />
        </EditPanel>

        <EditPanel id="hours">
          {/* #hours and #holidays. Both stay in one panel: a holiday
              is an override of a weekly row, and "we close at 3 on
              Christmas Eve" is unjudgeable without Tuesday's normal
              hours on the same screen. The actions are passed in rather
              than imported by the component: every one of them gates on
              currentPlatformAdmin() itself, so nothing is lost, and the
              editor stays a thing that can be rendered from a test. */}
          <HoursEditor
            locationId={location.id}
            timezone={tz}
            hours={hours}
            holidays={holidays}
            saveHoursAction={saveHoursAction}
            saveHolidayAction={saveHolidayAction}
            deleteHolidayAction={deleteHolidayAction}
          />
        </EditPanel>

        <EditPanel id="answering">
          <AnsweringSection
            locationId={location.id}
            greetingText={location.greeting_text}
            fallbackNumber={location.fallback_human_number}
            updatedAt={location.updated_at}
            drift={drift}
            hasAssistant={hasAssistant}
          />
        </EditPanel>

        <EditPanel id="service">
          <ServiceSection
            locationId={location.id}
            taxRateBps={location.tax_rate_bps}
            orderTypes={location.order_types}
            pickupPromiseMinutes={location.pickup_promise_minutes}
            deliveryPromiseMinutes={location.delivery_promise_minutes}
            seats={location.seats}
            maxPartySize={location.max_party_size}
            reservationSlotMinutes={location.reservation_slot_minutes}
            updatedAt={location.updated_at}
            drift={drift}
            hasAssistant={hasAssistant}
          />
        </EditPanel>

        <EditPanel id="orders">
          <OrderRoutingSection
            locationId={location.id}
            orderDelivery={location.order_delivery}
            orderSmsTo={location.order_sms_to}
            orderEmailTo={location.order_email_to}
            updatedAt={location.updated_at}
            hasNumber={location.twilio_number !== null}
          />
        </EditPanel>

        <EditPanel id="recording">
          <RecordingSection
            locationId={location.id}
            recordingEnabled={location.recording_enabled}
            recordingRetentionDays={location.recording_retention_days}
            updatedAt={location.updated_at}
          />
        </EditPanel>

        <EditPanel id="menu">
          {/* #menu and #sold-out, in one panel and no longer at the
              foot of eight screens of scrolling. It is the only
              unbounded section on the page, which used to decide its
              position and now costs it nothing. */}
          <MenuAdmin
            locationId={location.id}
            categories={categories}
            items={items}
            createCategoryAction={createMenuCategoryAction}
            saveCategoryAction={saveMenuCategoryAction}
            deleteCategoryAction={deleteMenuCategoryAction}
            createItemAction={createMenuItemAction}
            saveItemAction={saveMenuItemAction}
            deleteItemAction={deleteMenuItemAction}
            setSoldOutAction={setMenuItemSoldOutAction}
          />
        </EditPanel>

        <EditPanel id="managed">
          <SystemManaged location={location} org={org} tz={tz} />
        </EditPanel>
      </EditTabs>
    </>
  );
}

/* ── class B: facts, never disabled inputs ─────────────────────────── */

/** What the system manages.
 *
 *  Set as facts rather than as greyed-out fields, reusing the block
 *  /admin/<id> already uses for the same rows. A disabled input is a
 *  promise that the field is editable somewhere, sometime; these are not
 *  fields at all. And a free text box for twilio_number is not a
 *  convenience -- it is a typo that silently points a restaurant's calls
 *  at nothing, which is the whole reason the go-live panel exists.
 *
 *  The tool secret and the Stripe customer are reported as PRESENCE,
 *  never as value. A hash in a response body is still a secret in a
 *  response body; lib/admin/edit.ts already refuses to hand either one
 *  out, and this card would have nothing to print even if it wanted to. */
function SystemManaged({
  location,
  org,
  tz,
}: {
  location: EditableLocation;
  org: { stripe_customer_on_file: boolean };
  tz: string;
}) {
  /* `num` marks the rows whose value is a figure rather than prose --
     phone numbers, SIDs and the assistant's uuid. The house sets those
     in tabular figures everywhere else. */
  const facts: { label: string; value: string; num?: boolean }[] = [
    { label: "Live", value: location.is_live ? "yes" : "no" },
    { label: "Kill switch", value: location.kill_switch_on ? "ON" : "off" },
    { label: "Our number", value: location.twilio_number ?? "not provisioned", num: true },
    { label: "Number SID", value: location.twilio_number_sid ?? "—", num: true },
    { label: "Assistant", value: location.vapi_assistant_id ?? "none on file", num: true },
    {
      label: "Forwarding",
      value: location.forwarding_verified_at
        ? `verified ${relative(location.forwarding_verified_at)}`
        : "never verified",
    },
    { label: "Onboarding step", value: location.onboarding_step },
    { label: "Tool secret", value: location.tool_secret_on_file ? "set" : "not set" },
    { label: "Stripe customer", value: org.stripe_customer_on_file ? "on file" : "none" },
    { label: "Created", value: stamp(tz, location.created_at) },
    { label: "Updated", value: stamp(tz, location.updated_at) },
  ];

  return (
    <section id="managed" className="card blueprint setup-card">
      <Corners />
      <h2>What the system manages</h2>
      <p className="text-muted sub">
        Set by the go-live panel and by the assistant itself. Nothing on this page can type over
        them.
      </p>

      <div className="card blueprint admin-facts">
        <Corners />
        <dl>
          {facts.map((fact) => (
            <div key={fact.label} className="fact-row">
              <dt className="text-muted">{fact.label}</dt>
              <dd className={fact.num ? "num" : undefined}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="text-muted setup-note">
        Our number, the assistant and the state of the line are provisioned, checked against Vapi
        and written by the go-live panel. A number typed by hand is a typo that silently points a
        restaurant&rsquo;s calls at nothing. The tool secret and the Stripe customer are shown as
        set or not set and never as a value.{" "}
        <Link href={`/admin/${location.id}`} className="row-link">
          Go-live panel →
        </Link>
      </p>
    </section>
  );
}

/** A UTC timestamp in the restaurant's own clock, and the same guard as
 *  above for the same reason: a zone Intl does not know throws, and a
 *  broken timezone is one of the things an operator comes to this page
 *  to correct. Falling back to UTC and saying so beats a 500 on the only
 *  screen that can fix it. */
function stamp(timezone: string, iso: string): string {
  try {
    return dateTimeIn(timezone, iso);
  } catch {
    return `${dateTimeIn("UTC", iso)} UTC`;
  }
}

/* ── what the phone is actually carrying ───────────────────────────── */

/* Read off Vapi, not off a column and not off a timestamp.
 *
 * An `assistant_synced_at` column was the obvious alternative and it is
 * the wrong one: it would still read "synced" after a rebuild that
 * half-failed, which is precisely the case this exists to catch. Asking
 * Vapi is the same principle lib/provisioning/go-live.ts's whole panel
 * rests on.
 *
 * The expected values are derived by running the REAL builders --
 * buildGreeting and buildSystemPrompt -- over the row as it stands now,
 * and then reading the same three lines out of both strings. Nothing
 * about the prompt template or the interpolation is duplicated here, so
 * a change to lib/agent/prompt.ts cannot make this report a
 * disagreement that does not exist.
 *
 * Whole-prompt equality USED to be meaningless: {{current_datetime}} and
 * {{hours_today}} were frozen at build time and always differed by the
 * next day. Neither is any more -- the date is a Liquid template Vapi
 * renders per call and the hours line is a pointer at get_hours, so the
 * prompt is now deterministic for a given location row and whole-prompt
 * equality would mean something. Widening this comparison is a separate
 * change with its own failure modes (a prompt edited on Vapi by hand
 * would start reporting drift on every line at once); it is deliberately
 * not made here. So the comparison stays per line, anchored, and a line
 * that cannot be found at all is `unknown` -- never `matches`. */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The assistant's system message, as Vapi is holding it. */
function systemPromptOf(assistant: VapiAssistant): string | null {
  const model = assistant.model;
  if (!isObject(model) || !Array.isArray(model.messages)) return null;
  for (const message of model.messages) {
    if (isObject(message) && message.role === "system") return stringOf(message.content);
  }
  return null;
}

/** The destination of the native transferCall tool -- the one thing that
 *  actually moves the live phone leg. app/api/agent/transfer/route.ts
 *  reads the column and only tells the model a number; this is what
 *  dials. */
function transferNumberOf(assistant: VapiAssistant): string | null {
  const model = assistant.model;
  if (!isObject(model) || !Array.isArray(model.tools)) return null;
  for (const tool of model.tools) {
    if (!isObject(tool) || tool.type !== "transferCall") continue;
    if (!Array.isArray(tool.destinations) || tool.destinations.length === 0) continue;
    const first: unknown = tool.destinations[0];
    if (isObject(first)) return stringOf(first.number);
  }
  return null;
}

/** One "Label: value" line out of a system prompt. Anchored to the start
 *  of a line, so nothing in the body of the prompt can be mistaken for
 *  the details block at its foot. */
function promptLine(prompt: string | null, label: string): string | null {
  if (prompt === null) return null;
  const prefix = `${label}: `;
  for (const line of prompt.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

function cell(onPhone: string | null, expected: string | null): DriftCell {
  // Either half missing means this screen does not know, and it says so.
  // Reporting "matches" from an absent line is the exact false comfort
  // the flag exists to prevent.
  if (onPhone === null || expected === null) return { state: "unknown", onPhone };
  return onPhone.trim() === expected.trim()
    ? { state: "matches", onPhone }
    : { state: "stale", onPhone };
}

function noDrift(state: AssistantDrift["state"]): AssistantDrift {
  const unknown: DriftCell = { state: "unknown", onPhone: null };
  return {
    state,
    greeting: unknown,
    transfer: unknown,
    name: unknown,
    address: unknown,
    orderTypes: unknown,
  };
}

async function readAssistantDrift(location: EditableLocation): Promise<AssistantDrift> {
  if (!location.vapi_assistant_id) return noDrift("no-assistant");

  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) return noDrift("unreadable");

  let assistant: VapiAssistant | null;
  try {
    assistant = await getAssistant(vapiKey, location.vapi_assistant_id, {
      timeoutMs: PAGE_VAPI_TIMEOUT_MS,
    });
  } catch {
    // A timeout, a 500, a bad key. "We could not ask" is not evidence of
    // agreement, and it is not evidence of absence either -- the sections
    // print one muted sentence and every save still works.
    return noDrift("unreadable");
  }

  // Vapi says there is no such assistant. Different from never having
  // had one, and the go-live panel's repair is the destination.
  if (!assistant) return noDrift("missing");

  // agent_secret_hash is not on EditableLocation by design; the builders
  // never read it, and this row is never written anywhere.
  const row = { ...location, agent_secret_hash: null } as LocationRow;
  const onPhone = systemPromptOf(assistant);

  // locations.timezone has no CHECK constraint, and buildSystemPrompt
  // hands it to Intl.DateTimeFormat, which throws RangeError on a zone
  // it does not know. That is precisely the dead-air bug the timezone
  // <select> in this editor exists to prevent -- so it must not be able
  // to take down the one page an operator would open to FIX such a row.
  // The three prompt lines go unknown; the greeting and the transfer
  // destination need no timezone and are still compared.
  let expected: string | null = null;
  try {
    expected = buildSystemPrompt({ location: row });
  } catch {
    expected = null;
  }

  return {
    state: "read",
    greeting: cell(stringOf(assistant.firstMessage), buildGreeting(row)),
    transfer: cell(transferNumberOf(assistant), location.fallback_human_number),
    name: cell(promptLine(onPhone, "Name"), promptLine(expected, "Name")),
    address: cell(promptLine(onPhone, "Address"), promptLine(expected, "Address")),
    orderTypes: cell(
      promptLine(onPhone, "Order type available"),
      promptLine(expected, "Order type available"),
    ),
  };
}
