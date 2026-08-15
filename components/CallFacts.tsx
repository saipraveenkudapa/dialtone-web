import type { ReactNode } from "react";
import { Corners } from "@/components/Corners";
import { mmss, money, timeIn } from "@/lib/format";

/* The two fact cards both call screens draw, in one place.
 *
 * WHY THIS EXISTS. app/dashboard/calls/[id]/page.tsx (the owner's) and
 * app/admin/[locationId]/calls/[callId]/page.tsx (the operator's) are
 * deliberately the same screen read by two people -- an operator on the
 * phone to a restaurant has to be looking at what the restaurant is
 * looking at. They differ in the READ (RLS session vs service role
 * behind currentPlatformAdmin), in the signed URL, and in which side
 * panels they carry. They did not differ at all in the timeline or the
 * cost, and those were a verbatim copy: the same three-entry parse, the
 * same delta strings, the same eight-line costs array and the same two
 * .card.blueprint.admin-facts blocks, in both files.
 *
 * That copy was already costing. `llm_cost_cents` changed meaning in
 * this same pass -- it is now total-minus-telephony rather than
 * llm+stt+tts -- and the label "Agent" that is the only thing on screen
 * explaining it was written out twice, in two files, to be kept in step
 * by hand. This repo already carries one regretted fork (MenuAdmin
 * beside MenuEditor); the cheap moment to stop the second is at fifty
 * lines, not after the next change has to be made twice.
 *
 * Server components, no "use client": both are pure markup over props
 * their pages already hold, and neither has a single event handler.
 */

/** The three moments of a call the timeline names. */
type CallTimes = {
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
};

/** Rang / Answered / Ended, with the gap between each pair in words.
 *
 *  Only the moments that happened: a call nobody picked up has no
 *  Answered row, and one still up has no Ended row. */
function callTimeline(call: CallTimes): { what: string; at: string; delta: string | null }[] {
  const started = new Date(call.started_at).getTime();
  const answered = call.answered_at ? new Date(call.answered_at).getTime() : null;
  const ended = call.ended_at ? new Date(call.ended_at).getTime() : null;

  return [
    { what: "Rang", at: call.started_at, delta: null as string | null },
    call.answered_at
      ? {
          what: "Answered",
          at: call.answered_at,
          delta: `${Math.round((answered! - started) / 1000)}s ringing`,
        }
      : null,
    call.ended_at
      ? {
          what: "Ended",
          at: call.ended_at,
          delta: answered ? `${mmss((ended! - answered) / 1000)} talking` : "never answered",
        }
      : null,
  ].filter(Boolean) as { what: string; at: string; delta: string | null }[];
}

/** When the call rang, was picked up and ended, in the restaurant's own
 *  timezone -- timestamps are UTC in the database and nobody at a
 *  restaurant thinks in it.
 *
 *  `children` are extra <div class="fact-row"> rows appended inside the
 *  same <dl>. The owner's screen puts "Handed off" there; the
 *  operator's has its own facts card and passes nothing. */
export function CallTimelineCard({
  call,
  timezone,
  children,
}: {
  call: CallTimes;
  timezone: string;
  children?: ReactNode;
}) {
  return (
    <div className="card blueprint admin-facts">
      <Corners />
      <div className="card-kicker">Timeline · {timezone}</div>
      <dl>
        {callTimeline(call).map((t) => (
          <div key={t.what} className="fact-row">
            <dt className="text-muted">{t.what}</dt>
            <dd>
              <span className="num">{timeIn(timezone, t.at)}</span>
              {t.delta ? <span className="text-muted timeline-delta"> {t.delta}</span> : null}
            </dd>
          </div>
        ))}
        {children}
      </dl>
    </div>
  );
}

/** What this call cost, in the two integer-cent columns the row carries.
 *
 *  "Agent" is everything Vapi billed that is not carriage: the model
 *  pipeline plus every smaller bucket, derived as total-minus-telephony
 *  so nothing Vapi charges for drops out of the pair. See costsFrom in
 *  lib/vapi/server-message.ts for why it is a subtraction. */
export function CallCostCard({
  call,
}: {
  call: { telephony_cost_cents: number; llm_cost_cents: number };
}) {
  const costs = [
    { label: "Telephony", value: money(call.telephony_cost_cents) },
    { label: "Agent", value: money(call.llm_cost_cents) },
    { label: "Total", value: money(call.telephony_cost_cents + call.llm_cost_cents) },
  ];

  return (
    <div className="card blueprint admin-facts">
      <Corners />
      <div className="card-kicker">Cost</div>
      <dl>
        {costs.map((c) => (
          <div key={c.label} className="fact-row">
            <dt className="text-muted">{c.label}</dt>
            <dd className="num">{c.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
