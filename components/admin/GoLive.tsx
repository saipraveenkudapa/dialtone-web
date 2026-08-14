"use client";

import { useEffect, useRef, useState, useTransition, type RefObject } from "react";
import { Corners } from "@/components/Corners";
import {
  attachNumberAction,
  clearForwardingVerifiedAction,
  goLiveAction,
  killSwitchOffAction,
  killSwitchOnAction,
  makeItLiveAction,
  markForwardingVerifiedAction,
  provisionNumberAction,
  repairAssistantAction,
  setFallbackNumberAction,
  takeOfflineAction,
  type GoLiveActionResult,
} from "@/app/admin/[locationId]/actions";
import type {
  AttachableNumber,
  GoLiveCheckStatus,
  GoLiveState,
  MakeItLiveStep,
  MakeItLiveStepOutcome,
  NewNumberHandover,
} from "@/lib/provisioning/go-live";

/* Whether this restaurant is answering the phone, why not, and the one
 * place in the product that can change the answer.
 *
 * A client component because every control here is a mutation with a
 * pending state, a sentence to read back, and -- for the one act that
 * cannot be undone -- a confirmation to step through. None of that is
 * state; all of it is interaction. The facts come in as a prop and are
 * never recomputed here: getGoLiveState() is the authority, this file
 * only draws it.
 *
 * NOTHING BELOW IS A PERMISSION. A hidden button, a disabled button and
 * a confirmation dialog are all ergonomics -- they stop an operator
 * doing the wrong thing by accident, and stop nobody at all from POSTing
 * the action id by hand. Every one of these actions re-checks
 * currentPlatformAdmin() itself, and lib/provisioning/go-live.ts checks
 * it again before it touches the service-role key. See the header of
 * app/admin/[locationId]/actions.ts.
 *
 * THE PAVED ROAD AND THE OTHER ROADS. "Make it live" runs every step a
 * machine may run by itself, in order, and is the one primary control on
 * the panel. Every per-blocker control below it stays exactly as it was:
 * an operator debugging a half-broken restaurant still needs to repair
 * only the assistant, or attach only a number, and the one-click is a
 * worse tool for that than the specific one. One button is the paved
 * road, not the only road.
 */

type Location = GoLiveState["location"];

/** The state, in words, at the front of every note.
 *
 *  This is the whole state signal beside the row's left border -- there
 *  is no glyph chip. Colour cannot carry "blocked" apart from "worth
 *  fixing" on its own (they are two dark blues), and a word survives
 *  being read aloud, printed and colour-blind alike, which no mark
 *  does. */
const STATE_WORD: Record<GoLiveCheckStatus, string> = {
  ok: "Ready",
  blocked: "Blocked",
  warn: "Worth fixing",
  na: "Not needed",
};

/** The same vocabulary for the account of a run that has finished.
 *
 *  "Already so" and "Done" are deliberately different words over the
 *  same colour. A step the run found already satisfied did not succeed,
 *  it was never attempted, and a report that calls both of those
 *  "Done" is a report that quietly takes credit for work it did not do
 *  -- which is exactly the reporting an operator later has to un-trust
 *  the whole panel over. */
const OUTCOME_WORD: Record<MakeItLiveStepOutcome, string> = {
  "already-ok": "Already so",
  changed: "Done",
  refused: "Needs you",
  failed: "Failed",
  "not-reached": "Not tried",
};

/** Which of .golive-item's four left borders a run step wears. There are
 *  five outcomes and four borders on purpose: the word above is what
 *  separates them, the colour only groups them into settled, in the way,
 *  and never got there. */
const OUTCOME_STATE: Record<MakeItLiveStepOutcome, GoLiveCheckStatus> = {
  "already-ok": "ok",
  changed: "ok",
  refused: "blocked",
  failed: "blocked",
  "not-reached": "na",
};

/** The titles the checklist above already uses for the same four things,
 *  so a step and its check read as one subject. */
const STEP_TITLE: Record<MakeItLiveStep["key"], string> = {
  fallback: "Fallback number",
  assistant: "AI assistant",
  number: "Phone number",
  live: "Answering calls",
};

/** What one Vapi number looks like in the picker. Numbers this location
 *  may not claim stay in the list, disabled and carrying their reason:
 *  "there are no numbers" and "there are three and they all belong to
 *  somebody else" are different problems with different next steps, and
 *  a filtered list makes them look identical. */
function numberLabel(n: AttachableNumber): string {
  const name = n.name ? ` (${n.name})` : "";
  if (!n.attachable) return `${n.number}${name} — ${n.blockedReason ?? "not available"}`;
  if (n.claim === "mine") return `${n.number}${name} — already this restaurant's`;
  return `${n.number}${name} — free`;
}

/** E.164 grouped for reading down a phone: "+1 (510) 626-8819".
 *
 *  A deliberate copy of spokenNumber() in lib/provisioning/go-live.ts,
 *  which cannot be imported here: that module opens with
 *  `import "server-only"`, so only its types cross into this file. The
 *  server's own string is used whenever there is one -- a run that
 *  provisioned a number hands back `spoken` in the handover payload and
 *  this is not consulted. This is for the other opening, where the
 *  operator re-reads a number that was issued last week and all the
 *  panel has is the column.
 *
 *  Display only, in both copies. locations.twilio_number holds Vapi's
 *  own string and app/api/twilio/voice/route.ts matches inbound calls on
 *  it, so nothing grouped is ever stored, sent or compared. */
function readable(e164: string): string {
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return nanp ? `+1 (${nanp[1]}) ${nanp[2]}-${nanp[3]}` : e164;
}

/** The same number as a desk phone can actually dial it: ten digits, no
 *  plus.
 *
 *  A landline keypad has no `+` key, so "*90 then the number" beside a
 *  figure reading +15106268819 is an instruction nobody can carry out —
 *  and the email version of it reaches the restaurant owner with nobody
 *  there to ask. Null for anything that is not a NANP number, where
 *  there is no honest guess to make: the E.164 string is then the only
 *  form this screen knows, and it is shown as it is.
 *
 *  The mobile codes keep the full E.164 string; they are dialled with
 *  the country code and are wrong without it. */
function dialable(e164: string): string | null {
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return nanp ? `${nanp[1]}${nanp[2]}${nanp[3]}` : null;
}

/** The handover payload, rebuilt from the row.
 *
 *  Identical in shape to what makeItLive hands back, and built from the
 *  same five columns -- getGoLiveState loads the location with
 *  select("*"), so re-opening this dialog next week is a useState flip
 *  and not a fetch. */
function handoverOf(location: Location, e164: string): NewNumberHandover {
  return {
    e164,
    spoken: readable(e164),
    businessPhone: location.business_phone,
    carrier: location.carrier_name,
    locationName: location.name,
  };
}

/** Which dialog is open, and what it is about.
 *
 *  One union rather than three flags, so the one Escape-and-focus effect
 *  below covers all of them and there is never a second mechanism to
 *  keep in step with the first. */
type Dialog =
  | { kind: "provision" }
  | { kind: "repair" }
  /** `onRecord` is "this number is in locations.twilio_number", and it
   *  is carried rather than compared at render time for one reason: the
   *  revalidated row can arrive a render after the dialog opens, and a
   *  handover that flashes "this is your only copy" at a number that was
   *  saved perfectly well is a screen an operator stops believing. It is
   *  set from what the run reported about its own write. */
  | { kind: "handover"; view: NewNumberHandover; fresh: boolean; onRecord: boolean }
  | null;

/** One leg of a run, as the button reports it while the run is in
 *  flight.
 *
 *  This is an ESTIMATE and the copy says so. makeItLive is one server
 *  action and one await -- there is no progress channel to read, so what
 *  is drawn here is the order the server works in, walked on a clock,
 *  with the legs that have real work to do given longer than the legs
 *  that are a re-derivation. The honest account replaces it the moment
 *  the run answers; nothing here is ever kept afterwards. */
type Stage = { label: string; detail: string; ms: number };

function stagesFor(assistantOk: boolean, numberOk: boolean): Stage[] {
  return [
    {
      label: "The fallback number…",
      detail:
        "Checking there is a number to hand a call to when the agent cannot help. Nothing is " +
        "written and nothing is bought until that one is answered.",
      ms: 900,
    },
    assistantOk
      ? {
          label: "The assistant…",
          detail: "Confirming the assistant this record names is the one Vapi has.",
          ms: 3000,
        }
      : {
          label: "The assistant…",
          detail:
            "Reconnecting the assistant, putting its label back, or building one — whichever is " +
            "actually missing. The number is done after this one, never before, so it ends up " +
            "pointed at the assistant that survives.",
          ms: 12000,
        },
    numberOk
      ? {
          label: "The phone number…",
          detail: "Confirming the number on file still rings this assistant.",
          ms: 3000,
        }
      : {
          label: "The phone number…",
          detail:
            "Reusing a number this restaurant already has, then a free one on the account, and " +
            "taking a brand-new one only if neither exists.",
          ms: 12000,
        },
    {
      label: "Turning it on…",
      detail: "Writing it live, which re-derives every blocker one last time before it does.",
      ms: 0,
    },
  ];
}

/** A phone number, set as a figure. The house does this everywhere else
 *  one is shown (app/dashboard/calls/[id] renders a caller's number as
 *  <dd className="num">), and a phone number in proportional type is the
 *  one detail that makes a screen look unlike the mockup. */
function num(value: string) {
  return <span className="num">{value}</span>;
}

export function GoLive({ state }: { state: GoLiveState }) {
  const { location, checks, canGoLive, numbers, vapiError, ownershipError } = state;

  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<GoLiveActionResult | null>(null);
  const [pick, setPick] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);

  /** The account of the last one-click run. Acts, not facts: the
   *  checklist above re-renders from getGoLiveState() and is always the
   *  fresher word on what is true now, but nothing on the server can
   *  reconstruct what this run tried, skipped and failed at. */
  const [report, setReport] = useState<MakeItLiveStep[] | null>(null);
  const [progress, setProgress] = useState<{ stages: Stage[]; at: number } | null>(null);
  const [focusFallback, setFocusFallback] = useState(false);

  const [fallback, setFallback] = useState(location.fallback_human_number ?? "");

  // Take a fresh server value during render rather than in an effect, so
  // the field never sits there showing an edit the database has already
  // replaced. Same pattern as components/AgentStatus.tsx.
  const [seenFallback, setSeenFallback] = useState(location.fallback_human_number);
  if (seenFallback !== location.fallback_human_number) {
    setSeenFallback(location.fallback_human_number);
    setFallback(location.fallback_human_number ?? "");
  }

  // The standalone "Get a new number…" road ends at the same handover
  // moment as the one-click, and must open the same dialog. It cannot
  // open it from the result: provisionNumberAction hands back a sentence
  // and nothing else, and the number itself arrives with the revalidated
  // prop a moment later. So the click arms this, and the render carrying
  // the new number fires the dialog -- the same read-the-server-value-
  // during-render shape as seenFallback above.
  const [awaitingNumber, setAwaitingNumber] = useState(false);
  if (awaitingNumber && location.twilio_number) {
    setAwaitingNumber(false);
    setDialog({
      kind: "handover",
      view: handoverOf(location, location.twilio_number),
      fresh: true,
      // Read off the row itself: this road only opens once the column
      // has the number in it.
      onRecord: true,
    });
  }

  const dialogFocusRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!dialog) return;

    // The safe choice takes focus, and Escape is the safe choice too.
    // For the handover that is Done: it decides nothing, so there is
    // nothing there to be safe from.
    dialogFocusRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDialog(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dialog]);

  // The run's own instruction, obeyed once the field is touchable again.
  // It is disabled while the transition is in flight, and focus() on a
  // disabled input is a no-op, so this waits for `busy` to fall rather
  // than firing into nothing.
  useEffect(() => {
    if (!focusFallback) return;
    const el = fallbackRef.current;
    if (!el || el.disabled) return;
    el.focus();
    if (el.value !== "") el.select();
    setFocusFallback(false);
  }, [focusFallback, pending]);

  // Walk the estimated stages while the run is in flight. Stops on the
  // last one rather than running off the end: a button that claims to
  // have finished while the request is still open is the failure this
  // whole ticker exists to avoid.
  useEffect(() => {
    if (!progress) return;
    if (progress.at >= progress.stages.length - 1) return;
    const timer = setTimeout(
      () => setProgress((p) => (p ? { ...p, at: p.at + 1 } : p)),
      progress.stages[progress.at].ms,
    );
    return () => clearTimeout(timer);
  }, [progress]);

  const blockers = checks.filter((c) => c.status === "blocked");
  const numberCheck = checks.find((c) => c.key === "number");
  const assistantCheck = checks.find((c) => c.key === "assistant");
  const forwardingCheck = checks.find((c) => c.key === "forwarding");
  const needsNumber = numberCheck?.status !== "ok";
  const needsAssistant = assistantCheck?.status !== "ok";
  const attachable = numbers.filter((n) => n.attachable);
  // Bound once so it stays narrowed inside the click handler that reads
  // it. Everything the handover states comes off this same row.
  const ourNumber = location.twilio_number;

  function run(action: () => Promise<GoLiveActionResult>, { handover = false } = {}) {
    setMessage(null);
    setDialog(null);
    setReport(null);
    setAwaitingNumber(false);
    startTransition(async () => {
      try {
        const result = await action();
        setMessage(result);
        if (handover && result.ok) setAwaitingNumber(true);
      } catch {
        // A server action that never answers -- a dropped connection, a
        // request killed for running too long. Uncaught, the rejection
        // is re-thrown during render and takes the whole panel to
        // app/admin/error.tsx, which is a worse answer than a sentence:
        // the operator loses the checklist as well as the run.
        setMessage({
          ok: false,
          error:
            "That did not come back — the connection dropped, or the request ran too long. " +
            "Nothing here knows whether it landed. Reload the panel to see where this " +
            "restaurant actually stands.",
        });
      }
    });
  }

  function runMakeItLive() {
    setMessage(null);
    setDialog(null);
    setReport(null);
    setAwaitingNumber(false);
    setProgress({ stages: stagesFor(!needsAssistant, !needsNumber), at: 0 });
    startTransition(async () => {
      try {
        const result = await makeItLiveAction(location.id);
        setMessage(
          result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error },
        );
        // Always length four, except on the gate's own refusal, where it is
        // empty and there is nothing to account for.
        setReport(result.steps.length > 0 ? result.steps : null);
        // On success AND on failure. A number that now exists is the
        // operator's most urgent fact whether or not the rest of the run
        // landed -- reporting it is the rollback, because there is no other
        // one that does not throw the number away.
        if (result.newNumber) {
          // "changed" is the number step saying it wrote the column.
          // runProvision's two failure branches -- the update errored, or
          // it lost a compare-and-set to another run -- both report
          // "failed" while still handing back the number, and that is
          // exactly the case where this dialog is the only record of a
          // real, billed number anywhere.
          const wrote = result.steps.find((s) => s.key === "number")?.outcome === "changed";
          setDialog({
            kind: "handover",
            view: result.newNumber,
            fresh: true,
            onRecord: wrote,
          });
        }
        if (!result.ok && result.focus === "fallback") setFocusFallback(true);
      } catch {
        // The one run in the product that can mint a number, ending
        // without a word. Uncaught, this rejection is re-thrown during
        // render and replaces the panel with an error page -- and if the
        // run HAD got as far as POST /phone-number, that error page is
        // the moment the only report of a real, billed, undeletable
        // number is lost. So it is caught, and the sentence says the one
        // thing the client genuinely cannot rule out.
        setMessage({
          ok: false,
          error:
            "That run did not come back — the connection dropped, or it ran longer than this " +
            "deployment allows. What it managed before that cannot be read from here. Reload " +
            "the panel to see where this restaurant actually stands, and if it had got as far " +
            "as taking a brand-new number, check the Vapi dashboard before pressing this " +
            "again: a number that was issued but never written down does not show up on this " +
            "screen.",
        });
      } finally {
        // In both paths. A ticker still walking its estimate after the
        // run is over is the dead button this whole progress display
        // exists to avoid.
        setProgress(null);
      }
    });
  }

  // When Vapi is unreachable, `numbers` is empty and the assistant and
  // number checks are blocked because they could not be CONFIRMED, not
  // because they are known to be wrong. The controls that act on them
  // are withdrawn rather than disabled, so the panel never states as
  // fact something it could not read. The one-click drives exactly those
  // controls, so it goes with them.
  //
  // The two switches that take a restaurant DOWN are deliberately
  // outside all of this: they are single-column writes, and a Vapi
  // outage must never be able to keep a bad deployment live.
  const vapiDown = vapiError !== null;
  const busy = pending;
  const noFallback = !location.fallback_human_number;

  const headline = !location.is_live
    ? "Not live"
    : location.kill_switch_on
      ? "Kill switch on"
      : "Answering calls";

  // JSX rather than a template string so the numbers inside it can be
  // set as figures.
  const sub = !location.is_live ? (
    location.twilio_number ? (
      <>{num(location.twilio_number)} is on file, but the assistant will not pick up.</>
    ) : (
      <>No number, and the assistant will not pick up.</>
    )
  ) : location.kill_switch_on ? (
    location.fallback_human_number ? (
      <>Live, but every call goes straight to {num(location.fallback_human_number)}.</>
    ) : (
      <>
        Live, but every call is being handed to a person — and there is no number to hand it to.
      </>
    )
  ) : location.twilio_number ? (
    <>{num(location.twilio_number)} rings the assistant.</>
  ) : (
    <>The number on file rings the assistant.</>
  );

  const confirmCopy =
    dialog?.kind === "provision"
      ? {
          title: "Get a new phone number?",
          body: (
            <>
              <p>
                This provisions a real, dialable number on the Vapi account and points it at{" "}
                {location.name}&rsquo;s assistant.
              </p>
              <p>
                It uses one of the account&rsquo;s free numbers, and every call it takes bills
                per minute from the moment somebody dials it. Handing a number back later
                returns the allowance but never that number — so once this one is on a door, a
                menu or a Google listing, there is no undo.
              </p>
            </>
          ),
          cta: "Get a number",
          go: () => run(() => provisionNumberAction(location.id), { handover: true }),
        }
      : dialog?.kind === "repair"
        ? {
            title: "Repair the assistant?",
            body: (
              <>
                <p>
                  Dialtone looks for a Vapi assistant already labelled for {location.name}. If it
                  finds one, this fixes the record and changes nothing on Vapi.
                </p>
                <p>
                  If nothing carries the label but the assistant this record names is still on the
                  account, the label is put back on it — one field, no rebuild, and the tool secret
                  is untouched.
                </p>
                <p>
                  Only when there is no assistant at all does this build one, which rotates this
                  restaurant&rsquo;s tool secret. The phone number is never re-pointed, so after a
                  rebuild you will need to attach the number again.
                </p>
              </>
            ),
            cta: "Repair",
            go: () => run(() => repairAssistantAction(location.id)),
          }
        : null;

  return (
    <section className="card blueprint golive">
      <Corners />
      <h4>Going live</h4>

      <p className="golive-state">
        <span
          className={location.is_live && !location.kill_switch_on ? "status-dot live" : "status-dot off"}
          aria-hidden="true"
        />
        {headline}
        <span className="sub">{sub}</span>
      </p>

      {vapiError ? (
        <p className="golive-note">
          <span className="tag tag-out">Vapi</span> {vapiError} Until that clears, the assistant
          and number checks cannot be confirmed, so this restaurant cannot be turned on and the
          controls for those two — and the one-click that drives them — are hidden rather than
          shown against facts we could not read. Taking it off, and the kill switch, still work —
          those are single columns and never wait on Vapi.
        </p>
      ) : null}

      {ownershipError ? (
        <p className="golive-note">
          <span className="tag tag-out">Numbers</span> {ownershipError} The list below still shows
          what is on the Vapi account, each row carrying that reason. Everything else on this panel
          — including taking the restaurant off and the kill switch — is unaffected.
        </p>
      ) : null}

      {message ? (
        <p className="golive-note" role="status" aria-live="polite">
          {message.ok ? null : (
            <>
              <span className="tag tag-out">Failed</span>{" "}
            </>
          )}
          {message.ok ? message.message : message.error}
        </p>
      ) : null}

      <div className="golive-list">
        {checks.map((check) => (
          <div key={check.key} className={`golive-item is-${check.status}`}>
            <div className="golive-body">
              <div className="golive-title">{check.title}</div>
              <p className="golive-note">
                {STATE_WORD[check.status]} — {check.note}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* The paved road, first, so it is read before the row of
          single-purpose controls below it. Not gated on canGoLive:
          clearing the blockers is the job, and a button disabled by the
          very thing it exists to fix is a dead end. */}
      {!vapiDown ? (
        <div className="golive-actions" role="group" aria-label="Turn this restaurant on">
          <button
            type="button"
            className="btn btn-primary golive-go"
            disabled={busy}
            aria-describedby="golive-paved"
            onClick={runMakeItLive}
          >
            {progress ? progress.stages[progress.at].label : "Make it live"}
          </button>

          <p className="golive-note" id="golive-paved">
            {noFallback ? (
              <>
                One press does every step a machine may do by itself — but not this one. There is
                no fallback number on file, and that is a fact about the restaurant only a person
                knows. Pressing this says so and puts the cursor in the field below: type the
                number a caller should reach when the agent cannot help, save it, then press it
                again.
              </>
            ) : location.is_live ? (
              <>
                Already live. Pressing this re-checks every step and repairs whatever has drifted —
                a record that has lost its assistant, a number that no longer rings it — then
                writes it live again. It never touches the kill switch.
              </>
            ) : (
              <>
                One press, in order: the assistant first, then the number — reusing one this
                restaurant already has, then a free one on the account, and taking a brand-new one
                only if neither exists — and then the line goes on. The controls below stay for
                fixing one thing at a time.
              </>
            )}
          </p>
        </div>
      ) : null}

      {progress ? (
        <div className="golive-run">
          <div className="card-kicker">Working</div>
          <p className="golive-note" role="status" aria-live="polite">
            Step {progress.at + 1} of {progress.stages.length} — {progress.stages[progress.at].detail}
          </p>
          <p className="golive-note text-muted">
            That is the order the run works in, walked on a clock — not a report. What it actually
            did appears here when it answers.
          </p>
        </div>
      ) : report ? (
        <div className="golive-run">
          <div className="card-kicker">What that run did</div>
          <div className="golive-list">
            {report.map((step) => (
              <div key={step.key} className={`golive-item is-${OUTCOME_STATE[step.outcome]}`}>
                <div className="golive-body">
                  <div className="golive-title">{STEP_TITLE[step.key]}</div>
                  <p className="golive-note">
                    {OUTCOME_WORD[step.outcome]}
                    {step.note ? ` — ${step.note}` : null}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="golive-actions" role="group" aria-label="Fix what is missing">
        <div className="field">
          <label htmlFor="golive-fallback">Fallback number</label>
          <input
            id="golive-fallback"
            ref={fallbackRef}
            className="input"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="(510) 555-0100"
            value={fallback}
            disabled={busy}
            onChange={(event) => setFallback(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || fallback.trim() === "" || fallback === (location.fallback_human_number ?? "")}
          onClick={() => run(() => setFallbackNumberAction(location.id, fallback))}
        >
          Save fallback
        </button>

        {/* Both of these act on facts that live in Vapi, so while Vapi
            is unreachable they are not drawn at all. A disabled Attach
            beside "there are no numbers on the account" would be stating
            as fact something we simply could not read; the note above
            says so instead. */}
        {needsAssistant && !vapiDown ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => setDialog({ kind: "repair" })}
          >
            Repair assistant…
          </button>
        ) : null}

        {needsNumber && !vapiDown ? (
          <>
            {numbers.length > 0 ? (
              <>
                <div className="field">
                  <label htmlFor="golive-number">Attach a number</label>
                  <select
                    id="golive-number"
                    className="input"
                    value={pick}
                    disabled={busy}
                    onChange={(event) => setPick(event.target.value)}
                  >
                    <option value="">Choose a number…</option>
                    {numbers.map((n) => (
                      <option key={n.id} value={n.id} disabled={!n.attachable}>
                        {numberLabel(n)}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || pick === ""}
                  onClick={() => run(() => attachNumberAction(location.id, pick))}
                >
                  Attach
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => setDialog({ kind: "provision" })}
            >
              Get a new number…
            </button>
            <p className="golive-note">
              {/* "Nothing is attachable" has two quite different causes
                  and only one of them is a fact about the account, so
                  they never share a sentence. */}
              {ownershipError
                ? "Nothing can be attached until that read comes back — every row is refused for the same reason, not because the account is full. Getting a brand-new number does not depend on it."
                : numbers.length === 0
                  ? "There are no numbers on the Vapi account yet. Getting one spends the account’s free-number allowance and cannot be undone, so it asks first."
                  : attachable.length === 0
                    ? "Every number on the account is already spoken for — each one carries its reason in the list. Free one up in the Vapi dashboard, or get a new one."
                    : "Attaching a number you already have is free and takes one click to undo. Getting a new one does not."}
            </p>
          </>
        ) : null}
      </div>

      <div className="golive-actions" role="group" aria-label="The state of the line">
        {location.is_live ? (
          // The one control with no guard of any kind: not disabled while
          // something else is in flight, not behind a confirmation, not
          // waiting on Vapi. A confirmation step was considered and
          // deliberately left off -- an operator killing a bad deployment
          // must never be argued with, and the write is a single column
          // that both app/api/twilio/voice/route.ts and
          // app/api/agent/assistant/route.ts already treat as final. The
          // click is idempotent, so nothing is lost to a double press.
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => run(() => takeOfflineAction(location.id))}
          >
            Take offline
          </button>
        ) : (
          // Kept, and demoted. "Make it live" above is the primary now,
          // but this is still the only control that does the single write
          // and nothing else -- which is what an operator wants when the
          // checklist is already green and they would rather not have a
          // button go off and reconcile Vapi behind their back.
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !canGoLive}
            aria-describedby={blockers.length > 0 ? "golive-blockers" : undefined}
            onClick={() => run(() => goLiveAction(location.id))}
          >
            Go live
          </button>
        )}

        {location.kill_switch_on ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => run(() => killSwitchOffAction(location.id))}
          >
            Turn the kill switch off
          </button>
        ) : (
          // Ungated for the same reason as Take offline: this is the
          // control somebody reaches for while a caller is being handled
          // badly, and it must answer on the first press every time.
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => run(() => killSwitchOnAction(location.id))}
          >
            Kill switch on
          </button>
        )}

        {/* Offered only when forwarding means something. A restaurant
            that publishes the Dialtone number directly forwards nothing,
            so its check reads "na" and a button to swear the forwarding
            works would be a claim about a thing that does not exist. The
            clearing button survives that test regardless: a timestamp
            already on the row can always be taken back. */}
        {location.forwarding_verified_at ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => run(() => clearForwardingVerifiedAction(location.id))}
          >
            Forwarding is not proven after all
          </button>
        ) : forwardingCheck?.status !== "na" ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy}
            onClick={() => run(() => markForwardingVerifiedAction(location.id))}
          >
            Mark forwarding verified
          </button>
        ) : null}

        {/* The handover, reachable for as long as the number is. It is
            not a secret and it is not shown once: what an operator has to
            read down a phone this week they will have to read again next
            week, and a screen that can only be reached by provisioning
            something is a screen nobody can get back to. Absent when
            there is no number, because then there is nothing to hand
            over. */}
        {ourNumber ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() =>
              setDialog({
                kind: "handover",
                view: handoverOf(location, ourNumber),
                fresh: false,
                onRecord: true,
              })
            }
          >
            What to tell the restaurant
          </button>
        ) : null}

        {!location.is_live && blockers.length > 0 ? (
          <p className="golive-note" id="golive-blockers">
            {/* The titles are headings ("Phone number", "AI assistant"),
                so they are listed after the colon rather than dropped
                mid-sentence, where capitalised nouns read as a stutter. */}
            Go live is off until {blockers.length === 1 ? "this is" : "these are"} sorted out:{" "}
            {blockers.map((b) => b.title).join(", ")}. The warnings above never stop it.
            {vapiDown ? null : " Make it live works through them for you."}
          </p>
        ) : null}
      </div>

      {confirmCopy ? (
        <div
          className="dialog-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="golive-confirm-title"
        >
          <div className="dialog blueprint">
            <Corners />
            <div id="golive-confirm-title" className="dialog-title">
              {confirmCopy.title}
            </div>
            <div className="dialog-body">{confirmCopy.body}</div>
            <div className="dialog-actions">
              <button
                ref={dialogFocusRef}
                type="button"
                className="btn btn-ghost"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={confirmCopy.go}
              >
                {confirmCopy.cta}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog?.kind === "handover" ? (
        <Handover
          view={dialog.view}
          fresh={dialog.fresh}
          onRecord={dialog.onRecord}
          panelNumber={location.twilio_number}
          fallback={location.fallback_human_number}
          verifiedAt={location.forwarding_verified_at}
          doneRef={dialogFocusRef}
          onDone={() => setDialog(null)}
        />
      ) : null}
    </section>
  );
}

/* ── the handover ──────────────────────────────────────────────────── */

/** What the operator reads down the phone, or pastes into an email.
 *
 *  The handover moment of the whole product: the number exists, and
 *  until somebody outside this screen is told about it, it rings nobody.
 *  Two variants, chosen the same way forwardingCheck() chooses "na" --
 *  a restaurant with a line of its own forwards to this number, a
 *  restaurant without one publishes it. Forwarding codes are shown only
 *  to the first, because teaching them to the second would be teaching
 *  it to forward a line it does not have.
 *
 *  It decides nothing, so it has no Cancel and no destructive control,
 *  and there is deliberately no "Mark forwarding verified" here: at this
 *  moment nobody has rung the line, so the button would be offering a
 *  claim the operator cannot yet make. It names the one on the panel
 *  instead. */
export function Handover({
  view,
  fresh,
  onRecord,
  panelNumber,
  fallback,
  verifiedAt,
  doneRef,
  onDone,
}: {
  view: NewNumberHandover;
  fresh: boolean;
  /** Whether this number is in locations.twilio_number. False is the
   *  state this dialog exists for: Vapi issued a real, billed,
   *  undeletable number and the column write did not land, so this
   *  screen is the only place it is written down anywhere. */
  onRecord: boolean;
  /** What the panel's own "What to tell the restaurant" would open --
   *  the row's number. Named in the warning when it is a DIFFERENT
   *  number from this one, because "you can open this again" is then
   *  true of a screen about something else. */
  panelNumber: string | null;
  fallback: string | null;
  /** locations.forwarding_verified_at. Read off the panel's own row
   *  rather than the handover payload: the payload is a record of a run,
   *  this is a fact about right now, and this dialog is opened again
   *  long after the run. */
  verifiedAt: string | null;
  doneRef: RefObject<HTMLButtonElement | null>;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  // Bound once, so it narrows to a string inside every branch below.
  // Its null-ness is the whole variant switch, and it is the same
  // distinction forwardingCheck() makes when it returns "na": a
  // restaurant with a line of its own forwards to the Dialtone number,
  // a restaurant without one publishes it.
  const theirs = view.businessPhone;

  // The desk-phone form of this number, and what the landline rows below
  // tell somebody to dial. Null outside NANP, where nothing here knows a
  // dialable shorter form -- the E.164 string is then all there is, and
  // saying "then the number" beside it is at least not wrong.
  const desk = dialable(view.e164);
  const landline = desk ?? view.e164;

  // A number issued a moment ago has never been rung, whatever the row
  // says about the arrangement it replaced -- so `fresh` always asks for
  // the proof, and only a re-reading can report one already given.
  const proven = verifiedAt !== null && !fresh;

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      // Clipboard blocked or unavailable. The figure is user-select: all
      // and everything else here is selectable text, so nothing is lost.
    }
  }

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="golive-handover-title"
    >
      <div className="dialog blueprint handover-dialog">
        <Corners />
        <div id="golive-handover-title" className="dialog-title">
          {theirs !== null ? (
            <>Point {view.locationName}&rsquo;s phone at this number</>
          ) : (
            <>Publish this number for {view.locationName}</>
          )}
        </div>

        <div className="dialog-body">
          {fresh ? (
            <p>This number was issued a moment ago. Nobody outside this screen has it yet.</p>
          ) : null}

          {theirs !== null ? (
            <p>
              This is {view.locationName}&rsquo;s Dialtone number. It does not replace{" "}
              {num(theirs)} — the restaurant keeps its own line and keeps
              answering it. What changes is where a call goes when nobody there picks up: the
              carrier passes busy, unanswered and after-hours calls to the number below, and the
              assistant answers those.
            </p>
          ) : (
            <p>
              This is {view.locationName}&rsquo;s Dialtone number. {view.locationName} has no line
              of its own on file, so there is nothing to forward and no code for anyone to dial —
              this is the number the restaurant gives out. Every call to it is answered by the
              assistant.
            </p>
          )}

          <div className="handover-number">
            <div className="card-kicker">{theirs !== null ? "Forward to" : "Their number"}</div>
            <span className="num">{view.e164}</span>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => copy("number", view.e164)}
            >
              {copied === "number" ? "Copied" : "Copy number"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => copy("all", handoverText(view, fallback))}
            >
              {copied === "all" ? "Copied all of it" : "Copy the whole thing"}
            </button>
            <p className="handover-say text-muted">
              Read it aloud as <span className="num">{view.spoken}</span>. Copy it as the figures
              above — that exact string is what Dialtone matches an incoming call against, and the
              mobile codes below take the country code with them.
              {desk !== null ? (
                <>
                  {" "}
                  On a desk phone there is no <span className="num">+</span> key, so dial it as{" "}
                  <span className="num">{desk}</span> — ten digits. Some lines want a{" "}
                  <span className="num">1</span> in front for a long-distance number.
                </>
              ) : null}
            </p>
          </div>

          {theirs !== null ? (
            <>
              <hr className="hr" />

              <p>
                <span className="tag tag-outline">Typical</span>{" "}
                {view.carrier ? (
                  <>
                    These are the standard codes, not {view.carrier}&rsquo;s own instructions — we
                    do not have those on file. Codes differ by carrier, and a landline and a mobile
                    are not the same line. Confirm with {view.carrier} before you read any of this
                    out.
                  </>
                ) : (
                  <>
                    These are the standard codes. No carrier is on file for this restaurant, so
                    none of it is confirmed. Ask who provides the line, put it on the account
                    record, and use their instructions over these.
                  </>
                )}
              </p>

              <div className="card-kicker">Landline or desk phone</div>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Dial</th>
                      <th>Turn it off</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>The line is busy</td>
                      <td className="num">*90 then {landline}</td>
                      <td className="num">*91</td>
                    </tr>
                    <tr>
                      <td>Nobody answers</td>
                      <td className="num">*92 then {landline}</td>
                      <td className="num">*93</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="card-kicker">Mobile</div>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Dial</th>
                      <th>Turn it off</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>The line is busy</td>
                      <td className="num">{`**67*${view.e164}#`}</td>
                      <td className="num">##67#</td>
                    </tr>
                    <tr>
                      <td>Nobody answers</td>
                      <td className="num">{`**61*${view.e164}#`}</td>
                      <td className="num">##61#</td>
                    </tr>
                    <tr>
                      <td>The phone is off or has no signal</td>
                      <td className="num">{`**62*${view.e164}#`}</td>
                      <td className="num">##62#</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Every code in this paragraph is a 3GPP MMI code and every
                  one of them is inert on a landline, so it says which
                  table it belongs to in its first two words. Read down
                  the phone to a desk-phone restaurant, ##002# is dialled,
                  the switch ignores it, and both parties believe the line
                  was cleared before new codes go on top of the old. */}
              <p>
                On a mobile, dial a code like a phone call and wait for the network to confirm
                it. <span className="num">*#002#</span> reads back every forwarding rule on the
                line; <span className="num">*#61#</span> reads back the no-answer rule only, so a
                line whose busy rule silently failed still looks right to it.{" "}
                <span className="num">##002#</span> clears every forwarding rule on the mobile —
                including any the restaurant set for its own reasons. On most networks{" "}
                <span className="num">{`**61*${view.e164}**20#`}</span> sets how long it rings
                first, in seconds, in fives up to thirty. If a code is refused, try the number
                without the plus.
              </p>

              <p>
                There is also a code that forwards <em>every</em> call. Do not hand it over. The
                restaurant should still answer its own phone; Dialtone is for the calls it misses.
              </p>
            </>
          ) : null}

          <hr className="hr" />

          <div className="card-kicker">What happens on a call</div>
          {theirs !== null ? (
            <p>
              A customer dials {num(theirs)}. The restaurant&rsquo;s phone
              rings first. If it is busy or nobody picks up, the carrier passes the call to{" "}
              {num(view.e164)} and the assistant answers it.{" "}
              {fallback ? (
                <>
                  Anything the assistant cannot take — a transfer, an allergy question — goes to{" "}
                  {num(fallback)}.
                </>
              ) : (
                <>
                  There is no fallback number on file, so there is nowhere to hand a call the
                  assistant cannot take.
                </>
              )}
            </p>
          ) : (
            <p>
              A customer dials {num(view.e164)} and the assistant answers.{" "}
              {fallback ? (
                <>
                  Anything it cannot take — a transfer, an allergy question — goes to{" "}
                  {num(fallback)}.
                </>
              ) : (
                <>
                  There is no fallback number on file, so there is nowhere to hand a call the
                  assistant cannot take.
                </>
              )}
            </p>
          )}

          <div className="card-kicker">Next</div>
          {theirs !== null ? (
            proven ? (
              // Reopened on a restaurant whose forwarding somebody has
              // already proved. Asking again for a proof already given
              // is the same lie a title reading "is live" would be: this
              // dialog is re-read weeks after the handover, so what it
              // says about the state of things has to be true at the
              // moment it is opened, not at the moment it was written.
              <>
                <p>
                  Somebody has already rung {num(theirs)} and the call landed here, so the
                  forwarding is proved and there is nothing to do. Everything above is the
                  arrangement that is running now.
                </p>
                <p>
                  If the restaurant changes carrier, changes line, or the codes get cleared, ring
                  it again — and if it no longer lands here, press{" "}
                  <em>Forwarding is not proven after all</em> on the panel to take the claim back.
                </p>
              </>
            ) : (
              <>
                <ol className="missing-list">
                  <li>
                    Ring {num(theirs)} from another phone and let it ring out. If the assistant
                    answers, forwarding works.
                  </li>
                  <li>
                    Come back here and press <em>Mark forwarding verified</em>.
                  </li>
                </ol>
                <p>
                  Until somebody does, the panel lists this restaurant&rsquo;s forwarding as
                  unproven. That is a warning, not a blocker — the restaurant is live either way.
                </p>
              </>
            )
          ) : (
            <>
              <p>
                Ring it once yourself to hear what a customer hears. Then get it onto the door, the
                menu, the website and the Google listing. A number nobody has been given rings
                nobody.
              </p>
              <p>
                If {view.locationName} does have a phone line, put it on the account record —
                forwarding is then worth setting up, and this screen will say how.
              </p>
            </>
          )}

          <hr className="hr" />

          {/* The last thing read before Done, so it has to be true of
              THIS number rather than of the usual case. A number Vapi
              issued and this record failed to write down is reachable
              from nowhere else in the product: the panel's own button is
              drawn from the column, and on that path the column is
              either empty or holds a different number. Telling an
              operator it can be opened again is how the only copy of a
              real, billed number gets dismissed. */}
          {onRecord ? (
            <p className="text-muted">
              This is not a secret and this is not your only look at it.{" "}
              <em>What to tell the restaurant</em>, on the panel, opens it again.
            </p>
          ) : (
            <p>
              <span className="tag tag-out">Only copy</span> This number is not written down on{" "}
              {view.locationName}&rsquo;s record — it exists on Vapi and nowhere else here, and it
              bills per minute from the first call. Nothing on this panel opens this screen again:{" "}
              {panelNumber ? (
                <>
                  <em>What to tell the restaurant</em> opens {num(panelNumber)}, which is a
                  different number.
                </>
              ) : (
                <>there is no number on the record for that button to open.</>
              )}{" "}
              Copy it or write it down before you press Done, then settle in the Vapi dashboard
              which number this restaurant keeps.
            </p>
          )}
        </div>

        <div className="dialog-actions">
          <button ref={doneRef} type="button" className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** What "Copy the whole thing" writes: plain text addressed to the
 *  restaurant owner, ready to paste into an email or read down the
 *  phone. Same shape as the `both` string in
 *  components/admin/NewRestaurantForm.tsx.
 *
 *  The number appears here exactly as it is stored, in every place --
 *  including inside the mobile codes, which are dialled with the country
 *  code and would be wrong with a prettified one. */
export function handoverText(view: NewNumberHandover, fallback: string | null): string {
  const tail = fallback ? `\n\nAnything Dialtone cannot answer is passed to ${fallback}.` : "";

  if (view.businessPhone === null) {
    return (
      `Dialtone for ${view.locationName}\n` +
      `Your number: ${view.e164}\n` +
      "\n" +
      "Put this number on the door, the menu, the website and your Google listing.\n" +
      "Every call to it is answered by Dialtone. There is nothing to forward and no\n" +
      "code to dial." +
      tail
    );
  }

  const provider = view.carrier ? `your phone provider (${view.carrier})` : "your phone provider";
  // The one artifact here that reaches the restaurant owner unsupervised,
  // with nobody to ask what "the number" means on a keypad with no plus
  // key. The mobile codes keep the full string; they need the country
  // code and are wrong without it.
  const landline = dialable(view.e164) ?? view.e164;

  return (
    `Dialtone for ${view.locationName}\n` +
    `Forward your calls to: ${view.e164}\n` +
    "\n" +
    `You keep your own number, ${view.businessPhone}, and you keep answering it. When the\n` +
    "line is busy or nobody picks up, your carrier passes the call to the number\n" +
    "above and Dialtone answers it.\n" +
    "\n" +
    `To set that up, ask ${provider} for conditional call\n` +
    `forwarding -- busy and no answer -- to ${view.e164}.\n` +
    "\n" +
    "Typical codes, which your provider may do differently:\n" +
    `  Landline  Busy *90 then ${landline}. No answer *92 then ${landline}.\n` +
    "            Turn them off with *91 and *93. If the code is refused, try\n" +
    "            dialling a 1 before the number.\n" +
    `  Mobile    Busy **67*${view.e164}#. No answer **61*${view.e164}#.\n` +
    `            Phone off **62*${view.e164}#. Turn all of it off with ##002#.` +
    tail
  );
}
