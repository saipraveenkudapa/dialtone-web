"use client";

import { useState } from "react";
import Link from "next/link";
import { Corners } from "@/components/Corners";
import type { HoursRow } from "@/lib/agent/hours";
import type { MenuCategoryWithItems } from "@/lib/data";
import type { LocationRow } from "@/lib/supabase/types";
import { BusinessStep } from "./BusinessStep";
import { HoursStep } from "./HoursStep";
import { MoneyStep } from "./MoneyStep";
import { MenuStep } from "./MenuStep";
import { FinishPanel } from "./FinishPanel";

export type OnboardingStep = "business" | "hours" | "money" | "menu" | "finish";

const STEPS: { key: Exclude<OnboardingStep, "finish">; label: string }[] = [
  { key: "business", label: "Business" },
  { key: "hours", label: "Hours" },
  { key: "money", label: "Money & service" },
  { key: "menu", label: "Menu" },
];

const RANK: Record<Exclude<OnboardingStep, "finish">, number> = {
  business: 0,
  hours: 1,
  money: 2,
  menu: 3,
};

export function OnboardingWizard({
  initialLocation,
  initialHours,
  initialMenu,
  suggestedName,
  timezones,
}: {
  initialLocation: LocationRow | null;
  initialHours: HoursRow[];
  initialMenu: MenuCategoryWithItems[];
  suggestedName: string | null;
  timezones: string[];
}) {
  const [location, setLocation] = useState(initialLocation);
  const [hours, setHours] = useState(initialHours);
  const [active, setActive] = useState<OnboardingStep>(initialLocation?.onboarding_step ?? "business");

  // Captured once, from how the page looked the moment it first loaded --
  // see app/onboarding/page.tsx's header for why this can't be a plain
  // `location?.agent_secret_hash` read instead. A location that was
  // already fully wired before this visit started shows this screen the
  // whole time; one that gets wired up during THIS visit (the Finish
  // step, below) does not flip into it mid-session, because this value
  // never changes after mount.
  const [alreadyDoneOnLoad] = useState(() => Boolean(initialLocation?.agent_secret_hash));

  const furthestRank = location ? RANK[location.onboarding_step] : -1;

  if (alreadyDoneOnLoad) {
    return (
      <div className="onboard-page">
        <div className="onboard-head">
          <div className="sidebar-brand">Dialtone</div>
        </div>
        <div className="card blueprint onboard-card">
          <Corners />
          <h2>Already set up</h2>
          <p className="text-muted sub">
            {location?.name || "This restaurant"} already finished onboarding. Its tool secret
            was shown once, at that time, and cannot be shown again -- rotate it from the
            dashboard if it&rsquo;s been lost.
          </p>
          <div className="onboard-actions">
            <span />
            <Link href="/dashboard" className="btn btn-primary">
              Go to dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="onboard-page">
      <div className="onboard-head">
        <div className="sidebar-brand">Dialtone</div>
        <p className="text-muted">
          Set up {location?.name || suggestedName || "your restaurant"} to start
          taking calls.
        </p>
      </div>

      <nav className="onboard-steps" aria-label="Onboarding steps">
        {STEPS.map((step, i) => {
          // The active step is always at least as reachable as whatever
          // is on screen right now, regardless of what's persisted --
          // covers a brand new location (furthestRank === -1) where
          // "business" is both current and the only thing to show.
          const effectiveRank = Math.max(furthestRank, RANK[active === "finish" ? "menu" : active]);
          const reachable = RANK[step.key] <= effectiveRank;
          const isCurrent = active === step.key;
          const isDone = active === "finish" || RANK[step.key] < effectiveRank;
          return (
            <button
              key={step.key}
              type="button"
              className={[
                "onboard-step",
                isCurrent ? "is-current" : "",
                isDone && !isCurrent ? "is-done" : "",
                reachable ? "is-clickable" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              disabled={!reachable}
              onClick={() => reachable && setActive(step.key)}
            >
              <span className="num">{isDone && !isCurrent ? "✓" : i + 1}</span>
              <span className="label">{step.label}</span>
            </button>
          );
        })}
      </nav>

      {active === "business" ? (
        <BusinessStep
          location={location}
          suggestedName={suggestedName}
          timezones={timezones}
          onSaved={(next) => {
            setLocation(next);
            setActive("hours");
          }}
        />
      ) : null}

      {active === "hours" ? (
        <HoursStep
          initialHours={hours}
          onSaved={(next, savedHours) => {
            setLocation(next);
            setHours(savedHours);
            setActive("money");
          }}
        />
      ) : null}

      {active === "money" ? (
        <MoneyStep
          location={location}
          onSaved={(next) => {
            setLocation(next);
            setActive("menu");
          }}
        />
      ) : null}

      {active === "menu" ? (
        <MenuStep
          locationId={location?.id ?? null}
          initialCategories={initialMenu}
          onContinue={() => setActive("finish")}
        />
      ) : null}

      {active === "finish" ? <FinishPanel /> : null}
    </div>
  );
}
