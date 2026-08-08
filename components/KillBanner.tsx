"use client";

import { useAgentStatus } from "./AgentStatus";
import { LOCATION } from "@/lib/demo";

export function KillBanner() {
  const { killOn, toggleKill } = useAgentStatus();
  if (!killOn) return null;

  return (
    <div className="kill-banner" role="status">
      <span className="blip" />
      <strong>KILL SWITCH ON</strong>
      <span className="detail">
        Every call is ringing straight through to {LOCATION.fallbackHumanNumber}.
        The agent is not answering.
      </span>
      <button type="button" className="btn" onClick={toggleKill}>
        Turn the agent back on
      </button>
    </div>
  );
}
