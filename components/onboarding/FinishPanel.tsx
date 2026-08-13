"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Corners } from "@/components/Corners";
import { finishOnboarding, type FinishState } from "@/app/onboarding/actions";

/** The last screen: mint the per-location tool secret, create the Vapi
 *  assistant, and show the secret exactly once. Not tied to a step in
 *  onboarding_step -- see app/onboarding/actions.ts's own header for why
 *  "done" is agent_secret_hash being set, not a fifth step value. */
export function FinishPanel() {
  const [result, setResult] = useState<FinishState | null>(null);
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  function handleFinish() {
    setCopied(false);
    startTransition(async () => {
      setResult(await finishOnboarding());
    });
  }

  async function handleCopy() {
    if (!result?.secret) return;
    try {
      await navigator.clipboard.writeText(result.secret);
      setCopied(true);
    } catch {
      // Clipboard permission denied or unavailable in this browser -- the
      // box below is still selectable text, so nothing is actually lost.
    }
  }

  if (result?.alreadyDone) {
    return (
      <div className="card blueprint onboard-card">
        <Corners />
        <h2>Already set up</h2>
        <p className="text-muted sub">
          This restaurant already finished onboarding. Its tool secret was shown once, at that
          time, and cannot be shown again -- rotate it from the dashboard if it&rsquo;s been lost.
        </p>
        <div className="onboard-actions">
          <span />
          <Link href="/dashboard" className="btn btn-primary">
            Go to dashboard
          </Link>
        </div>
      </div>
    );
  }

  if (result?.ok) {
    return (
      <div className="card blueprint onboard-card">
        <Corners />
        <h2>You&rsquo;re wired up</h2>
        <p className="text-muted sub">
          The AI assistant was created on Vapi, with all nine tools pointed at this deployment.
        </p>

        <div className="field">
          <label>Tool secret -- copy this now, it will not be shown again</label>
          <div className="secret-box">{result.secret}</div>
          <button type="button" className="btn btn-secondary" onClick={handleCopy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="field">
          <label>Vapi assistant</label>
          <p className="onboard-note">{result.assistantId}</p>
        </div>

        <div className="field">
          <label>Still missing before this restaurant can take calls</label>
          <ul className="missing-list">
            <li>No phone number is connected yet -- an operator adds one as a separate step.</li>
            <li>This location is not marked live, so calls will not reach the assistant yet.</li>
          </ul>
        </div>

        <div className="onboard-actions">
          <span />
          <Link href="/dashboard" className="btn btn-primary">
            Go to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="card blueprint onboard-card">
      <Corners />
      <h2>Finish setup</h2>
      <p className="text-muted sub">
        This generates a secret for the phone tools -- the assistant 401s without it -- and
        creates the AI assistant on Vapi carrying the current hours, menu and tax rate. The secret
        is shown once, right here, and never stored anywhere but its hash.
      </p>
      {result?.error ? <p className="onboard-error">{result.error}</p> : null}
      <div className="onboard-actions">
        <span />
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleFinish}
          disabled={pending}
        >
          {pending ? "Creating…" : "Finish"}
        </button>
      </div>
    </div>
  );
}
