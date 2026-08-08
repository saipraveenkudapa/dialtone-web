"use client";

import { useEffect, useState } from "react";
import { Corners } from "./Corners";
import { useAgentStatus } from "./AgentStatus";
import { LIVE_CALL } from "@/lib/demo";

const mmss = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function LiveCallStrip() {
  const { killOn } = useAgentStatus();
  const [elapsed, setElapsed] = useState(LIVE_CALL.startedSecondsAgo);

  useEffect(() => {
    if (killOn) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [killOn]);

  // No agent, no live call. Realtime will drive this once calls are wired up.
  if (killOn) return null;

  return (
    <div className="blueprint live-strip">
      <Corners />
      <span className="blip" />
      <strong>On a call now</strong>
      <span className="detail">
        {LIVE_CALL.from} · {LIVE_CALL.city} · {LIVE_CALL.doing}
      </span>
      <span className="elapsed">{mmss(elapsed)}</span>
    </div>
  );
}
