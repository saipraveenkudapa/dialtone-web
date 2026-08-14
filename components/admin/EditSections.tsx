"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { Corners } from "@/components/Corners";
import {
  ReplacedNote,
  useSectionDirty,
  useSectionReplaced,
  type EditSectionId,
} from "@/components/admin/EditTabs";
import { normalizePhoneToE164 } from "@/lib/phone";
import { formatBasisPointsAsPercent, parsePercentToBasisPoints } from "@/lib/money";
import {
  resyncAssistantAction,
  saveAnsweringAction,
  saveBusinessAction,
  saveOrderRoutingAction,
  saveRecordingAction,
  saveServiceAction,
} from "@/app/admin/[locationId]/edit/actions";
import type { EditResult } from "@/lib/admin/edit";

/* The operator's record editor: one card per subject, one Save per card.
 *
 * WHY PER SECTION, AND NOT ONE FORM OR ONE FIELD
 * ----------------------------------------------
 * The job this screen does is: the owner is on the phone, they want one
 * thing changed, and the operator changes it while they wait. One big
 * form would let one invalid field block nineteen valid ones and would
 * drag an assistant rebuild along with every save. One save per field
 * would be twenty round trips and could not express the rules the
 * database actually enforces across fields. A section is one UPDATE of a
 * handful of columns on one row: it lands or it does not, so a
 * half-saved restaurant is impossible by construction.
 *
 * NOTHING HERE IS A PERMISSION. A disabled Save button is ergonomics. It
 * stops an operator saving nothing by accident and stops nobody at all
 * from POSTing the action id by hand. Every action re-checks
 * currentPlatformAdmin() as its first statement, and lib/admin/edit.ts
 * -- the module holding the service-role key -- checks it again. See the
 * header of app/admin/[locationId]/edit/actions.ts.
 *
 * THE ONE THING THIS SCREEN EXISTS TO GET RIGHT
 * ---------------------------------------------
 * Most of this database is read live: lib/agent/auth.ts re-reads the
 * whole locations row on every tool call, and menu and hours are queried
 * per call. So a tax rate, a promise time, a seat count, the hours and
 * the menu are live on the NEXT CALL with nothing to push. That is the
 * product's promise and the live sections say so.
 *
 * SIX columns are not. lib/vapi/provision.ts's buildAssistantPayload is
 * a snapshot -- greeting into firstMessage, name/address/timezone/order
 * types into the system prompt, fallback number into the native transfer
 * destination -- and none of it is re-read on a call. Editing one of
 * those without re-pushing leaves the PHONE saying the old thing while
 * this screen says the new one, silently, forever. So:
 *
 *   * every one of those fields is flagged BEFORE it is edited, on the
 *     field itself and on its card;
 *   * the save reports what actually happened to the phone, including
 *     when the rebuild failed and the phone is still on the old value;
 *   * and the disagreement is read back off Vapi on page load, so it
 *     survives a reload, a closed tab and a different operator.
 *
 * `EditResult.ok` means THE DATABASE WAS WRITTEN. It does not mean the
 * phone agrees. Every render path below carries `phone` with it.
 */

/* ── what the phone is actually carrying ───────────────────────────── */

/** One baked value, compared against what the column says now.
 *
 *  `unknown` is not `matches`. If the line could not be found on the
 *  assistant at all, this screen must say it does not know rather than
 *  quietly assert agreement -- that assertion is the exact failure the
 *  whole flag exists to prevent. */
export type DriftCell = {
  state: "matches" | "stale" | "unknown";
  /** What Vapi is holding, when it could be read. */
  onPhone: string | null;
};

/** Read off Vapi on page load rather than remembered from the last
 *  click, which is why it survives a reload. Deliberately no
 *  `assistant_synced_at` column: a timestamp would still read "synced"
 *  after a rebuild that half-failed. */
export type AssistantDrift = {
  state: "read" | "no-assistant" | "missing" | "unreadable";
  greeting: DriftCell;
  transfer: DriftCell;
  name: DriftCell;
  address: DriftCell;
  orderTypes: DriftCell;
};

const REBUILDS = "Rebuilds the agent";

/* ── the shared machinery ──────────────────────────────────────────── */

/** A save in flight, and the sentence it came back with. */
function useSection() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<EditResult | null>(null);

  function run(action: () => Promise<EditResult>) {
    setResult(null);
    startTransition(async () => {
      try {
        setResult(await action());
      } catch {
        // A server action that never answers -- a dropped connection, a
        // request killed for running too long. Uncaught, the rejection
        // is re-thrown during render and takes the whole page to
        // app/admin/error.tsx, which loses every other section along
        // with it. This sentence deliberately claims nothing about
        // whether the write landed, because nothing here knows.
        setResult({
          ok: false,
          error:
            "That did not come back — the connection dropped, or the request ran too long. " +
            "Nothing here knows whether it landed. Reload the page to see where this restaurant " +
            "actually stands.",
        });
      }
    });
  }

  return { pending, result, run };
}

type Values = Record<string, string | boolean>;

function same(a: Values, b: Values): boolean {
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key]);
}

/** The form, seeded from the server and RE-seeded during render whenever
 *  the server's answer moves.
 *
 *  Taken during render rather than in an effect -- the same pattern
 *  components/admin/GoLive.tsx uses for its fallback field -- so a tab
 *  left open never sits there showing an edit the database has already
 *  replaced, and so a value the server normalised on the way in (a phone
 *  number rewritten to E.164) appears as it was actually stored.
 *
 *  A REFUSED save re-renders with identical props, so nothing moves and
 *  the operator's typed text stays exactly where it was.
 *
 *  ...AND IT SAYS SO WHEN IT DOES. A re-seed that lands on top of typing
 *  used to be silent. Every action on this route calls revalidatePath,
 *  so one write anywhere on the page -- a dish flipped to sold out three
 *  panels away -- hands this form fresh props, and if the record moved
 *  underneath (a second operator, the owner's own screen) the typing
 *  went with no account of itself. Under tabs that is worse, not better:
 *  the card is display:none, so both the loss and the disappearance of
 *  its "Unsaved" chip happen off screen. The fourth element of the
 *  tuple is that, and every caller renders <ReplacedNote /> from it.
 *
 *  `section` is which tab this form sits behind, and it buys the strip's
 *  chips and the beforeunload guard. Under tabs the card's own flag can
 *  be on a panel that is display:none, and the one loss beforeunload
 *  cannot see is a client-side route change -- pressing "Overview &
 *  go-live" in the page head. The chip on the tab is then the only
 *  visible sign that something is unsaved, which is why it is threaded
 *  through here rather than left to the heading below. Outside an
 *  <EditTabs> the report goes nowhere and nothing renders differently. */
function useSeeded<T extends Values>(
  section: EditSectionId,
  server: T,
): [T, (patch: Partial<T>) => void, boolean, boolean] {
  const [form, setForm] = useState<T>(server);
  const [seen, setSeen] = useState<T>(server);
  const [replaced, setReplaced] = useState(false);

  if (!same(seen, server)) {
    // Two conditions, and the second one is what keeps this quiet on an
    // ordinary save: there WAS typing (the form does not match the value
    // this was seeded from) and what arrived is not it (the form does
    // not match the value that has just landed either). An operator's
    // own save satisfies the first and fails the second.
    setReplaced(!same(form, seen) && !same(form, server));
    setSeen(server);
    setForm(server);
  }

  // The cast is the one TypeScript needs and the one that is safe: a
  // spread of T over T is still T, but the compiler models it as
  // T & Partial<T>.
  const apply = (p: Partial<T>) => setForm((f) => ({ ...f, ...p }) as T);
  const dirty = !same(form, server);

  // The account of a loss stands until there is something new to lose.
  // Adjusted during render, the same way the re-seed above is, rather
  // than in an effect that would paint the stale sentence for a frame.
  if (replaced && dirty) setReplaced(false);

  // Reports the "Unsaved" chip to the strip AND registers the
  // beforeunload guard for as long as this form is dirty -- the guard
  // used to be written out here, and in five other components it was
  // simply missing. components/admin/EditTabs.tsx has the account.
  useSectionDirty(section, dirty);
  useSectionReplaced(section, replaced);

  return [form, apply, dirty, replaced];
}

/** A card. The flags live in the heading because they have to survive
 *  scrolling past the field they belong to. */
function SectionCard({
  id,
  title,
  lede,
  flags,
  children,
}: {
  id: string;
  title: string;
  lede: ReactNode;
  flags: { label: string; tone: "out" | "neutral" }[];
  children: ReactNode;
}) {
  return (
    <section id={id} className="card blueprint setup-card">
      <Corners />
      <h2>
        {title}
        {flags.map((flag) => (
          <span key={flag.label} className={`tag tag-${flag.tone} edit-flag`}>
            {flag.label}
          </span>
        ))}
      </h2>
      <p className="text-muted sub">{lede}</p>
      {children}
    </section>
  );
}

/** The label flag, inside the <label> so a screen reader reads
 *  "Fallback number, rebuilds the agent" rather than meeting the warning
 *  after the input. */
function Flag() {
  return <span className="tag tag-outline edit-flag">{REBUILDS}</span>;
}

/** The standing statement of how far a save in this card reaches, before
 *  anything has been typed. */
function Reach({
  kind,
  children,
}: {
  kind: "live" | "sync";
  children: ReactNode;
}) {
  return <p className={`edit-note is-${kind}`}>{children}</p>;
}

/** The same statement for a card that rebuilds, WITH the push on it.
 *
 *  The button is here rather than only on a drift note because a drift
 *  note is not always renderable. The drift read is one Vapi GET with a
 *  five-second ceiling; when it times out, or the key is unset, or the
 *  record names an assistant Vapi no longer has, every cell comes back
 *  `unknown` and no DriftNote renders anywhere. Meanwhile Save is
 *  disabled whenever the form is not dirty. On a restaurant whose
 *  columns are already right and whose assistant is behind -- exactly
 *  the state lib/provisioning/go-live.ts's setFallbackNumber leaves,
 *  because it writes the column and cannot rebuild -- there would then
 *  be nothing on the page to press, and the phone would go on
 *  transferring allergy and catering calls to the old number with no
 *  error on either side.
 *
 *  It writes no column: it pushes the row exactly as it stands on the
 *  server, which is what makes it safe to press twice and safe to press
 *  with unsaved text in the fields. */
function SyncReach({
  pending,
  onResync,
  children,
}: {
  pending: boolean;
  onResync: () => void;
  children: ReactNode;
}) {
  return (
    <p className="edit-note is-sync">
      <span className="tag tag-outline">{REBUILDS}</span>
      {children}{" "}
      <button type="button" className="btn btn-secondary" disabled={pending} onClick={onResync}>
        Update the phone
      </button>
    </p>
  );
}

/** What the phone is saying, when it disagrees with the screen.
 *
 *  Rendered from the Vapi read rather than from the last click, so it is
 *  still here after a reload and is here for an operator who did not
 *  make the edit. The button re-pushes the row exactly as it stands --
 *  nothing to retype, and safe to press twice. */
function DriftNote({
  cell,
  pending,
  onResync,
  children,
}: {
  cell: DriftCell;
  pending: boolean;
  onResync: () => void;
  children: ReactNode;
}) {
  if (cell.state !== "stale") return null;
  return (
    <p className="edit-note is-drift">
      <span className="tag tag-out">Phone not updated</span>
      {children}{" "}
      <button type="button" className="btn btn-secondary" disabled={pending} onClick={onResync}>
        Update the phone
      </button>
    </p>
  );
}

/** Why there is no drift answer for this card. Never silence: "we did
 *  not check" and "it agrees" are opposite facts. */
function DriftUnknown({ drift, locationId }: { drift: AssistantDrift; locationId: string }) {
  if (drift.state === "read" || drift.state === "no-assistant") return null;
  if (drift.state === "missing") {
    return (
      <p className="text-muted setup-note">
        This record points at an assistant Vapi does not have, so nothing here can be checked
        against the phone.{" "}
        <Link href={`/admin/${locationId}`} className="row-link">
          Repair it on the go-live panel →
        </Link>
      </p>
    );
  }
  return (
    <p className="text-muted setup-note">
      The assistant could not be read just now, so what the phone is saying cannot be confirmed
      here. Saving still works.
    </p>
  );
}

/** The foot of every card: the account of the save, then Save.
 *
 *  The button never changes its label. A control that resizes mid-press
 *  is one an operator stops trusting; the account goes in the status
 *  line beside it, which is a live region. */
function SaveRow({
  statusId,
  pending,
  dirty,
  blocked,
  blockedReason,
  rebuilds,
  result,
  onSave,
}: {
  statusId: string;
  pending: boolean;
  dirty: boolean;
  blocked: boolean;
  /** Why Save is unavailable, when it is. A disabled control that says
   *  nothing is a control an operator has to guess at. */
  blockedReason?: string;
  /** True when this save, as the fields currently stand, will also push
   *  the assistant -- so the wait can be explained before it happens
   *  rather than excused after. */
  rebuilds: boolean;
  result: EditResult | null;
  onSave: () => void;
}) {
  const status = pending
    ? rebuilds
      ? "Saving, then rebuilding the assistant. The rebuild is the slow part…"
      : "Saving…"
    : blocked && blockedReason
      ? blockedReason
      : result?.ok
        ? result.message
        : dirty
          ? "Not saved yet."
          : "";

  return (
    <div className="setup-actions">
      <p className="edit-status" role="status" aria-live="polite" id={statusId}>
        {status}
      </p>
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending || !dirty || blocked}
        onClick={onSave}
      >
        Save
      </button>
    </div>
  );
}

/** The refusal, in the one place every other form in this product puts
 *  it. A PostgrestError's text never reaches here: lib/admin/edit.ts
 *  logs the location id and the SQLSTATE and writes the sentence
 *  itself. */
function Refusal({ id, result, pending }: { id: string; result: EditResult | null; pending: boolean }) {
  if (pending || !result || result.ok) return null;
  return (
    <p className="setup-error" id={id}>
      {result.error}
    </p>
  );
}

/** What a save did to the phone, when what it did was not enough.
 *
 *  `ok: true` carries these: the database was written and the assistant
 *  was not. A card that rendered `message` and stopped would be telling
 *  half the truth. */
function PhoneOutcome({
  result,
  locationId,
  pending,
  onResync,
}: {
  result: EditResult | null;
  locationId: string;
  pending: boolean;
  onResync: () => void;
}) {
  if (pending || !result || !result.ok) return null;

  if (result.phone.state === "failed") {
    return (
      <p className="edit-note is-drift">
        <span className="tag tag-out">Phone not updated</span>
        The data is saved. The assistant is still carrying the old value, so the screen and the
        phone disagree until this is pushed again.{" "}
        <button type="button" className="btn btn-secondary" disabled={pending} onClick={onResync}>
          Update the phone
        </button>
      </p>
    );
  }

  if (result.phone.state === "secret-lost") {
    return (
      <p className="edit-note is-drift">
        <span className="tag tag-out">Tools will not authenticate</span>
        The assistant will answer the phone and then be unable to read the menu, take an order or
        transfer a caller. This is worse than a stale value and it needs the repair, not another
        save.{" "}
        <Link href={`/admin/${locationId}`} className="row-link">
          Repair the assistant on the go-live panel →
        </Link>
      </p>
    );
  }

  return null;
}

/** Does the last save, or the standing Vapi read, say this card's phone
 *  is behind? */
function phoneBehind(result: EditResult | null, cells: DriftCell[]): boolean {
  if (result?.ok && (result.phone.state === "failed" || result.phone.state === "secret-lost")) {
    return true;
  }
  return cells.some((cell) => cell.state === "stale");
}

function flagsFor(dirty: boolean, behind: boolean) {
  const flags: { label: string; tone: "out" | "neutral" }[] = [];
  if (behind) flags.push({ label: "Phone not updated", tone: "out" });
  if (dirty) flags.push({ label: "Unsaved", tone: "neutral" });
  return flags;
}

/** A number as it will actually be stored, or the reason it will not be.
 *  The preview costs nothing and prevents the round trip. */
function phonePreview(raw: string, blank: string): string {
  if (raw.trim() === "") return blank;
  const e164 = normalizePhoneToE164(raw);
  return e164 ? `Will store ${e164}.` : "Not a number we can dial.";
}

/* ══ 1. the business ═══════════════════════════════════════════════ */

export function BusinessSection({
  locationId,
  orgName,
  plan,
  name,
  timezone,
  address,
  businessPhone,
  carrierName,
  timezones,
  updatedAt,
  drift,
  hasAssistant,
}: {
  locationId: string;
  orgName: string;
  plan: string;
  name: string;
  timezone: string;
  address: string | null;
  businessPhone: string | null;
  carrierName: string | null;
  /** locations.updated_at as this page was rendered from. Sent back with
   *  the save, which the server makes conditional on it -- so a tab left
   *  open while another operator changed this restaurant refuses rather
   *  than putting their change back and baking it into the assistant. */
  updatedAt: string;
  /** Every IANA zone this runtime knows. A text box here is a dead-air
   *  generator: no agent route catches the RangeError Intl throws on an
   *  unknown zone, so a typo becomes a framework 500 that Vapi discards
   *  and the caller hears as silence. */
  timezones: string[];
  drift: AssistantDrift;
  hasAssistant: boolean;
}) {
  const server = {
    orgName,
    plan,
    name,
    timezone,
    address: address ?? "",
    businessPhone: businessPhone ?? "",
    carrierName: carrierName ?? "",
  };
  const [form, patch, dirty, replaced] = useSeeded("business", server);
  const { pending, result, run } = useSection();

  const resync = () => run(() => resyncAssistantAction(locationId));
  const rebuilds =
    hasAssistant &&
    (form.name !== server.name ||
      form.timezone !== server.timezone ||
      form.address !== server.address);

  // A zone the column holds that this runtime does not list would
  // otherwise vanish from the select and be silently replaced on the
  // next save.
  const zones = timezones.includes(form.timezone) ? timezones : [form.timezone, ...timezones];

  return (
    <SectionCard
      id="business"
      title="The business"
      lede="What the assistant tells callers, and the record everything else is filed under."
      flags={flagsFor(dirty, phoneBehind(result, [drift.name, drift.address]))}
    >
      {/* The account of a re-seed that landed on typing, first child
          of the card and above the fields it happened to. */}
      <ReplacedNote when={replaced} />
      {hasAssistant ? (
        <SyncReach pending={pending} onResync={resync}>
          The name, the address and the timezone were written into the assistant when it was made.
          Saving one rebuilds it, so the phone changes with the screen. That takes a few seconds
          and it can fail on its own — if it does, this card says so and keeps saying so until it
          is fixed. Update the phone pushes what is on file without saving anything typed here,
          and is safe to press twice.
        </SyncReach>
      ) : (
        <Reach kind="live">
          There is no assistant yet, so nothing here has been built into anything. The go-live
          panel builds it from these values.
        </Reach>
      )}

      <div className="setup-form">
        <div className="field">
          <label htmlFor="ed-name">
            Restaurant name
            <Flag />
          </label>
          <input
            id="ed-name"
            className="input"
            type="text"
            maxLength={120}
            value={form.name}
            disabled={pending}
            aria-describedby="ed-business-error"
            onChange={(e) => patch({ name: e.target.value })}
          />
          <p className="text-muted setup-note">
            What the assistant calls this restaurant on the phone — it says it twice, and again in
            the default greeting. Not the organization&rsquo;s name below.
          </p>
          <DriftNote cell={drift.name} pending={pending} onResync={resync}>
            The assistant is still introducing this restaurant as &ldquo;{drift.name.onPhone}
            &rdquo; on every call.
          </DriftNote>
        </div>

        <div className="field">
          <label htmlFor="ed-address">
            Address
            <Flag />
          </label>
          <input
            id="ed-address"
            className="input"
            type="text"
            maxLength={300}
            placeholder="1412 Telegraph Ave, Oakland, CA"
            value={form.address}
            disabled={pending}
            aria-describedby="ed-business-error"
            onChange={(e) => patch({ address: e.target.value })}
          />
          <p className="text-muted setup-note">
            Read out to callers who ask where you are. Left blank, the assistant says it is not on
            file.
          </p>
          <DriftNote cell={drift.address} pending={pending} onResync={resync}>
            The assistant is still reading out &ldquo;{drift.address.onPhone}&rdquo;.
          </DriftNote>
        </div>

        <div className="setup-row">
          <div className="field">
            <label htmlFor="ed-timezone">
              Timezone
              <Flag />
            </label>
            <select
              id="ed-timezone"
              className="input"
              value={form.timezone}
              disabled={pending}
              aria-describedby="ed-business-error"
              onChange={(e) => patch({ timezone: e.target.value })}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <p className="text-muted setup-note">
              Every time this restaurant sees is rendered in this zone; the database stores UTC.
              The assistant works out &ldquo;tomorrow&rdquo; and &ldquo;this Friday&rdquo; from it,
              and so does every open/closed decision. A list, not a box, on purpose: a zone this
              system does not know makes the assistant fail mid-call rather than say the wrong
              time.
            </p>
            {hasAssistant ? (
              <p className="edit-note is-sync">
                <span className="tag tag-outline">{REBUILDS}</span>
                This is the one baked value with nothing on the assistant to compare it against:
                it reaches the prompt only through the date and time line, which was frozen when
                the assistant was built. So a timezone change that failed to rebuild cannot be
                detected here after a reload — the assistant would go on working out
                &ldquo;tomorrow&rdquo; and &ldquo;this Friday&rdquo; in the old zone with nothing
                on this page saying so. If a timezone save did not report the rebuild, push it.
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={pending}
                  onClick={resync}
                >
                  Update the phone
                </button>
              </p>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="ed-business-phone">Display phone (optional)</label>
            <input
              id="ed-business-phone"
              className="input"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="(510) 555-0119"
              value={form.businessPhone}
              disabled={pending}
              aria-describedby="ed-business-error"
              onChange={(e) => patch({ businessPhone: e.target.value })}
            />
            <p className="text-muted setup-note">
              The restaurant&rsquo;s own published line. It is what the forwarding instructions
              quote back; nothing on a call is matched against it.{" "}
              {phonePreview(form.businessPhone, "")}
            </p>
          </div>
        </div>

        <div className="field">
          <label htmlFor="ed-carrier">Carrier</label>
          <input
            id="ed-carrier"
            className="input"
            type="text"
            maxLength={80}
            placeholder="Verizon"
            value={form.carrierName}
            disabled={pending}
            aria-describedby="ed-business-error"
            onChange={(e) => patch({ carrierName: e.target.value })}
          />
          <p className="text-muted setup-note">
            Picks the *72-style forwarding codes on the hand-over sheet the go-live panel prints.
          </p>
        </div>

        <div className="setup-row">
          <div className="field">
            <label htmlFor="ed-org-name">Organization name</label>
            <input
              id="ed-org-name"
              className="input"
              type="text"
              maxLength={120}
              value={form.orgName}
              disabled={pending}
              aria-describedby="ed-business-error"
              onChange={(e) => patch({ orgName: e.target.value })}
            />
            <p className="text-muted setup-note">
              The billing entity. It was named after this restaurant when the account was created;
              renaming one does not rename the other, and the assistant never says this one.
            </p>
          </div>

          <div className="field">
            <span className="field-label">Plan</span>
            <div className="seg">
              {(["trial", "starter", "growth"] as const).map((option) => (
                <label key={option} className="seg-opt">
                  <input
                    type="radio"
                    name="ed-plan"
                    value={option}
                    checked={form.plan === option}
                    disabled={pending}
                    onChange={() => patch({ plan: option })}
                  />
                  {option[0].toUpperCase() + option.slice(1)}
                </label>
              ))}
            </div>
            <p className="text-muted setup-note">
              Records what they are on. Nothing gates on it and it tells Stripe nothing.
            </p>
          </div>
        </div>

        <DriftUnknown drift={drift} locationId={locationId} />
      </div>

      <SaveRow
        statusId="ed-business-status"
        pending={pending}
        dirty={dirty}
        blocked={false}
        rebuilds={rebuilds}
        result={result}
        onSave={() =>
          run(() =>
            saveBusinessAction(
              locationId,
              {
                orgName: form.orgName,
                plan: form.plan,
                name: form.name,
                timezone: form.timezone,
                address: form.address,
                businessPhone: form.businessPhone,
                carrierName: form.carrierName,
              },
              updatedAt,
            ),
          )
        }
      />

      <PhoneOutcome result={result} locationId={locationId} pending={pending} onResync={resync} />
      <Refusal id="ed-business-error" result={result} pending={pending} />
    </SectionCard>
  );
}

/* ══ 2. answering the phone ════════════════════════════════════════ */

export function AnsweringSection({
  locationId,
  greetingText,
  fallbackNumber,
  updatedAt,
  drift,
  hasAssistant,
}: {
  locationId: string;
  greetingText: string;
  fallbackNumber: string | null;
  /** locations.updated_at as this page was rendered from. The save is
   *  conditional on it server-side, so a stale tab refuses rather than
   *  putting another operator's change back. */
  updatedAt: string;
  drift: AssistantDrift;
  hasAssistant: boolean;
}) {
  const server = { greetingText, fallbackNumber: fallbackNumber ?? "" };
  const [form, patch, dirty, replaced] = useSeeded("answering", server);
  const { pending, result, run } = useSection();

  const resync = () => run(() => resyncAssistantAction(locationId));
  const rebuilds = hasAssistant && dirty;
  const e164 = normalizePhoneToE164(form.fallbackNumber);
  const badNumber = form.fallbackNumber.trim() !== "" && e164 === null;

  return (
    <SectionCard
      id="answering"
      title="Answering the phone"
      lede="The first thing a caller hears, and where the assistant sends anything it can't handle itself."
      flags={flagsFor(dirty, phoneBehind(result, [drift.greeting, drift.transfer]))}
    >
      {/* The account of a re-seed that landed on typing, first child
          of the card and above the fields it happened to. */}
      <ReplacedNote when={replaced} />
      {hasAssistant ? (
        <SyncReach pending={pending} onResync={resync}>
          Both fields here were written into the assistant when it was made. Saving them rebuilds
          it, so the phone changes with the screen. That takes a few seconds and it can fail on its
          own — if it does, this card says so and keeps saying so until it is fixed. Update the
          phone pushes what is on file without saving anything typed here, and is safe to press
          twice.
        </SyncReach>
      ) : (
        <Reach kind="live">
          There is no assistant yet, so nothing here has been built into anything. The go-live
          panel builds it from these values.
        </Reach>
      )}

      <div className="setup-form">
        <div className="field">
          <label htmlFor="ed-greeting">
            Greeting text
            <Flag />
          </label>
          <textarea
            id="ed-greeting"
            className="input"
            maxLength={400}
            rows={3}
            value={form.greetingText}
            disabled={pending}
            aria-describedby="ed-answering-error"
            onChange={(e) => patch({ greetingText: e.target.value })}
          />
          <p className="text-muted setup-note">
            Spoken exactly as written and never regenerated by the model. Leave it empty and the
            assistant opens with &ldquo;Hi, thanks for calling {"{restaurant name}"}! What can I
            get for you?&rdquo;
          </p>
          <DriftNote cell={drift.greeting} pending={pending} onResync={resync}>
            The assistant is still opening with &ldquo;{drift.greeting.onPhone}&rdquo;.
          </DriftNote>
        </div>

        <div className="field">
          <label htmlFor="ed-fallback">
            Fallback number
            <Flag />
          </label>
          <input
            id="ed-fallback"
            className="input"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="(510) 555-0100"
            value={form.fallbackNumber}
            disabled={pending}
            aria-invalid={badNumber ? "true" : undefined}
            aria-describedby="ed-answering-error"
            onChange={(e) => patch({ fallbackNumber: e.target.value })}
          />
          <p className="text-muted setup-note">
            Where catering questions and anything about an allergy get transferred, and where every
            call goes while the kill switch is on. It cannot be left empty — a restaurant with no
            transfer number tells those callers &ldquo;no transfer number is set up&rdquo; in the
            middle of the call.{" "}
            {phonePreview(form.fallbackNumber, "Enter the number transfers should dial.")}
          </p>
          <DriftNote cell={drift.transfer} pending={pending} onResync={resync}>
            The assistant&rsquo;s own transfer still dials{" "}
            <span className="num">{drift.transfer.onPhone}</span>. Its tools already read the new
            number, so the agent says it is transferring and the call moves to the old one.
          </DriftNote>
        </div>

        <DriftUnknown drift={drift} locationId={locationId} />
      </div>

      <SaveRow
        statusId="ed-answering-status"
        pending={pending}
        dirty={dirty}
        blocked={badNumber || form.fallbackNumber.trim() === ""}
        blockedReason={
          form.fallbackNumber.trim() === ""
            ? "A fallback number is required before this card can be saved."
            : "That fallback number is not one we can dial."
        }
        rebuilds={rebuilds}
        result={result}
        onSave={() =>
          run(() =>
            saveAnsweringAction(
              locationId,
              { greetingText: form.greetingText, fallbackNumber: form.fallbackNumber },
              updatedAt,
            ),
          )
        }
      />

      <PhoneOutcome result={result} locationId={locationId} pending={pending} onResync={resync} />
      <Refusal id="ed-answering-error" result={result} pending={pending} />
    </SectionCard>
  );
}

/* ══ 3. money & service ════════════════════════════════════════════ */

export function ServiceSection({
  locationId,
  taxRateBps,
  orderTypes,
  pickupPromiseMinutes,
  deliveryPromiseMinutes,
  seats,
  maxPartySize,
  reservationSlotMinutes,
  updatedAt,
  drift,
  hasAssistant,
}: {
  locationId: string;
  taxRateBps: number;
  orderTypes: string;
  pickupPromiseMinutes: number;
  deliveryPromiseMinutes: number;
  seats: number;
  maxPartySize: number;
  reservationSlotMinutes: number;
  /** locations.updated_at as this page was rendered from. The save is
   *  conditional on it server-side, so a stale tab refuses rather than
   *  putting another operator's change back. */
  updatedAt: string;
  drift: AssistantDrift;
  hasAssistant: boolean;
}) {
  const server = {
    // The stored basis points, read back as the percentage they
    // represent, so the box shows what actually landed rather than what
    // somebody once typed.
    taxPercent: formatBasisPointsAsPercent(taxRateBps).replace("%", ""),
    orderTypes,
    pickupPromiseMinutes: String(pickupPromiseMinutes),
    deliveryPromiseMinutes: String(deliveryPromiseMinutes),
    seats: String(seats),
    maxPartySize: String(maxPartySize),
    reservationSlotMinutes: String(reservationSlotMinutes),
  };
  const [form, patch, dirty, replaced] = useSeeded("service", server);
  const { pending, result, run } = useSection();

  const resync = () => run(() => resyncAssistantAction(locationId));
  const rebuilds = hasAssistant && form.orderTypes !== server.orderTypes;
  const previewBps = parsePercentToBasisPoints(form.taxPercent.trim());

  return (
    <SectionCard
      id="service"
      title="Money & service"
      lede="Sales tax is typed as a percentage and stored as whole basis points — the database can only hold a whole number of them, so a rate like 6.625% is rounded to the nearest one."
      flags={flagsFor(dirty, phoneBehind(result, [drift.orderTypes]))}
    >
      {/* The account of a re-seed that landed on typing, first child
          of the card and above the fields it happened to. */}
      <ReplacedNote when={replaced} />
      <Reach kind="live">
        The tax rate, the promise times, the seat count, the reservation length and the max party
        size are read out of the database inside the call. Saved here, live on the very next call,
        with nothing to rebuild.
      </Reach>
      {hasAssistant ? (
        <SyncReach pending={pending} onResync={resync}>
          Order types is the exception. It is checked live when an order is placed AND written into
          the assistant&rsquo;s prompt, so changing it without a rebuild leaves the two halves
          disagreeing: the agent says &ldquo;pickup only&rdquo; while a delivery order would have
          been accepted, or offers delivery and is then refused with the caller on the line. Update
          the phone pushes what is on file without saving anything typed here.
        </SyncReach>
      ) : null}

      <div className="setup-form">
        <div className="field">
          <label htmlFor="ed-tax">Sales tax rate (%)</label>
          <input
            id="ed-tax"
            className="input"
            type="text"
            inputMode="decimal"
            placeholder="8.75"
            value={form.taxPercent}
            disabled={pending}
            aria-describedby="ed-service-error"
            onChange={(e) => patch({ taxPercent: e.target.value })}
          />
          <p className="text-muted tax-preview">
            {previewBps === null
              ? "Enter a plain percentage, e.g. 8.75."
              : `Will store ${previewBps} basis points (${formatBasisPointsAsPercent(previewBps)}).`}
          </p>
        </div>

        <div className="field">
          <span className="field-label">
            Order types
            <Flag />
          </span>
          <div className="seg">
            {(["pickup", "delivery", "both"] as const).map((option) => (
              <label key={option} className="seg-opt">
                <input
                  type="radio"
                  name="ed-order-types"
                  value={option}
                  checked={form.orderTypes === option}
                  disabled={pending}
                  onChange={() => patch({ orderTypes: option })}
                />
                {option === "both" ? "Pickup & delivery" : option[0].toUpperCase() + option.slice(1)}
              </label>
            ))}
          </div>
          <DriftNote cell={drift.orderTypes} pending={pending} onResync={resync}>
            The assistant is still telling callers this restaurant does{" "}
            {drift.orderTypes.onPhone}.
          </DriftNote>
        </div>

        <div className="money-grid">
          <div className="field">
            <label htmlFor="ed-pickup">Pickup ready in (minutes)</label>
            <input
              id="ed-pickup"
              className="input"
              type="number"
              min={5}
              max={180}
              value={form.pickupPromiseMinutes}
              disabled={pending}
              aria-describedby="ed-service-error"
              onChange={(e) => patch({ pickupPromiseMinutes: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="ed-delivery">Delivery ready in (minutes)</label>
            <input
              id="ed-delivery"
              className="input"
              type="number"
              min={5}
              max={180}
              value={form.deliveryPromiseMinutes}
              disabled={pending}
              aria-describedby="ed-service-error"
              onChange={(e) => patch({ deliveryPromiseMinutes: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="ed-seats">Seats</label>
            <input
              id="ed-seats"
              className="input"
              type="number"
              min={1}
              value={form.seats}
              disabled={pending}
              aria-describedby="ed-service-error"
              onChange={(e) => patch({ seats: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="ed-party">Max party size</label>
            <input
              id="ed-party"
              className="input"
              type="number"
              min={1}
              max={40}
              value={form.maxPartySize}
              disabled={pending}
              aria-describedby="ed-service-error"
              onChange={(e) => patch({ maxPartySize: e.target.value })}
            />
          </div>
          <div className="field span-2">
            <label htmlFor="ed-slot">Reservation length (minutes)</label>
            <input
              id="ed-slot"
              className="input"
              type="number"
              min={30}
              max={240}
              step={15}
              value={form.reservationSlotMinutes}
              disabled={pending}
              aria-describedby="ed-service-error"
              onChange={(e) => patch({ reservationSlotMinutes: e.target.value })}
            />
            <p className="text-muted setup-note">
              How long one table is held for a reservation. It is the window the availability sweep
              uses, so a long one makes a two-top block the room all evening.
            </p>
          </div>
        </div>

        <p className="text-muted setup-note">
          The promise times are spoken to the caller and printed on the kitchen ticket. Seats and
          the reservation length decide whether a booking is refused as full — too few seats
          refuses every table, too many double-books the dining room, and both are only visible at
          seven o&rsquo;clock.
        </p>
      </div>

      <SaveRow
        statusId="ed-service-status"
        pending={pending}
        dirty={dirty}
        blocked={false}
        rebuilds={rebuilds}
        result={result}
        onSave={() =>
          run(() =>
            saveServiceAction(
              locationId,
              {
                taxPercent: form.taxPercent,
                orderTypes: form.orderTypes,
                pickupPromiseMinutes: form.pickupPromiseMinutes,
                deliveryPromiseMinutes: form.deliveryPromiseMinutes,
                seats: form.seats,
                maxPartySize: form.maxPartySize,
                reservationSlotMinutes: form.reservationSlotMinutes,
              },
              updatedAt,
            ),
          )
        }
      />

      <PhoneOutcome result={result} locationId={locationId} pending={pending} onResync={resync} />
      <Refusal id="ed-service-error" result={result} pending={pending} />
    </SectionCard>
  );
}

/* ══ 4. where orders go ════════════════════════════════════════════ */

export function OrderRoutingSection({
  locationId,
  orderDelivery,
  orderSmsTo,
  orderEmailTo,
  updatedAt,
  hasNumber,
}: {
  locationId: string;
  orderDelivery: string;
  orderSmsTo: string | null;
  orderEmailTo: string | null;
  /** locations.updated_at as this page was rendered from. The save is
   *  conditional on it server-side, so a stale tab refuses rather than
   *  putting another operator's change back. */
  updatedAt: string;
  /** Whether this restaurant has a Vapi number yet. It is the SMS
   *  `From` on a kitchen ticket, so without one no ticket can be sent
   *  however good the destination is. */
  hasNumber: boolean;
}) {
  const server = {
    orderDelivery,
    orderSmsTo: orderSmsTo ?? "",
    orderEmailTo: orderEmailTo ?? "",
  };
  const [form, patch, dirty, replaced] = useSeeded("orders", server);
  const { pending, result, run } = useSection();

  return (
    <SectionCard
      id="orders"
      title="Where orders go"
      lede="Every order the assistant takes is texted to the kitchen the moment it is placed."
      flags={flagsFor(dirty, false)}
    >
      {/* The account of a re-seed that landed on typing, first child
          of the card and above the fields it happened to. */}
      <ReplacedNote when={replaced} />
      <Reach kind="live">
        Read at the moment an order is placed. Saved here, live on the next call, with nothing to
        rebuild.
      </Reach>

      <div className="setup-form">
        <div className="field">
          <span className="field-label">Send tickets by</span>
          <div className="seg">
            {(
              [
                ["sms", "Text"],
                ["email", "Email"],
                ["both", "Both"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="seg-opt">
                <input
                  type="radio"
                  name="ed-order-delivery"
                  value={value}
                  checked={form.orderDelivery === value}
                  disabled={pending}
                  onChange={() => patch({ orderDelivery: value })}
                />
                {label}
              </label>
            ))}
          </div>
          <p className="text-muted setup-note">
            Kept on file, and only the text is actually sent today — there is no email sender in
            this product yet, and nothing reads this choice. Picking Email does not stop the text
            going out and does not start an email.
          </p>
        </div>

        <div className="field">
          <label htmlFor="ed-sms-to">Text tickets to</label>
          <input
            id="ed-sms-to"
            className="input"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="(510) 555-0134"
            value={form.orderSmsTo}
            disabled={pending}
            aria-describedby="ed-orders-error"
            onChange={(e) => patch({ orderSmsTo: e.target.value })}
          />
          <p className="text-muted setup-note">
            The one destination that is really used. Left blank, an order is taken and no ticket
            reaches the kitchen — nothing anywhere reports it except the assistant ending the call
            with &ldquo;let me have someone confirm that&rdquo; instead of goodbye.{" "}
            {phonePreview(form.orderSmsTo, "No kitchen number on file, so no ticket is sent.")}
          </p>
          {hasNumber ? null : (
            <p className="text-muted setup-note">
              This restaurant has no number of its own yet, and the ticket is sent from it. Until
              the go-live panel provisions one, nothing can be sent here.
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="ed-email-to">Email tickets to</label>
          <input
            id="ed-email-to"
            className="input"
            type="email"
            autoComplete="off"
            maxLength={200}
            placeholder="kitchen@therestaurant.com"
            value={form.orderEmailTo}
            disabled={pending}
            aria-describedby="ed-orders-error"
            onChange={(e) => patch({ orderEmailTo: e.target.value })}
          />
          <p className="text-muted setup-note">
            Stored, and read by nothing. No ticket is emailed today.
          </p>
        </div>
      </div>

      <SaveRow
        statusId="ed-orders-status"
        pending={pending}
        dirty={dirty}
        blocked={false}
        rebuilds={false}
        result={result}
        onSave={() =>
          run(() =>
            saveOrderRoutingAction(
              locationId,
              {
                orderDelivery: form.orderDelivery,
                orderSmsTo: form.orderSmsTo,
                orderEmailTo: form.orderEmailTo,
              },
              updatedAt,
            ),
          )
        }
      />

      <Refusal id="ed-orders-error" result={result} pending={pending} />
    </SectionCard>
  );
}

/* ══ 5. recording & retention ══════════════════════════════════════ */

export function RecordingSection({
  locationId,
  recordingEnabled,
  recordingRetentionDays,
  updatedAt,
}: {
  locationId: string;
  recordingEnabled: boolean;
  recordingRetentionDays: number;
  /** locations.updated_at as this page was rendered from. The save is
   *  conditional on it server-side, so a stale tab refuses rather than
   *  putting another operator's change back. */
  updatedAt: string;
}) {
  const server = {
    recordingEnabled,
    recordingRetentionDays: String(recordingRetentionDays),
  };
  const [form, patch, dirty, replaced] = useSeeded("recording", server);
  const { pending, result, run } = useSection();

  return (
    <SectionCard
      id="recording"
      title="Recording & retention"
      lede="Recording is announced to the caller when it is on."
      flags={flagsFor(dirty, false)}
    >
      {/* The account of a re-seed that landed on typing, first child
          of the card and above the fields it happened to. */}
      <ReplacedNote when={replaced} />
      <Reach kind="live">
        This applies to the forwarded line — the path where a caller is put straight through to a
        person. It changes nothing about the assistant&rsquo;s own calls, which carry no recording
        setting at all.
      </Reach>

      <div className="setup-form">
        <div className="field">
          <span className="field-label">Record calls</span>
          <div className="seg">
            {(
              [
                [true, "On"],
                [false, "Off"],
              ] as const
            ).map(([value, label]) => (
              <label key={label} className="seg-opt">
                <input
                  type="radio"
                  name="ed-recording"
                  value={label}
                  checked={form.recordingEnabled === value}
                  disabled={pending}
                  onChange={() => patch({ recordingEnabled: value })}
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="ed-retention">Keep recordings for (days)</label>
          <input
            id="ed-retention"
            className="input"
            type="number"
            min={1}
            max={365}
            value={form.recordingRetentionDays}
            disabled={pending}
            aria-describedby="ed-recording-error"
            onChange={(e) => patch({ recordingRetentionDays: e.target.value })}
          />
          <p className="text-muted setup-note">
            Saved as stated, and nothing enforces it yet — there is no purge job in this product,
            so a recording is not deleted on this schedule. Do not repeat this number to a customer
            as a promise the system keeps.
          </p>
        </div>
      </div>

      <SaveRow
        statusId="ed-recording-status"
        pending={pending}
        dirty={dirty}
        blocked={false}
        rebuilds={false}
        result={result}
        onSave={() =>
          run(() =>
            saveRecordingAction(
              locationId,
              {
                recordingEnabled: form.recordingEnabled,
                recordingRetentionDays: form.recordingRetentionDays,
              },
              updatedAt,
            ),
          )
        }
      />

      <Refusal id="ed-recording-error" result={result} pending={pending} />
    </SectionCard>
  );
}
