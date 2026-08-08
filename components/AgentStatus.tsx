"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type AgentStatus = {
  killOn: boolean;
  toggleKill: () => void;
};

const Ctx = createContext<AgentStatus | null>(null);

export function AgentStatusProvider({ children }: { children: ReactNode }) {
  const [killOn, setKillOn] = useState(false);
  return (
    <Ctx.Provider value={{ killOn, toggleKill: () => setKillOn((v) => !v) }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAgentStatus() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAgentStatus must be used inside AgentStatusProvider");
  return ctx;
}
