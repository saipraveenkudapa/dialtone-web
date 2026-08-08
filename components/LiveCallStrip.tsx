"use client";

import { useEffect, useState } from "react";
import { Corners } from "./Corners";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/client";
import { primeRealtimeAuth } from "@/lib/supabase/realtime";
import { mmss } from "@/lib/format";
import type { CallRow } from "@/lib/supabase/types";

const isLive = (c: CallRow) => c.status === "ringing" || c.status === "in_progress";

export function LiveCallStrip({
  locationId,
  initialCall,
}: {
  locationId: string;
  initialCall: CallRow | null;
}) {
  const [call, setCall] = useState<CallRow | null>(initialCall);
  const [elapsed, setElapsed] = useState(0);

  const [seenInitial, setSeenInitial] = useState(initialCall);
  if (seenInitial !== initialCall) {
    setSeenInitial(initialCall);
    setCall(initialCall);
  }

  // A call starting or ending must appear here on its own — nobody is
  // going to refresh the dashboard mid-service.
  useEffect(() => {
    const supabase = supabaseBrowser();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    void (async () => {
      await primeRealtimeAuth(supabase);
      if (cancelled) return;

      channel = supabase
      .channel(`calls:${locationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "calls",
          filter: `location_id=eq.${locationId}`,
        },
        (payload: RealtimePostgresChangesPayload<CallRow>) => {
          const row = "new" in payload ? (payload.new as CallRow) : undefined;
          if (!row) return;
          setCall((current) => {
            if (isLive(row)) return row;
            // The call we were showing just ended.
            return current && current.id === row.id ? null : current;
          });
        },
      )
      .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [locationId]);

  useEffect(() => {
    if (!call) return;
    const startedAt = new Date(call.started_at).getTime();
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [call]);

  if (!call) return null;

  const where = [call.from_city, call.from_state].filter(Boolean).join(", ");

  return (
    <div className="blueprint live-strip">
      <Corners />
      <span className="blip" />
      <strong>On a call now</strong>
      <span className="detail">
        {call.from_number ?? "Unknown caller"}
        {where ? ` · ${where}` : ""}
        {call.status === "ringing" ? " · ringing" : " · in progress"}
      </span>
      <span className="elapsed" suppressHydrationWarning>
        {mmss(elapsed)}
      </span>
    </div>
  );
}
