import Link from "next/link";
import { notFound } from "next/navigation";
import { Corners } from "@/components/Corners";
import { CallPlayer } from "@/components/CallPlayer";
import { CallCostCard, CallTimelineCard } from "@/components/CallFacts";
import { getAdminCall } from "@/lib/admin/data";
import {
  OUTCOME_TAG,
  dateTimeIn,
  mmss,
  relative,
  transcriptNote,
  transcriptState,
} from "@/lib/format";

export const metadata = { title: "A call · Dialtone" };

/* The RFC shape, the same constant app/admin/[locationId]/page.tsx and
   lib/admin/edit.ts hold. Not /^[0-9a-f-]{36}$/i, which accepts
   thirty-six dashes and reaches PostgREST as a malformed uuid cast.
   getAdminCall re-checks both ids itself -- it holds the service-role
   key and does not get to trust its caller -- so this is the cheap
   refusal, not the only one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One call, for operator staff.
 *
 *  DELIBERATELY NOT A FORK of app/dashboard/calls/[id]/page.tsx. It
 *  wears the same player, the same transcript, the same tag vocabulary
 *  and the same timeline shape, because an operator on the phone to a
 *  restaurant has to be looking at the same call the restaurant is.
 *  Three things differ, and each one is a fact about who is reading:
 *
 *   1. The read. getAdminCall (lib/admin/data.ts) is service-role behind
 *      currentPlatformAdmin(), scoped to this location in the WHERE
 *      clause. The owner's getCall leans on RLS, which answers "no such
 *      call" for every restaurant an operator is not a member of -- which
 *      is all of them.
 *   2. The signed URL comes from the same gated read for the same reason:
 *      the `call-recordings` policy is org membership, and operator staff
 *      belong to no customer org. Same bucket, same 300 seconds, still
 *      private, still signed.
 *   3. No <CallNotes>. Notes are the restaurant's own working memory and
 *      saveCallNotes writes on the user's session, so the control would
 *      fail for an operator and, worse, would let one type into a
 *      customer's record from the console. The note is shown, read-only,
 *      because "what did the restaurant write about this call" is half
 *      of a support ticket.
 *
 *  The order, the booking and the message panels are the owner's screen
 *  and are not repeated here: an operator opens a call to hear what
 *  happened on the phone, and every one of those would be another query
 *  and another copy to keep in step.
 *
 *  AND WHAT IS SHARED IS SHARED IN CODE, not by two files agreeing. The
 *  claim above used to cover the read, the signed URL and the notes
 *  while the timeline and the cost card were a verbatim copy of the
 *  owner page's -- the same parse, the same delta strings, the same two
 *  .card.blueprint.admin-facts blocks, fifty-odd lines of it. They are
 *  now <CallTimelineCard> and <CallCostCard> in
 *  components/CallFacts.tsx, and the words for `transcript_status` are
 *  transcriptState/transcriptNote in lib/format.ts, so a change to any
 *  of them lands on both screens at once. */
export default async function AdminCallPage({
  params,
}: {
  params: Promise<{ locationId: string; callId: string }>;
}) {
  const { locationId, callId } = await params;
  if (!UUID.test(locationId) || !UUID.test(callId)) notFound();

  const data = await getAdminCall(locationId, callId);
  if (!data) notFound();

  const { location, call, recordingUrl } = data;
  const tz = location.timezone;
  const lines = call.transcript?.lines ?? [];

  /* Said in words rather than left to the player to imply. A restaurant
     with recording switched off still gets a transcript -- the webhook
     honours locations.recording_enabled for the audio only -- so "no
     recording" and "no transcript" are separate facts and an operator
     asked "why can't I hear it" needs the one that applies. */
  const recordingState = call.recording_path
    ? recordingUrl
      ? `kept · ${location.recording_retention_days} days`
      : "kept, but the playback link could not be signed"
    : location.recording_enabled
      ? "none stored for this call"
      : "off for this restaurant";

  const transcript = transcriptState(call.transcript_status);
  /* Null unless the player's own closing line would be untrue -- which
     is 'failed' and 'skipped' and nothing else. See transcriptNote. */
  const followUp = transcriptNote(call.transcript_status);

  const facts: { label: string; value: string; num?: boolean }[] = [
    { label: "Caller", value: call.from_number ?? "withheld", num: true },
    {
      label: "From",
      value: [call.from_city, call.from_state].filter(Boolean).join(", ") || "—",
    },
    { label: "They dialled", value: call.dialed_number ?? "—", num: true },
    { label: "Status", value: call.status },
    { label: "Outcome", value: call.outcome ?? "none recorded" },
    { label: "Spam", value: call.is_spam ? "yes" : "no" },
    {
      label: "Handed off",
      value: call.transferred_to_human
        ? (call.transfer_reason ?? "to a person")
        : "no",
    },
    { label: "Recording", value: recordingState },
    {
      label: "Transcript",
      value: lines.length > 0 ? `${transcript} · ${lines.length} lines` : transcript,
    },
    /* The handle on this call at Vapi. It is on this screen and no other
       because the operator is the only person who ever opens a provider
       dashboard with it. */
    { label: "Provider id", value: call.provider_call_id ?? "—", num: true },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          {/* Back to the restaurant this call belongs to, not to /admin,
              and to the TAB the row that opened this page is on. Same
              .row-link every detail page in the product puts above its
              h1.

              ?section=calls and not a bare /admin/<id>. It was bare when
              that route WAS the call log; the console's default section
              is Line now, so a bare link would land an operator working
              down the log on the go-live panel and make them press Calls
              again on every single call -- the console's most repeated
              loop. The query is validated server-side against the
              nine-item list, so the right panel is in the first byte of
              HTML and there is no hash flash. */}
          <Link href={`/admin/${locationId}?section=calls`} className="row-link">
            ← {location.name}
          </Link>
          <h1>{call.from_number ?? "Unknown caller"}</h1>
          {/* THE DATE FOR THE WHOLE SCREEN, and the only thing on it that
              carries one. <CallTimelineCard> below prints Rang /
              Answered / Ended through timeIn -- bare clock readings,
              which is the right call for three moments of ONE call but
              is only readable because this line has already said which
              day they are on. So dateTimeIn here is an invariant and not
              a preference: shorten it to timeIn and the timeline goes
              ambiguous with it. (The owner's twin screen,
              app/dashboard/calls/[id]/page.tsx:36, is still on timeIn
              and has exactly that problem -- not this pass's file.)

              Absolute first, then relative. `relative` is the only
              now-dependent string on the page and it is allowed to be
              one BECAUSE the absolute instant is next to it: "3 d ago"
              going stale in an open tab costs nothing when "Aug 14,
              2026, 11:09 AM" is right there and never does. */}
          <div className="text-muted sub">
            {dateTimeIn(tz, call.started_at)} · {relative(call.started_at)} ·{" "}
            {call.duration_seconds ? mmss(call.duration_seconds) : "no answer"}
          </div>
        </div>
        <div className="actions">
          {call.outcome ? (
            <span className={OUTCOME_TAG[call.outcome]}>{call.outcome}</span>
          ) : (
            <span className="tag tag-neutral">{call.status}</span>
          )}
        </div>
      </div>

      <div className="split">
        <div className="panel">
          {/* The house player, not a second one. With no signed URL it
              draws its own calm "no recording" card instead of an <audio>
              that cannot load, and with no lines it says the transcript
              is not here yet -- so the two empty cases are already
              handled inside it rather than by a branch out here.

              The two are independent inside it: a call whose audio was
              never kept -- recording off for the restaurant, which is a
              setting and not a fault -- still renders every line of its
              transcript, with the seek controls withdrawn. The Transcript
              fact beside this says how many lines exist, so the two can
              be read against each other. */}
          <CallPlayer
            src={recordingUrl}
            lines={lines}
            durationSeconds={call.duration_seconds}
          />

          {/* Only when the player's own sentence would be untrue. It says
              "it appears once the call is processed", which is right for
              a PENDING transcript -- the schema default, and so the
              state of every call whose end-of-call report has not landed
              yet, including one still up while an operator watches this
              page -- and wrong only for one that failed or was never
              taken. The condition used to be `!== "ready"`, which put
              "nothing more will arrive" directly under "it appears once
              the call is processed" on every pending call. */}
          {followUp ? <p className="text-muted empty-note">{followUp}</p> : null}

          {call.notes ? (
            <div className="card blueprint admin-facts">
              <Corners />
              <div className="card-kicker">The restaurant&rsquo;s note</div>
              {/* Read-only on purpose -- see the note on this component.
                  Written by staff at the restaurant on their own screen. */}
              <p className="card-body">{call.notes}</p>
            </div>
          ) : null}
        </div>

        <div className="panel">
          {/* The same card the owner's screen draws, from the same
              module: the two screens are one call read by two people and
              must not describe it differently. The handoff is in this
              screen's own facts card below, so nothing rides inside this
              <dl>. See components/CallFacts.tsx. */}
          <CallTimelineCard call={call} timezone={tz} />

          <div className="card blueprint admin-facts">
            <Corners />
            <div className="card-kicker">The call</div>
            <dl>
              {facts.map((f) => (
                <div key={f.label} className="fact-row">
                  <dt className="text-muted">{f.label}</dt>
                  <dd className={f.num ? "num" : undefined}>{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <CallCostCard call={call} />
        </div>
      </div>
    </>
  );
}
