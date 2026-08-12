import crypto from "node:crypto";
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

  // place_order answers `staff_notified: false` when the order committed
  // but the staff SMS did not go out -- and that text is the only path
  // from a phone order to a human, since the orders dashboard is still a
  // stub. Without this line the agent reads a successful `placed: true`
  // and signs off with "you're all set" on an order nobody will ever see.
  it("tells the agent not to sign off when the kitchen was not reached", () => {
    expect(prompt).toContain(
      "If it goes through but says the kitchen was not reached, do not sign off.",
    );
  });

  it("stays short enough to keep latency down", () => {
    // The spec's tuning note: keep the prompt this length or shorter.
    expect(prompt.length).toBeLessThan(6000);
  });

  it("falls back to 'not on file' when the address is empty or blank", () => {
    const empty = buildSystemPrompt({
      location: { ...location, address: "" },
      hoursToday: "5:00 PM to 10:30 PM",
      now: new Date("2026-08-13T02:00:00Z"),
    });
    expect(empty).toContain("Address: not on file");

    const whitespace = buildSystemPrompt({
      location: { ...location, address: "   " },
      hoursToday: "5:00 PM to 10:30 PM",
      now: new Date("2026-08-13T02:00:00Z"),
    });
    expect(whitespace).toContain("Address: not on file");
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

  // SYSTEM_PROMPT_TEMPLATE is verbatim product spec (see the comment on
  // its definition in prompt.ts) -- nothing else in this file catches a
  // single character being edited: dropping the whole "Things you never
  // do" section, flipping "Never guess a price" to "Guess a price," or
  // any other silent rewording would sail through every other test here.
  // This pins the template to its exact, currently-blessed bytes. If
  // this test fails, someone changed the prompt text. That may be the
  // right call -- but it must be a deliberate, reviewed decision, not an
  // accident: confirm the diff to SYSTEM_PROMPT_TEMPLATE is intended,
  // then recompute the hash below (`sha256` of the template string) and
  // update this literal as part of that same, reviewed change.
  it("matches the blessed hash of the prompt text", () => {
    const hash = crypto
      .createHash("sha256")
      .update(SYSTEM_PROMPT_TEMPLATE, "utf-8")
      .digest("hex");
    expect(hash).toBe(
      "5b80f3620334b48041cb7193e13aad4867f9ed34f6889dbbb440708ab16d0923",
    );
  });

  // A renamed or invented tool name in the prompt text doesn't fail to
  // compile -- it's a string. It just silently breaks every call the
  // agent makes to it at runtime. This asserts the exact set of
  // tool-shaped names (snake_case words) mentioned in the prompt matches
  // the six tools that actually exist as routes under app/api/agent/.
  it("only mentions the six tools that actually exist", () => {
    const withoutPlaceholders = SYSTEM_PROMPT_TEMPLATE.replace(
      /\{\{[a-z_]+\}\}/g,
      "",
    );
    const mentioned = new Set(
      [...withoutPlaceholders.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map(
        (m) => m[0],
      ),
    );
    expect(mentioned).toEqual(
      new Set([
        "get_menu",
        "get_hours",
        "check_availability",
        "create_reservation",
        "place_order",
        "transfer_to_human",
      ]),
    );
  });
});
