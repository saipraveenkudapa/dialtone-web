import Link from "next/link";
import { Corners } from "@/components/Corners";
import { RecordingSection } from "@/components/admin/EditSections";
import { OUTCOME_TAG, money, timeIn } from "@/lib/format";
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
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Caller</th>
                  <th>Outcome</th>
                  <th>Length</th>
                  <th>Cost</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td className="num">{timeIn(timezone, c.started_at)}</td>
                    <td>
                      <div>{c.from_number ?? "Unknown"}</div>
                      <div className="caller-city">
                        {[c.from_city, c.from_state].filter(Boolean).join(", ")}
                      </div>
                    </td>
                    <td>
                      {c.outcome ? (
                        <span className={OUTCOME_TAG[c.outcome]}>{c.outcome}</span>
                      ) : (
                        <span className="tag tag-neutral">{c.status}</span>
                      )}
                    </td>
                    <td className="num">
                      {c.duration_seconds
                        ? `${Math.floor(c.duration_seconds / 60)}:${String(
                            c.duration_seconds % 60,
                          ).padStart(2, "0")}`
                        : "—"}
                    </td>
                    <td className="num">
                      {money(c.telephony_cost_cents + c.llm_cost_cents)}
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
                    <td>
                      <Link
                        href={`/admin/${locationId}/calls/${c.id}`}
                        className="btn btn-secondary"
                        aria-label={`Open the ${timeIn(timezone, c.started_at)} call from ${
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
