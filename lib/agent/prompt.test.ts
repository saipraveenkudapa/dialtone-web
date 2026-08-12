import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildGreeting, SYSTEM_PROMPT_TEMPLATE } from "./prompt";
import type { LocationRow } from "@/lib/supabase/types";

// Cast through `unknown` because this fixture only carries the fields
// buildSystemPrompt/buildGreeting actually read, not every LocationRow
// column. Typed as LocationRow (rather than `never`, as in this task's
// brief) because TypeScript's strict mode refuses to spread a value
// whose static type is `never` (TS2698) -- see the "falls back to the
// restaurant name" case below -- and this repo's `tsc --noEmit` must
// stay clean.
const location = {
  id: "l1",
  name: "Nonna Rosa",
  address: "1412 Telegraph Ave, Oakland, CA",
  timezone: "America/Los_Angeles",
  order_types: "both",
  greeting_text: "Hi, thanks for calling Nonna Rosa! What can I get for you?",
} as unknown as LocationRow;

describe("system prompt", () => {
  const prompt = buildSystemPrompt({
    location,
    hoursToday: "5:00 PM to 10:30 PM",
    now: new Date("2026-08-13T02:00:00Z"),
  });

  it("fills every placeholder", () => {
    expect(prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  it("names the restaurant", () => {
    expect(prompt).toContain("Nonna Rosa");
  });

  it("carries today's hours", () => {
    expect(prompt).toContain("5:00 PM to 10:30 PM");
  });

  it("keeps the allergy rule verbatim", () => {
    expect(prompt).toContain("There are no exceptions to this.");
  });

  it("keeps the menu rule verbatim", () => {
    expect(prompt).toContain("You do not know the menu. You never know the menu.");
  });

  it("stays short enough to keep latency down", () => {
    // The spec's tuning note: keep the prompt this length or shorter.
    expect(prompt.length).toBeLessThan(6000);
  });
});

describe("greeting", () => {
  it("uses the location's own editable line", () => {
    expect(buildGreeting(location)).toBe(
      "Hi, thanks for calling Nonna Rosa! What can I get for you?",
    );
  });

  it("falls back to the restaurant name when the field is empty", () => {
    expect(buildGreeting({ ...location, greeting_text: "" })).toBe(
      "Hi, thanks for calling Nonna Rosa! What can I get for you?",
    );
  });
});

describe("template", () => {
  it("has no stray placeholders beyond the known set", () => {
    const found = [...SYSTEM_PROMPT_TEMPLATE.matchAll(/\{\{([a-z_]+)\}\}/g)].map(
      (m) => m[1],
    );
    expect(new Set(found)).toEqual(
      new Set([
        "business_name",
        "address",
        "current_datetime",
        "hours_today",
        "takeout_delivery_settings",
      ]),
    );
  });
});
