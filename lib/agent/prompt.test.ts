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

  // The owner's explicit ask: full suggestive selling (sides, drinks,
  // dessert, the bigger size, pairings), but bounded so it cannot become
  // the thing that makes this agent chatty or unsafe. These four
  // constraints are the ones that make it safe to ship: the offer names
  // only what get_menu returned on this call, it never names a sold-out
  // item, it happens at most once per call (no re-pitching after a no),
  // and it is switched off entirely once an allergy has come up, since
  // that call is already headed to a human.
  it("bounds suggestive selling to this call's menu, said once, and never after an allergy", () => {
    const orderSection = prompt.slice(
      prompt.indexOf("## Taking an order"),
      prompt.indexOf("## Taking a reservation"),
    );
    expect(orderSection).toContain("Only offer something get_menu returned this call");
    expect(orderSection).toContain("never anything sold out");
    expect(orderSection).toContain("drop it - never bring it up again this call");
    expect(orderSection).toContain(
      "Never offer anything once an allergy has come up; that call is already transferring.",
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

  // The owner's ask: auto-detect whatever the caller speaks and answer in
  // it, without asking or announcing the switch, and without it reading as
  // English translated into another language -- native numbers, money,
  // idiom and call-closing phrasing, and a fallback to the confident
  // language rather than guessing at one it isn't.
  it("answers in whatever language the caller speaks, natively rather than translated", () => {
    const languageSection = prompt.slice(
      prompt.indexOf("## Language"),
      prompt.indexOf("## What you can do"),
    );
    expect(languageSection).toContain("Answer in whatever language the caller opens with");
    expect(languageSection).toContain("not like English translated");
    expect(languageSection).toContain(
      "never as digits with a spoken decimal point",
    );
    expect(languageSection).toContain(
      "stay in the language you are confident in rather than guess",
    );
    // The half of the menu-name rule that only "## Language" can carry:
    // what the agent SAYS out loud. The other half of that sentence (what
    // may reach place_order) was cut from here as duplication -- it is
    // asserted in full at the call site by the test below -- so this is
    // what stops a caller hearing "los ñoquis con mantequilla dorada"
    // for an item the kitchen prints as Gnocchi, Brown Butter.
    expect(languageSection).toContain(
      "Menu item names are never translated - say and confirm them exactly as get_menu gave them.",
    );
  });

  // Menu item names are never translated (the owner's second decision: no
  // translated-name data entry), and the matcher in lib/agent/orders.ts
  // compares spoken words against the menu's own English names -- it is
  // never rewritten to understand another language. This is the one thing
  // that makes ordering work in any language without touching that
  // matcher: whatever language is being spoken, only the exact name
  // get_menu returned may ever reach place_order. This has to sit right at
  // the place_order call site, the same reasoning as the ambiguous-item
  // test above -- an instruction back up in "## Language" alone is exactly
  // as easy to lose sight of as the ambiguity rule was in "## The menu".
  it("keeps ordering language-proof: only get_menu's own name reaches place_order", () => {
    const orderSection = prompt.slice(
      prompt.indexOf("## Taking an order"),
      prompt.indexOf("## Taking a reservation"),
    );
    expect(orderSection).toContain(
      "Whatever language you're speaking, place_order takes only the exact English item name get_menu gave you",
    );
  });

  // Dropped once as a "flavour clause". It is not flavour: the calls this
  // prompt now routes to take_message are exactly the upset-caller calls
  // -- a complaint about a past order, someone asking for a manager --
  // and with this line gone nothing stops the agent from agreeing that
  // the food was terrible while it takes the caller's number down.
  // The other half of the owner's ask: sound glad the person called, not
  // merely correct. This is deliberately in "How you sound", not "Taking
  // an order" -- it's the register for the whole call, not just the
  // sales moment.
  it("tells the agent to sound glad to hear from callers, not just transact", () => {
    const soundSection = prompt.slice(
      prompt.indexOf("## How you sound"),
      prompt.indexOf("## What you can do"),
    );
    expect(soundSection).toContain("Thank them for calling");
    expect(soundSection).toContain("react to what they say");
  });

  // get_menu now returns each item's ingredients where a person put them
  // in the description (lib/agent/menu.ts). This is the whole reason that
  // is safe: a dish may be DESCRIBED -- good selling, and what a caller
  // asking "what's in the cacio e pepe?" out of curiosity actually wants
  // -- while an allergy question is still not answered by anybody but a
  // human. The two failure modes that would put a restaurant on the hook
  // are (a) the agent reading the description out as though it were the
  // complete contents of the dish, and (b) the agent finishing the
  // description it had already started when the caller says "because I'm
  // coeliac" halfway through. Both are pinned here, in the section that
  // does the describing, so neither can be lost to a reword of the menu
  // rules alone.
  it("lets a dish be described without letting the description become an allergy answer", () => {
    const menuSection = prompt.slice(
      prompt.indexOf("## The menu"),
      prompt.indexOf("## Taking an order"),
    );
    expect(menuSection).toContain(
      "When get_menu gives an item ingredients and a caller asks about a dish out of plain interest, tell them what it generally comes with.",
    );
    expect(menuSection).toContain("It sells the dish, so do it.");
    expect(menuSection).toContain(
      "That is what the kitchen puts on it, not everything that is in it.",
    );
    expect(menuSection).toContain("Never call it the whole list");
    expect(menuSection).toContain(
      "never let it stand as an answer to whether something is in a dish or not",
    );
    expect(menuSection).toContain(
      "If an allergy, an intolerance, celiac, or any health reason comes up, even halfway through describing a dish, stop and follow the allergy rule below.",
    );
  });

  // And the rule it hands off to is untouched, byte for byte. Describing
  // a dish is an addition ALONGSIDE this, never a softening of it: the
  // agent still does not answer, does not guess, does not read
  // ingredients, and transfers -- with no exceptions.
  it("leaves the allergy hard rule exactly as it was", () => {
    const allergySection = prompt.slice(
      prompt.indexOf("## Allergies - hard rule"),
      prompt.indexOf("## When to transfer to a human"),
    );
    expect(allergySection).toContain(
      "If anyone mentions an allergy, an intolerance, celiac, or asks what is in a dish for a health reason, stop.",
    );
    expect(allergySection).toContain(
      "Do not answer. Do not guess. Do not read ingredients.",
    );
    expect(allergySection).toContain(
      'Say: "I want to make sure you get that exactly right - let me put you through to someone."',
    );
    expect(allergySection).toContain(
      "Then transfer immediately. There are no exceptions to this.",
    );
  });

  it("keeps the agent from disparaging the restaurant", () => {
    expect(prompt).toContain("Never say anything bad about the restaurant.");
  });

  it("stays short enough to keep latency down", () => {
    // The spec's tuning note: keep the prompt this length or shorter.
    //
    // Raised twice now.
    //
    // First, from 6000, and only by the size of one new section: the
    // prompt now had to describe cancel_reservation and
    // change_reservation, since an endpoint the prompt never mentions is
    // an endpoint the agent never calls, and leaving the ceiling where
    // it was would have meant shipping two tools no caller could reach
    // while the prompt still listed "Book, change, or cancel a table
    // reservation" as something it can do.
    //
    // Second, from 6500 to 7500, for the owner's explicit call to add
    // sales behaviour: warmer, more reactive tone in "How you sound",
    // and one bounded suggestive-sell offer in "Taking an order" (a
    // side, a drink, a dessert, the bigger size, or a pairing -- named
    // only from what get_menu returned this call, offered once, dropped
    // for the rest of the call on anything but a yes). This is exactly
    // the "cut something first" test warns against doing lightly, so it
    // was not done lightly: the two additions were trimmed for length
    // before this ceiling moved at all, and the suggestive-sell offer is
    // capped at one attempt per call specifically so it costs one extra
    // turn on an order call, not one extra turn per item.
    //
    // Third, from 7500 to 8500, for auto-detecting and answering in
    // whatever language the caller speaks (the owner's explicit ask: "I
    // don't want the customer to notice the agent was a foreigner").
    // The new "## Language" section is what makes that native rather
    // than translated -- natural numbers, money and phone numbers,
    // local idiom instead of literal English, a fallback to the
    // confident language rather than broken output -- and a second,
    // short reinforcement sits at the place_order call site itself:
    // whatever language is being spoken, only the exact English name
    // get_menu gave an item may ever reach place_order, never a
    // translation of it, since that tool has no other way to know which
    // menu row was meant. Both were trimmed for length before this
    // ceiling moved. Do not treat this number as a budget to spend: it
    // is a latency guard, every character of it is spoken-word
    // instructions the model reads before it can answer, and the next
    // person to need more room should cut something first.
    //
    // Fourth, from 8500 to 8800, for letting the agent describe a dish:
    // get_menu now carries each item's ingredients where a person wrote
    // them down, and three short paragraphs in "## The menu" say what
    // may be done with them -- say what a dish generally comes with when
    // a caller asks out of interest, never present that as everything
    // that is in it, and stop dead the moment a health reason is
    // mentioned. Something was cut first, as this note demands: the
    // "## Language" section used to end by repeating that only the exact
    // name get_menu gave an item may reach place_order, which is said
    // again, in full, at the place_order call site itself -- and the
    // "handles an ambiguous item where place_order is called" test above
    // is the standing argument that the call site is the copy that does
    // the work. The half of that line that is NOT about place_order --
    // never translate a menu item name when you say it out loud -- stays
    // in "## Language", and is asserted below.
    expect(prompt.length).toBeLessThan(8800);
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
      "99042b5046cd347fd6cd11128f969a8b2cc83f3d9c0a95c20a54e2260a414cea",
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
