"use client";

import { useAgentStatus } from "./AgentStatus";

export function KillBanner() {
  const { killOn, toggleKill, location, pending } = useAgentStatus();
  if (!killOn) return null;

  return (
    <div className="kill-banner" role="status">
      <span className="blip" />
      <strong>KILL SWITCH ON</strong>
      <span className="detail">
        Every call is ringing straight through to{" "}
        {location.fallback_human_number ?? "your fallback number"}. The agent is
        not answering.
      </span>
      <button type="button" className="btn" onClick={toggleKill} disabled={pending}>
        Turn the agent back on
      </button>
    </div>
  );
}
