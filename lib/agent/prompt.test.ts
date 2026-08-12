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

  // The ambiguity answer is `agentOk({placed: false, reason:
  // "ambiguous_item", options})` -- a 200 the agent only ever sees as a
  // reply to place_order (lib/agent/orders.ts, app/api/agent/order/route.ts).
  // The instruction therefore has to sit at that call site: while it lived
  // up in the menu section, the nearest line to the actual answer was "If
  // place_order fails, take a message," so a caller who said "fries" at a
  // shop with Hand Cut Fries and Cheese Fries got a message taken instead
  // of the one question this whole path exists to ask. The second call
  // matters as much as the first -- an agent that asks which one and then
  // never re-sends the order has still not fed the kitchen.
  it("handles an ambiguous item where place_order is called, not up in the menu section", () => {
    const orderSection = prompt.slice(
      prompt.indexOf("## Taking an order"),
      prompt.indexOf("## Taking a reservation"),
    );
    expect(orderSection).toContain(
      "If place_order says more than one thing could be what they said, it names them: ask which one, then call place_order again.",
    );
    expect(orderSection).toContain("Never pick for them.");

    // And the failure line right after it must not swallow that case:
    // "If place_order fails, take a message" read as the instruction for
    // every placed:false answer is the bug itself.
    expect(orderSection).toContain(
      "If it fails otherwise, tell them honestly and take a message.",
    );
    expect(prompt).not.toContain("If place_order fails,");

    const menuSection = prompt.slice(
      prompt.indexOf("## The menu"),
      prompt.indexOf("## Taking an order"),
    );
    expect(menuSection).not.toContain("place_order");
  });

  // Dropped once as a "flavour clause". It is not flavour: the calls this
  // prompt now routes to take_message are exactly the upset-caller calls
  // -- a complaint about a past order, someone asking for a manager --
  // and with this line gone nothing stops the agent from agreeing that
  // the food was terrible while it takes the caller's number down.
  it("keeps the agent from disparaging the restaurant", () => {
    expect(prompt).toContain("Never say anything bad about the restaurant.");
  });

  it("stays short enough to keep latency down", () => {
    // The spec's tuning note: keep the prompt this length or shorter.
    //
    // Raised once, from 6000, and only by the size of one new section.
    // The prompt now has to describe cancel_reservation and
    // change_reservation: an endpoint the prompt never mentions is an
    // endpoint the agent never calls, so leaving the ceiling where it
    // was would have meant shipping two tools no caller could reach --
    // while the prompt went on listing "Book, change, or cancel a table
    // reservation" as something it can do. The other three edits in that
    // same change (dropping parking, dropping the payment link, saying
    // the total is before tax) are net-neutral to slightly shorter. Do
    // not treat this number as a budget to spend: it is a latency guard,
    // every character of it is spoken-word instructions the model reads
    // before it can answer, and the next person to need more room should
    // cut something first.
    expect(prompt.length).toBeLessThan(6500);
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
      "19d6dbc153ad28984a1ca3962da1a807879e017df24ac30232328322cf247e00",
    );
  });

  // A renamed or invented tool name in the prompt text doesn't fail to
  // compile -- it's a string. It just silently breaks every call the
  // agent makes to it at runtime. This asserts the exact set of
  // tool-shaped names (snake_case words) mentioned in the prompt matches
  // the nine tools that actually exist as routes under app/api/agent/.
  //
  // It catches the reverse too, which is the failure this product
  // actually shipped: for months the prompt listed "Book, change, or
  // cancel a table reservation" among the four things the agent can do
  // while only create_reservation existed. Because cancelling was inside
  // that list, the prompt's own "transfer anything outside these" rule
  // never fired for it, and a caller ringing to cancel met an agent that
  // believed it could help and had nothing to call. A capability named
  // in prose is not a capability; only a tool name in this set is.
  it("only mentions the nine tools that actually exist", () => {
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
        "change_reservation",
        "cancel_reservation",
        "place_order",
        "transfer_to_human",
        // Added when transferring narrowed to catering and allergies:
        // every other reason a call used to be handed to a person is now
        // a message, so a prompt that never names this tool is a prompt
        // that apologises to an upset caller and writes nothing down.
        "take_message",
      ]),
    );
  });
});
