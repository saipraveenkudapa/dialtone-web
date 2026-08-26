import Link from "next/link";
import { Corners } from "@/components/Corners";
import { RecordingSection } from "@/components/admin/EditSections";
import { OUTCOME_TAG, dateTimeIn, money } from "@/lib/format";
import type { CallRow } from "@/lib/supabase/types";

/* The setting, then the log it governs.
 *
 * WHY THESE TWO ARE ONE TAB. They were on two routes: the recording
 * switch was a card on /edit and the last twenty calls were a panel on
 * /admin/<id>. "Why can't I hear that call" is ONE ticket, and its two
 * halves cannot be read together from either screen -- an operator with
 * a restaurant owner on the line had to leave the log to find out
 * whether recording was even on, and leave the setting to find the call.
 *
 * So the setting leads and the log follows. Reading down: this is
 * whether we keep recordings and for how long, and these are the calls
 * it applied to.
 *
 * A server component. Nothing here is interactive except
 * <RecordingSection>, which brings its own "use client", and the rows,
 * which are links.
 */
export function CallsTab({
  locationId,
  timezone,
  calls,
  recordingEnabled,
  recordingRetentionDays,
  updatedAt,
  noCallsYet,
}: {
  locationId: string;
  timezone: string;
  calls: CallRow[];
  recordingEnabled: boolean;
  recordingRetentionDays: number;
  /** locations.updated_at as this page was rendered from. The save is
   *  conditional on it server-side, so a stale tab refuses rather than
   *  putting another operator's change back. */
  updatedAt: string;
  /** Which of the three empty-log sentences applies. Decided by the
   *  page, off the same row the go-live panel reads, so the log and the
   *  panel never disagree about whether this restaurant answers. */
  noCallsYet: string;
}) {
  return (
    <>
      <RecordingSection
        locationId={locationId}
        recordingEnabled={recordingEnabled}
        recordingRetentionDays={recordingRetentionDays}
        updatedAt={updatedAt}
      />

      <section id="calls" className="card blueprint setup-card">
        <Corners />
        <h2>Recent calls</h2>
        <p className="text-muted sub">
          The last twenty, newest first, in this restaurant&rsquo;s own clock.
        </p>

        {calls.length === 0 ? (
          <p className="text-muted empty-note">{noCallsYet}</p>
        ) : (
          /* SIX COLUMNS THAT DO NOT FIT A PHONE, AND THE WHOLE INSTANT
             BELOW IS WHY THEY STOPPED TRYING.

             Measured at 375px with (pointer: coarse), which is the iPad
             this console has already been reported from: the When column
             resolved to 47.9px inside a 300px .table-scroll and "Aug 15,
             2026, 10:08 PM" broke at every space into five lines. The
             row went from 58.6px to 123.1px and the five-row body from
             293px to 615.4px; this log holds twenty, so a phone paid
             ~2460px of scrolling for what used to be ~1170px. And 105px
             of the 405px table -- the Cost column and the entire Open
             button -- was already off the right edge behind an overflow
             scrollbar that iOS does not paint until something is
             already moving.

             Every way of making the string fit that column was measured
             and every one of them widened the table instead (the
             numbers are at .stack-table in app/app.css). So below 700px
             this table STACKS, exactly as the Accounts table on /admin
             does: one call per block, the instant and the caller on the
             first line, the three figures two-up under them each
             wearing the name of its own column, and the way in to the
             call at the end. Nothing hidden, nothing sideways, and the
             whole instant on one line.

             THE ARIA ROLES ARE LOAD-BEARING AND NOT DECORATION.
             Stacking is `display: block` on <table>, <tbody>, <tr> and
             <td>, and changing the display of a table element strips
             its implicit role in every current browser -- the whole
             thing flattens to anonymous boxes and a screen reader loses
             where one call ends and the next begins. Naming the roles
             explicitly is what survives the display change. They are
             redundant at desktop, which is the point: CSS cannot add
             them at the width where they start mattering. */
          <div className="table-scroll">
            <table className="table stack-table" role="table">
              <thead role="rowgroup">
                <tr role="row">
                  {/* "When", not "Time": the cell carries a whole
                      instant now and not a clock reading. */}
                  <th role="columnheader">When</th>
                  <th role="columnheader">Caller</th>
                  <th role="columnheader">Outcome</th>
                  <th role="columnheader">Length</th>
                  <th role="columnheader">Cost</th>
                  {/* Deliberately unnamed: the button in this column
                      labels its own row, so there is no column name to
                      print. At stacked width the whole <thead> is
                      `display: none` and the cell carries .stack-action
                      instead of a .cell-label. */}
                  <th />
                </tr>
              </thead>
              <tbody role="rowgroup">
                {calls.map((c) => (
                  <tr key={c.id} role="row">
                    {/* THE WHOLE INSTANT, not the clock time.
                        This column read "11:09 AM" for every row, so a
                        call from three days ago was indistinguishable
                        from one from this morning -- one panel away from
                        a dashboard saying "0 answered today", and one
                        press from the call's own page, which has always
                        said the date in its sub-line. The log and the
                        page it opens now print the same string.

                        Absolute, and never "today"/"yesterday": see
                        dateTimeIn. This table is server-rendered per
                        request, and a relative word would be true at
                        first paint and false on the same tab after
                        midnight -- an operator console is exactly the
                        screen people leave open. */}
                    <td role="cell" className="num">
                      {dateTimeIn(timezone, c.started_at)}
                    </td>
                    <td role="cell">
                      <div>{c.from_number ?? "Unknown"}</div>
                      <div className="caller-city">
                        {[c.from_city, c.from_state].filter(Boolean).join(", ")}
                      </div>
                    </td>
                    {/* The three cells below each carry the name of
                        their own column, hidden at desktop where the
                        <th> above says it and shown at stacked width
                        where there is no <th> at all. Same strings as
                        the headers, because they are the same words --
                        see <Figure> on /admin, which is the same idea
                        with a closed union behind it. */}
                    <td role="cell">
                      <span className="cell-label">Outcome</span>
                      {c.outcome ? (
                        <span className={OUTCOME_TAG[c.outcome]}>{c.outcome}</span>
                      ) : (
                        <span className="tag tag-neutral">{c.status}</span>
                      )}
                    </td>
                    <td role="cell" className="num">
                      <span className="cell-label">Length</span>
                      <span>
                        {c.duration_seconds
                          ? `${Math.floor(c.duration_seconds / 60)}:${String(
                              c.duration_seconds % 60,
                            ).padStart(2, "0")}`
                          : "—"}
                      </span>
                    </td>
                    <td role="cell" className="num">
                      <span className="cell-label">Cost</span>
                      <span>{money(c.telephony_cost_cents + c.llm_cost_cents)}</span>
                    </td>
                    {/* The way in to the call, and a real route -- the
                        recording and the transcript are on a page of
                        their own and are not a panel of this one.

                        A .btn, not a bare anchor. The affordance has to
                        be a RESTING one: this console has already been
                        reported from an iPad, where :hover never fires,
                        and .row-link resting is 13px of accent text with
                        no rule and no box -- colour alone, which is
                        exactly the "untappable" report. .btn-secondary
                        carries a border at rest, so the row shows where
                        to press before anything is touched, and the
                        system supplies its hover, active and focus
                        states.

                        Its own cell, so the table keeps its semantics:
                        five columns of call, one of action. The label
                        repeats down the column, so each one names its
                        own row for a screen reader rather than being the
                        twentieth identical "Open". */}
                    <td role="cell" className="stack-action">
                      <Link
                        href={`/admin/${locationId}/calls/${c.id}`}
                        className="btn btn-secondary"
                        /* The same instant the cell shows. A screen
                           reader hearing "Open the 11:09 AM call" for a
                           three-day-old row is the identical defect --
                           the accessible name carries whatever the
                           visible text carries, or the fix only landed
                           for people who can see it. */
                        aria-label={`Open the ${dateTimeIn(timezone, c.started_at)} call from ${
                          c.from_number ?? "an unknown caller"
                        }`}
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
