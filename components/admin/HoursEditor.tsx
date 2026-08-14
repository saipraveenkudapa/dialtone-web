"use client";

import { useEffect, useState, useTransition } from "react";
import { Corners } from "@/components/Corners";
import { WEEKDAYS } from "@/lib/provisioning/constants";
import type { DraftHours } from "@/lib/provisioning/draft";
import type {
  EditResult,
  EditableHoliday,
  EditableHoursRow,
  HolidayInput,
  PhoneSync,
} from "@/lib/admin/edit";

/* The weekly hours and the one-off closures, from the operator console.
 *
 * WHY THIS SCREEN GETS TO MAKE A PROMISE THE REST OF THE EDITOR CANNOT
 * -------------------------------------------------------------------
 * app/api/agent/hours/route.ts queries Postgres on every call, and reads
 * holiday_hours in the same round trip. The assistant's own prompt
 * carries a frozen "Hours today" line, but the prompt orders the model
 * to call get_hours before it answers -- which is why lib/admin/edit.ts
 * deliberately returns phone: "not-needed" from saveHours rather than
 * rebuilding the assistant to refresh a line nobody is allowed to trust.
 *
 * So an hours edit is live on the next call, with nothing to push and
 * nothing that can half-fail. That is the product's central promise and
 * the operator has to be able to say it down the phone while the owner
 * is still on the line -- so it is written on the card, not implied by
 * the absence of a warning.
 *
 * THE TWO WAYS A WELL-MEANT ROW BECOMES "OPEN AROUND THE CLOCK"
 * ------------------------------------------------------------
 * Neither is caught by the database, and neither reports an error
 * anywhere -- they are the reason this file validates before it saves
 * rather than letting Postgres answer:
 *
 *   1. close <= open. lib/agent/hours.ts's openAt returns
 *      {state:"unknown", reason:"crosses_midnight"}, and every agent
 *      route lets `unknown` through as OPEN. A 22:00-02:00 Friday is a
 *      restaurant taking orders at three in the morning.
 *   2. A holiday marked open with no times. openAt returns
 *      unknown/no_hours_configured, which is treated as open as well --
 *      so "we close early on Christmas Eve", entered wrong, becomes
 *      "open twenty-four hours on Christmas Eve".
 *
 * A MISSING WEEKDAY IS NOT A GAP, IT IS A CLOSED DAY. hoursOnDate
 * defaults to is_closed: true, so a restaurant with no Tuesday row is
 * told to callers as shut all Tuesday. The form therefore always shows
 * seven days and always writes seven, and says so when the record is
 * short of a row.
 *
 * NOTHING HERE IS A PERMISSION. Every action prop re-checks
 * currentPlatformAdmin() itself, and lib/admin/edit.ts checks it again
 * before it touches the service-role key. A disabled Save is ergonomics.
 */

/** Everything this component needs, and nothing that decides whose data
 *  is touched beyond the location id itself. The action props are the
 *  server actions from the /edit route; each one gates and re-validates
 *  on its own, and each row id below is a selector the server proves
 *  belongs to this location before it writes. */
export type HoursEditorProps = {
  locationId: string;
  /** locations.timezone. These times are the restaurant's own clock --
   *  `hours.open_time` is a bare `time`, read in this zone per call. */
  timezone: string;
  /** The rows on file. Fewer than seven is a real state, not an error. */
  hours: EditableHoursRow[];
  holidays: EditableHoliday[];
  saveHoursAction: (
    locationId: string,
    input: DraftHours[],
    /** hoursSignature() of the week this grid was seeded from. */
    seenSignature: string,
  ) => Promise<EditResult>;
  saveHolidayAction: (
    locationId: string,
    /** null adds a date; a value edits that row. */
    holidayId: string | null,
    input: HolidayInput,
  ) => Promise<EditResult>;
  deleteHolidayAction: (locationId: string, holidayId: string) => Promise<EditResult>;
};

const DEFAULT_OPEN = "09:00";
const DEFAULT_CLOSE = "21:00";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A server action that never came back. Uncaught, the rejection is
 *  re-thrown during render and takes the whole page to the error
 *  boundary, which loses the operator's typing as well as the write --
 *  the same catch, and the same sentence, as components/admin/GoLive.tsx. */
const DROPPED: EditResult = {
  ok: false,
  error:
    "That did not come back — the connection dropped, or the request ran too long. Nothing " +
    "here knows whether it landed. Reload the page to see where this restaurant stands.",
};

/** `ok: true` means the database was written and nothing more:
 *  lib/admin/edit.ts is explicit that `phone` is the only authority on
 *  whether the assistant agrees, and that a caller which renders the
 *  message and drops the field is rendering a half-truth.
 *
 *  Nothing on this screen edits a column that is baked into the
 *  assistant, so every result here should arrive "not-needed". Reporting
 *  the others anyway is what keeps that from quietly stopping being
 *  true. */
function phoneNote(phone: PhoneSync): string | null {
  switch (phone.state) {
    case "not-needed":
      return null;
    case "updated":
      return "The assistant was rebuilt as well.";
    case "no-assistant":
      return "There is no assistant on this restaurant yet.";
    case "failed":
      return (
        `The assistant could not be rebuilt: ${phone.reason} ` +
        "The phone is still on the old value."
      );
    case "secret-lost":
      return `${phone.reason} Repair the assistant on the go-live panel now.`;
  }
}

/** One write in flight, and the sentence it came back with. Each row and
 *  each form keeps its own, so a failed holiday never wears the weekly
 *  grid's message and the rest of the screen stays usable while one of
 *  them is saving. */
function useWrite() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<EditResult | null>(null);

  function run(act: () => Promise<EditResult>, onSaved?: () => void) {
    setResult(null);
    startTransition(async () => {
      try {
        const answer = await act();
        setResult(answer);
        if (answer.ok) onSaved?.();
      } catch {
        setResult(DROPPED);
      }
    });
  }

  return { pending, result, setResult, run };
}

/** The account of one write, in the two voices this product already
 *  uses: a refusal on .setup-error, everything else on .edit-status --
 *  the same split components/admin/EditSections.tsx makes, so a save on
 *  this card and a save on the one above it read as one screen.
 *
 *  The button that started the write never changes its label, which is
 *  why "Saving…" lives here. A control that resizes under the cursor
 *  mid-press is a control an operator stops trusting. */
function WriteResult({
  pending,
  result,
  dirty = false,
}: {
  pending: boolean;
  result: EditResult | null;
  /** Renders "Not saved yet." so a typed-in change is never mistaken for
   *  a saved one. */
  dirty?: boolean;
}) {
  if (!pending && result && !result.ok) return <p className="setup-error">{result.error}</p>;

  const phone = !pending && result?.ok ? phoneNote(result.phone) : null;
  const status = pending
    ? "Saving…"
    : result?.ok
      ? `${result.message}${phone ? ` ${phone}` : ""}`
      : dirty
        ? "Not saved yet."
        : "";

  return (
    <p className="edit-status" role="status" aria-live="polite">
      {status}
    </p>
  );
}

/** Postgres hands a `time` column back as "09:00:00". Both
 *  <input type="time"> and lib/admin/edit.ts's validator want "HH:MM" --
 *  the seconds would be refused as "set both an open and a close time",
 *  which is a sentence about a field the operator never touched. */
function hhmm(value: string | null, fallback: string): string {
  return value ? value.slice(0, 5) : fallback;
}

/** The seven days as one comparable string.
 *
 *  A verbatim copy of lib/admin/edit.ts's hoursSignature, duplicated for
 *  the reason sameName is duplicated in components/admin/MenuAdmin.tsx:
 *  that module is server-only and importing a value from it would drag
 *  the service-role client into the browser bundle. edit.ts's copy is
 *  the authority -- it recomputes this from the rows actually on file
 *  and refuses the write when the two disagree. If either changes, both
 *  must.
 *
 *  What it is for: `hours` carries no timestamp, and this grid writes
 *  all seven rows in one upsert. Sent with the save, it is what stops a
 *  tab that was opened before somebody else changed Tuesday from putting
 *  the old Tuesday back -- live on the next call, because the agent
 *  reads the hours per call. */
function hoursSignature(rows: EditableHoursRow[]): string {
  const cut = (value: string | null) => (value ? value.slice(0, 5) : "");
  return [0, 1, 2, 3, 4, 5, 6]
    .map((day) => {
      const row = rows.find((r) => r.day_of_week === day);
      if (!row) return `${day}:none`;
      return row.is_closed
        ? `${day}:closed`
        : `${day}:${cut(row.open_time)}-${cut(row.close_time)}`;
    })
    .join("|");
}

type DayState = { closed: boolean; open: string; close: string };

function seedDays(rows: EditableHoursRow[]): DayState[] {
  return WEEKDAYS.map((_, day) => {
    const row = rows.find((r) => r.day_of_week === day);
    // No row is not "no opinion": the agent reads a missing day as shut.
    // Seeded closed, with usable times behind the checkbox so that
    // un-closing a day does not also mean typing two times.
    if (!row) return { closed: true, open: DEFAULT_OPEN, close: DEFAULT_CLOSE };
    return {
      closed: row.is_closed,
      open: hhmm(row.open_time, DEFAULT_OPEN),
      close: hhmm(row.close_time, DEFAULT_CLOSE),
    };
  });
}

/** The first thing wrong with the week, in lib/admin/edit.ts's own
 *  words -- copied verbatim so an operator reads the same sentence
 *  whether it is caught here or on the server. The server remains the
 *  authority; this only saves the round trip. */
function hoursProblem(days: DayState[]): string | null {
  for (let day = 0; day < 7; day++) {
    const value = days[day];
    if (value.closed) continue;
    if (!TIME.test(value.open) || !TIME.test(value.close)) {
      return `Set both an open and a close time for ${WEEKDAYS[day]}, or mark it closed.`;
    }
    if (value.close <= value.open) {
      return (
        `${WEEKDAYS[day]}'s close time must be after its open time. Hours that cross midnight ` +
        "are not supported yet -- use the latest closing time this system can represent for now."
      );
    }
  }
  return null;
}

function holidayProblem(closed: boolean, open: string, close: string): string | null {
  if (closed) return null;
  if (!TIME.test(open) || !TIME.test(close)) {
    return (
      "Set both an open and a close time for that date, or mark it closed. A date with neither " +
      "reads as open all day, not as closed."
    );
  }
  if (close <= open) {
    return (
      "That date's close time must be after its open time. Hours that cross midnight are not " +
      "supported yet -- use the latest closing time this system can represent for now."
    );
  }
  return null;
}

export function HoursEditor({
  locationId,
  timezone,
  hours,
  holidays,
  saveHoursAction,
  saveHolidayAction,
  deleteHolidayAction,
}: HoursEditorProps) {
  return (
    <>
      <WeeklyHours
        locationId={locationId}
        timezone={timezone}
        hours={hours}
        saveHoursAction={saveHoursAction}
      />
      <Holidays
        locationId={locationId}
        timezone={timezone}
        holidays={holidays}
        saveHolidayAction={saveHolidayAction}
        deleteHolidayAction={deleteHolidayAction}
      />
    </>
  );
}

/* ── the seven days ────────────────────────────────────────────────── */

function WeeklyHours({
  locationId,
  timezone,
  hours,
  saveHoursAction,
}: {
  locationId: string;
  timezone: string;
  hours: EditableHoursRow[];
  saveHoursAction: HoursEditorProps["saveHoursAction"];
}) {
  const { pending, result, run } = useWrite();

  const [days, setDays] = useState<DayState[]>(() => seedDays(hours));

  /* Take a fresh server value during render rather than in an effect, so
     the grid never sits there showing an edit the database has already
     replaced. Same pattern as GoLive.tsx's seenFallback -- but compared
     BY VALUE, which that one gets for free by holding a string and this
     one does not.

     `hours` is an array, and every action on this route revalidates this
     path, so every save anywhere on the page -- a dish flipped to sold
     out, a holiday removed -- hands this component a freshly
     deserialised array with identical contents and a new identity.
     Comparing the prop by identity therefore re-seeded the grid on every
     one of those, silently throwing away a week the operator had typed
     but not yet saved, with the Unsaved tag and the beforeunload guard
     disappearing along with it.
     The signature is the same value the save sends, so there is exactly
     one definition of "the week moved" on this screen. */
  const signature = hoursSignature(hours);
  const [seenSignature, setSeenSignature] = useState(signature);
  if (seenSignature !== signature) {
    setSeenSignature(signature);
    setDays(seedDays(hours));
  }

  const onFile = seedDays(hours);
  const dirty = days.some(
    (day, i) =>
      day.closed !== onFile[i].closed ||
      (!day.closed && (day.open !== onFile[i].open || day.close !== onFile[i].close)),
  );
  const problem = hoursProblem(days);

  const missing = WEEKDAYS.map((_, day) => day).filter(
    (day) => !hours.some((row) => row.day_of_week === day),
  );

  // Closing the tab throws the week away. Say so before it happens
  // rather than after -- the same guard MenuImportReview puts on its
  // unsaved draft.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function setDay(day: number, patch: Partial<DayState>) {
    setDays((prev) => prev.map((value, i) => (i === day ? { ...value, ...patch } : value)));
  }

  function save() {
    const input: DraftHours[] = days.map((day, i) => ({
      dayOfWeek: i,
      closed: day.closed,
      open: day.open,
      close: day.close,
    }));
    run(() => saveHoursAction(locationId, input, signature));
  }

  return (
    <section id="hours" className="card blueprint setup-card">
      <Corners />
      <h2>
        Hours{" "}
        {dirty ? <span className="tag tag-neutral edit-flag">Unsaved</span> : null}
      </h2>
      <p className="text-muted sub">
        The assistant checks these before it books a table or promises when an order will be
        ready.
      </p>

      {/* No chip. .tag.tag-outline is this feature's REBUILD mark -- it
          is the flag on every baked field label and it opens all three
          "this also rebuilds the assistant" notes -- and wearing it here
          to assert the opposite is what makes an operator push a rebuild
          they did not need or skip one they did. The live notes in
          components/admin/EditSections.tsx carry none; these match them. */}
      <p className="edit-note is-live">
        The assistant looks the hours up in the database every time a caller asks, so there is
        nothing to re-push to the phone. The moment this says Saved you can tell the restaurant
        the new hours are in effect.
      </p>

      <div className="hours-grid">
        {WEEKDAYS.map((label, day) => (
          <div key={label} className="hours-row">
            <span className="hours-day">{label}</span>
            <div className="hours-times">
              <label className="hours-closed">
                <input
                  type="checkbox"
                  checked={days[day].closed}
                  disabled={pending}
                  onChange={(e) => setDay(day, { closed: e.target.checked })}
                />
                Closed
              </label>
              <input
                className="input"
                type="time"
                aria-label={`${label} opens`}
                value={days[day].open}
                disabled={pending || days[day].closed}
                onChange={(e) => setDay(day, { open: e.target.value })}
              />
              <span className="text-muted">to</span>
              <input
                className="input"
                type="time"
                aria-label={`${label} closes`}
                value={days[day].close}
                disabled={pending || days[day].closed}
                onChange={(e) => setDay(day, { close: e.target.value })}
              />
            </div>
          </div>
        ))}
      </div>

      <p className="text-muted setup-note">
        These are the restaurant&rsquo;s own clock, in {timezone}. All seven days are written
        together, so a day that has never been set gets written too.
      </p>

      {/* Plain, and .tag-neutral. .edit-note.is-drift and .tag-out are
          the "the screen and the phone disagree" vocabulary -- the one
          state on this page that is actively wrong -- and this card has
          just said there is nothing on the phone that can disagree. A
          weekday with no row is a completeness fact that saving fixes,
          live on the next call, so spending the alarm colour on it here
          devalues it everywhere it is used correctly. */}
      {missing.length > 0 ? (
        <p className="edit-note">
          <span className="tag tag-neutral">Not on file</span>
          There is no row for {missing.map((day) => WEEKDAYS[day]).join(", ")}. A day with no row
          is read as closed all day, whatever is shown above. Saving writes it.
        </p>
      ) : null}

      {/* Status first, then the button -- the order
          components/admin/EditSections.tsx uses, so the line reads as
          that button's own sentence rather than as a caption pinned to
          the far edge of the row. */}
      <div className="setup-actions">
        <WriteResult pending={pending} result={result} dirty={dirty} />
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending || !dirty || problem !== null}
          onClick={save}
        >
          Save
        </button>
      </div>

      {problem ? <p className="setup-error">{problem}</p> : null}
    </section>
  );
}

/* ── the one-off dates ─────────────────────────────────────────────── */

function Holidays({
  locationId,
  timezone,
  holidays,
  saveHolidayAction,
  deleteHolidayAction,
}: {
  locationId: string;
  timezone: string;
  holidays: EditableHoliday[];
  saveHolidayAction: HoursEditorProps["saveHolidayAction"];
  deleteHolidayAction: HoursEditorProps["deleteHolidayAction"];
}) {
  // There is deliberately no "this one is in the past" mark. It would
  // have to be computed from the browser's clock in the restaurant's
  // zone, which is a different answer on the server render and the
  // hydrating one whenever a page load straddles the restaurant's
  // midnight -- a hydration mismatch bought with a decoration. The date
  // is in the field, in the restaurant's own calendar, which is the
  // fact that matters.
  return (
    <section id="holidays" className="card blueprint setup-card">
      <Corners />
      <h2>Holidays and one-off closures</h2>
      <p className="text-muted sub">
        A date that overrides the weekly hours — Thanksgiving, a private party, the week the
        kitchen is being refitted.
      </p>

      <p className="edit-note is-live">
        Read from the database with the hours, on every call. Nothing to re-push, and nothing on
        the phone that can be left on the old answer.
      </p>

      {holidays.length === 0 ? (
        <p className="text-muted empty-note">
          No dates on file. Every day follows the weekly hours above.
        </p>
      ) : (
        holidays.map((holiday) => (
          <HolidayRow
            key={holiday.id}
            locationId={locationId}
            holiday={holiday}
            saveHolidayAction={saveHolidayAction}
            deleteHolidayAction={deleteHolidayAction}
          />
        ))
      )}

      <AddHoliday locationId={locationId} saveHolidayAction={saveHolidayAction} />

      <p className="text-muted setup-note">
        One entry per date, in the restaurant&rsquo;s own calendar ({timezone}). A date marked
        open needs both times: a date with neither is read as open all day, not as closed.
      </p>
    </section>
  );
}

function HolidayRow({
  locationId,
  holiday,
  saveHolidayAction,
  deleteHolidayAction,
}: {
  locationId: string;
  holiday: EditableHoliday;
  saveHolidayAction: HoursEditorProps["saveHolidayAction"];
  deleteHolidayAction: HoursEditorProps["deleteHolidayAction"];
}) {
  const { pending, result, run } = useWrite();

  const seed = {
    date: holiday.date,
    closed: holiday.is_closed,
    open: hhmm(holiday.open_time, DEFAULT_OPEN),
    close: hhmm(holiday.close_time, DEFAULT_CLOSE),
  };

  const [date, setDate] = useState(seed.date);
  const [closed, setClosed] = useState(seed.closed);
  const [open, setOpen] = useState(seed.open);
  const [close, setClose] = useState(seed.close);

  // By VALUE, not by identity. revalidatePath hands every row a new
  // object on every save anywhere on this page, so `seen !== holiday`
  // re-seeded this row -- and threw away a date the operator had typed
  // -- because somebody flipped a dish to sold out three cards down.
  const seed4 = `${seed.date}|${seed.closed}|${seed.open}|${seed.close}`;
  const [seen, setSeen] = useState(seed4);
  if (seen !== seed4) {
    setSeen(seed4);
    setDate(holiday.date);
    setClosed(holiday.is_closed);
    setOpen(hhmm(holiday.open_time, DEFAULT_OPEN));
    setClose(hhmm(holiday.close_time, DEFAULT_CLOSE));
    // The message from the write that CAUSED this re-seed is deliberately
    // left standing: revalidatePath lands these props in the same commit
    // as the result, so clearing here would wipe "Saved." the instant it
    // was earned.
  }

  const dirty =
    date !== seed.date ||
    closed !== seed.closed ||
    (!closed && (open !== seed.open || close !== seed.close));
  const problem = date.trim() === "" ? "Enter the date." : holidayProblem(closed, open, close);

  return (
    <>
      <div className="hours-row holiday-row">
        {/* A direct child of .holiday-row, which is where app.css gives a
            date input its fixed 160px -- inside .hours-times it would
            take that block's 130px cap instead and clip the picker. */}
        <input
          className="input"
          type="date"
          aria-label="Date"
          value={date}
          disabled={pending}
          onChange={(e) => setDate(e.target.value)}
        />
        <div className="hours-times">
          <label className="hours-closed">
            <input
              type="checkbox"
              checked={closed}
              disabled={pending}
              onChange={(e) => setClosed(e.target.checked)}
            />
            Closed all day
          </label>
          <input
            className="input"
            type="time"
            aria-label={`${date} opens`}
            value={open}
            disabled={pending || closed}
            onChange={(e) => setOpen(e.target.value)}
          />
          <span className="text-muted">to</span>
          <input
            className="input"
            type="time"
            aria-label={`${date} closes`}
            value={close}
            disabled={pending || closed}
            onChange={(e) => setClose(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending || !dirty || problem !== null}
          onClick={() =>
            run(() => saveHolidayAction(locationId, holiday.id, { date, closed, open, close }))
          }
        >
          Save
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={pending}
          onClick={() => run(() => deleteHolidayAction(locationId, holiday.id))}
        >
          Remove
        </button>
      </div>
      {dirty && problem ? <p className="setup-error">{problem}</p> : null}
      <WriteResult pending={pending} result={result} dirty={dirty} />
    </>
  );
}

function AddHoliday({
  locationId,
  saveHolidayAction,
}: {
  locationId: string;
  saveHolidayAction: HoursEditorProps["saveHolidayAction"];
}) {
  const { pending, result, run } = useWrite();

  const [date, setDate] = useState("");
  const [closed, setClosed] = useState(true);
  const [open, setOpen] = useState(DEFAULT_OPEN);
  const [close, setClose] = useState(DEFAULT_CLOSE);

  const problem = date.trim() === "" ? null : holidayProblem(closed, open, close);

  function add() {
    run(
      () => saveHolidayAction(locationId, null, { date, closed, open, close }),
      () => {
        setDate("");
        setClosed(true);
        setOpen(DEFAULT_OPEN);
        setClose(DEFAULT_CLOSE);
      },
    );
  }

  return (
    <>
      <div className="hours-row holiday-row">
        <input
          className="input"
          type="date"
          aria-label="New date"
          value={date}
          disabled={pending}
          onChange={(e) => setDate(e.target.value)}
        />
        <div className="hours-times">
          <label className="hours-closed">
            <input
              type="checkbox"
              checked={closed}
              disabled={pending}
              onChange={(e) => setClosed(e.target.checked)}
            />
            Closed all day
          </label>
          <input
            className="input"
            type="time"
            aria-label="New date opens"
            value={open}
            disabled={pending || closed}
            onChange={(e) => setOpen(e.target.value)}
          />
          <span className="text-muted">to</span>
          <input
            className="input"
            type="time"
            aria-label="New date closes"
            value={close}
            disabled={pending || closed}
            onChange={(e) => setClose(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending || date.trim() === "" || problem !== null}
          onClick={add}
        >
          Add date
        </button>
      </div>
      {problem ? <p className="setup-error">{problem}</p> : null}
      <WriteResult pending={pending} result={result} />
    </>
  );
}
