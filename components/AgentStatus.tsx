"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { RealtimePostgresUpdatePayload } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { LocationRow } from "@/lib/supabase/types";

type AgentStatus = {
  location: LocationRow;
  killOn: boolean;
  toggleKill: () => void;
  pending: boolean;
  error: string | null;
};

const Ctx = createContext<AgentStatus | null>(null);

export function AgentStatusProvider({
  location,
  children,
}: {
  location: LocationRow;
  children: ReactNode;
}) {
  const [killOn, setKillOn] = useState(location.kill_switch_on);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Take a fresh server value during render, not in an effect, so the
  // control never paints a status the database disagrees with.
  const [seenKill, setSeenKill] = useState(location.kill_switch_on);
  if (seenKill !== location.kill_switch_on) {
    setSeenKill(location.kill_switch_on);
    setKillOn(location.kill_switch_on);
  }

  const toggleKill = useCallback(async () => {
    const next = !killOn;
    setKillOn(next);
    setPending(true);
    setError(null);

    const { error: writeError } = await supabaseBrowser()
      .from("locations")
      .update({ kill_switch_on: next })
      .eq("id", location.id);

    setPending(false);

    if (writeError) {
      // The owner has to be able to trust this control absolutely, so a
      // failed write must never leave the UI claiming calls are routed to
      // a human when they are not.
      setKillOn(!next);
      setError("Could not change the agent's status. Try again.");
    }
  }, [killOn, location.id]);

  // Another manager (or the settings page) may flip this.
  useEffect(() => {
    const supabase = supabaseBrowser();
    const channel = supabase
      .channel(`location:${location.id}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "locations",
          filter: `id=eq.${location.id}`,
        },
        (payload: RealtimePostgresUpdatePayload<LocationRow>) =>
          setKillOn(payload.new.kill_switch_on),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [location.id]);

  const value = useMemo(
    () => ({ location, killOn, toggleKill: () => void toggleKill(), pending, error }),
    [location, killOn, toggleKill, pending, error],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAgentStatus() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAgentStatus must be used inside AgentStatusProvider");
  return ctx;
}
