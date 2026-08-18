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
  const prompt = buildSystemPrompt({ location });

  it("fills every placeholder", () => {
    expect(prompt).not.toMatch(/\{\{[a-z_]+\}\}/);
  });

  it("names the restaurant", () => {
    expect(prompt).toContain("Nonna Rosa");
  });

  // Was `toContain("5:00 PM to 10:30 PM")`, and that assertion was
  // certifying the defect. This assistant is static -- the phone number
  // resolves straight to an assistant id and the prompt is whatever text
  // was last pushed -- so ONE day's hours baked into it is wrong on every
  // other weekday, and it cannot honour a holiday override at all
  // (openState merges holiday_hours; a frozen string cannot). The single
  // day where being wrong is most expensive and most public -- "are you
  // open Thanksgiving?" -- is exactly the day a baked value gets wrong.
  //
  // Baking the whole WEEK instead was considered and rejected: it
  // re-creates this same defect class one notch slower, correct only
  // until an owner edits hours and nobody re-pushes the assistant. The
  // live tool already returns the only three facts the agent can say out
  // loud about hours (open_now, today, next_open), and the prompt has
  // mandated calling it in "## Closed hours" all along.
  it("points at get_hours instead of baking one day's hours into the text", () => {
    expect(prompt).toContain("Hours: call get_hours - never state hours from memory.");
    expect(prompt).not.toContain("Hours today:");
    expect(prompt).not.toContain("5:00 PM to 10:30 PM");
  });

  // F2, the half that made reservations land on the wrong day: the date
  // must be a template Vapi renders at the start of every call, never a
  // value formatted when the assistant was last pushed. The live
  // assistant was still saying "Thursday, August 13, 2026 at 10:58 AM"
  // on Friday 14 August, and it would have kept drifting one day further
  // every day.
  //
  // The exact string is asserted, not a loose shape, because every part
  // of it is load-bearing: `{{`/`}}` is what makes Vapi render it at all,
  // `date` is the LiquidJS filter, the strftime string is the filter's
  // own documented format, and the third argument is the IANA zone -- a
  // date rendered in UTC would put a 9pm Pacific caller on tomorrow.
  it("renders the date at call time, in the location's zone, not at build time", () => {
    expect(prompt).toContain(
      'Today\'s date and time: {{"now" | date: "%A, %B %d, %Y, %I:%M %p", "America/Los_Angeles"}}',
    );
    // No build-time date survived anywhere: the old line always began
    // with a weekday name straight from Intl.
    expect(prompt).not.toMatch(
      /Today's date and time: (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day/,
    );
  });

  // The consequence that makes the fix verifiable rather than merely
  // plausible: with nothing in the text derived from "when was this
  // built", the same location row must produce the same bytes forever.
  // If this ever fails, something time-dependent has crept back in --
  // which is precisely how F2 happened the first time.
  it("is deterministic: the same location row always builds the same bytes", () => {
    expect(buildSystemPrompt({ location })).toBe(buildSystemPrompt({ location }));
  });

  // The Intl.DateTimeFormat construction in buildSystemPrompt formats
  // nothing now, and it must not be deleted as dead. locations.timezone
  // has no CHECK constraint, and this is the loud, build-time failure
  // that app/admin/[locationId]/edit/page.tsx:411-421 wraps in a
  // try/catch -- "the dead-air bug the timezone <select> exists to
  // prevent". Remove it and a bad zone stops failing here and starts
  // failing silently inside Vapi's Liquid engine, mid-call, on a
  // restaurant's live number.
  it("still refuses a timezone Intl does not know, rather than shipping it to Vapi", () => {
    expect(() =>
      buildSystemPrompt({ location: { ...location, timezone: "Mars/Olympus_Mons" } }),
    ).toThrow(RangeError);
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
    //
    // Fifth, from 8800 to 8900, for the stale-date fix -- and this one
    // is different from the four above in a way that matters, because
    // what the MODEL reads did not grow the way this number did.
    //
    // The date line is now a Liquid template Vapi renders at the start
    // of each call. We measure the template (66 characters for
    // "America/Los_Angeles"); the model reads what it renders to (35,
    // "Wednesday, August 12, 2026, 7:00 PM"). So 31 of the characters
    // this assertion counts are never read by anything. The hours line
    // is a real +22 the model does read, and it is a straight swap: a
    // value that was wrong on six days out of seven, for the instruction
    // to fetch the right one.
    //
    // Measured, all three zones below: the model-visible prompt is 8768
    // characters -- constant, and under the OLD ceiling. The measured
    // string is 8799 for Los_Angeles and 8810 for the longest zones.
    // Nothing was cut to buy this room, because by the measure this
    // ceiling exists to defend -- how much the model reads before it can
    // answer -- nothing was spent. The ceiling moved to stop counting
    // template syntax as if it were instructions.
    //
    // The 100 characters also cover the other new variable: the IANA
    // zone name is interpolated into that template, so the MEASURED
    // length is now a function of the location's timezone (the rendered
    // one is not -- Vapi replaces the whole template). The fixture's
    // "America/Los_Angeles" is 19 characters; the longest zones are
    // around 30 ("America/Argentina/Buenos_Aires"). The test below pins
    // the long-zone case, so a location in Argentina cannot quietly ship
    // a prompt this fixture says is fine.
    //
    // Sixth, from 8900 to 9150, for the staff-pick warmth rule: one
    // bounded paragraph in "Taking an order" that lets the agent say, once,
    // that a dish get_menu marked as a staff pick is the one people come
    // back for -- capped at twice in a whole call, and never claiming a
    // preference of its own, since it does not eat and so never says a
    // dish is its favourite, that it loves it, or that it has tried it.
    //
    // Two vague lines were deleted in the very same change:
    //     -... A quick "nice" or "good choice" goes a long way.
    //     -... React a little too - "nice" or "good choice" is plenty.
    // -- the generic reaction cues that specific rule replaces, the ones
    // that had been losing to "Keep every reply short" for two months
    // straight, which is the whole reason this rule exists. So the
    // standing instruction above -- cut something first -- was followed.
    // It just didn't cover the whole cost: the deletion removed 105
    // characters, the new paragraph adds 400, and the difference is a net
    // +295 (8799 to 9094 for the Los_Angeles fixture) against a ceiling
    // raised by only 250. This raise is smaller than the rule that
    // required it.
    //
    // The cost is paid today, in full, on every turn of every live call,
    // by the conversational model -- exactly what the First through Fifth
    // entries above describe: every character here is spoken-word
    // instructions gpt-4o reads before it can answer. That is true right
    // now, on the one path that exists: the phone number resolves
    // straight to a static Vapi assistant, and that assistant's prompt is
    // read in full on every turn of every call it handles. This is not
    // deferred and it is not hypothetical.
    //
    // The owner accepted that cost for a specific reason, not a shrug: it
    // is small -- +295 characters on a turn that was already reading
    // roughly nine thousand of them -- and it is smaller than it could
    // have been, because two vague lines were deleted in this very same
    // change, so the net growth is less than the rule that required it.
    //
    // assistant-request is a separate budget, worth naming but not the
    // reason this was acceptable. It is untouched by this raise today
    // because assistant-request is not wired up: the static assistant's
    // prompt is whatever text was last pushed to it, not something
    // fetched and rendered inside a 7.5s assistant-request window on a
    // live call. If assistant-request is ever wired up, this stops being
    // free -- it becomes a SECOND cost stacked on the one above, the same
    // prompt fetched and rendered inside that window once per call, on
    // top of being read once per turn by the conversational model -- and
    // whoever wires it up should re-read this ceiling against that fact
    // rather than inherit 9150 as a number with no reasoning attached to
    // it.
    //
    // None of that loosens the instruction above: this is still a latency
    // guard, not a budget to spend, and the next person to need more room
    // should still cut something first.
    //
    // Seventh -- AND THIS ONE IS NOT A RAISE. The ceiling stays 9150 and
    // the prompt got shorter, which is what the six entries above have
    // been asking someone to do since the second of them.
    //
    // The product owner wanted the restaurant to choose WHICH KIND of
    // pick a dish is, from two, and the agent to say the right one. The
    // expensive way to do that is a prompt that names both phrases and
    // branches between them, and grows again for the third. What
    // happened instead: the rule stopped naming a phrase at all and now
    // speaks whatever get_menu sends, so the wording lives in the
    // payload (lib/agent/menu.ts's PICK_PHRASE) and a third kind of pick
    // later costs this number nothing whatsoever.
    //
    //     -When get_menu marks an item as a staff pick, you may say once
    //      that it is the one people come back for. At most twice in a
    //      whole call, and only about an item get_menu marked - never
    //      about anything else on the menu. ...
    //     +When get_menu gives an item a pick, you may say once that it
    //      is that pick - a phrase, not a name, so say it in the
    //      caller's language. At most twice in a whole call, never about
    //      anything else on the menu. ...
    //
    // 398 characters became 388, and the shorter line does MORE than the
    // longer one: it also settles which of the two kinds of string a
    // pick is. That mattered enough to be the reason this rule was
    // rewritten rather than extended -- an item NAME is never
    // translated, because a translated name puts the wrong food on the
    // ticket, and the never-translate rule sits close enough to capture
    // a pick by proximity and have the agent say an English phrase in
    // the middle of a Spanish sentence.
    //
    // Measured, the same three zones as the Fifth entry: the template is
    // 9042 (was 9052), the Los_Angeles fixture renders to 9084 (was
    // 9094), and the longest zones render to 9095 (was 9105). Headroom
    // under this unchanged ceiling goes from 45 characters to 55.
    expect(prompt.length).toBeLessThan(9150);
  });

  // The ceiling has to hold for every location, not just the one this
  // file happens to fixture. Since F2 the prompt carries the location's
  // IANA zone name inside the date template, so its length varies by
  // location -- and a test that only ever measures a 19-character zone
  // would stay green while a restaurant with a 30-character one shipped
  // a prompt over budget.
  it("stays under the ceiling for the longest timezone names too", () => {
    for (const timezone of [
      "America/Argentina/Buenos_Aires",
      "America/North_Dakota/New_Salem",
      "America/Indiana/Indianapolis",
    ]) {
      expect(buildSystemPrompt({ location: { ...location, timezone } }).length).toBeLessThan(
        9150,
      );
    }
  });

  it("falls back to 'not on file' when the address is empty or blank", () => {
    const empty = buildSystemPrompt({ location: { ...location, address: "" } });
    expect(empty).toContain("Address: not on file");

    const whitespace = buildSystemPrompt({ location: { ...location, address: "   " } });
    expect(whitespace).toContain("Address: not on file");
  });

  describe("warmth is earned, and the restaurant chooses the words", () => {
    it("speaks the pick get_menu sent instead of a phrase written in here", () => {
      // THE CHANGE THIS BLOCK WAS REWRITTEN FOR. The prompt used to name
      // the compliment itself -- "the one people come back for" -- so a
      // restaurant that wanted a different one needed a prompt edit, a
      // re-bless and a re-push. The wording is payload now
      // (lib/agent/menu.ts's PICK_PHRASE), and this is the assertion
      // that keeps it there: neither label may appear in this file, which
      // is what makes a third kind of pick cost the prompt nothing at
      // all.
      expect(SYSTEM_PROMPT_TEMPLATE).toContain("When get_menu gives an item a pick");
      expect(SYSTEM_PROMPT_TEMPLATE).toContain("you may say once that it is that pick");
      expect(SYSTEM_PROMPT_TEMPLATE).not.toContain("the one people come back for");
      expect(SYSTEM_PROMPT_TEMPLATE).not.toMatch(/staff pick/i);
      expect(SYSTEM_PROMPT_TEMPLATE).not.toMatch(/best seller/i);
      expect(SYSTEM_PROMPT_TEMPLATE).not.toMatch(/chef/i);
    });

    it("keeps it to the item get_menu marked, and caps it at twice", () => {
      expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/at most twice/i);
      expect(SYSTEM_PROMPT_TEMPLATE).toContain("in a whole call");
      expect(SYSTEM_PROMPT_TEMPLATE).toContain("never about anything else on the menu");
    });

    // The half of this that is easy to get wrong, and expensive: a pick
    // is the OPPOSITE kind of string from an item name. A name is a thing
    // on a ticket and is repeated exactly as get_menu gave it, because a
    // translated one puts the wrong food in front of somebody. A pick is
    // a concept, and a Spanish caller should hear the Spanish for it said
    // the way a native speaker would -- not an English phrase dropped
    // into the middle of a Spanish sentence. Two rules that point in
    // opposite directions sit four paragraphs apart in the same prompt,
    // so the pick rule has to say which of the two kinds it is in as many
    // words, or the never-translate rule captures it by proximity.
    it("says a pick is translated, where an item name never is", () => {
      const orderSection = prompt.slice(
        prompt.indexOf("## Taking an order"),
        prompt.indexOf("## Taking a reservation"),
      );
      expect(orderSection).toContain(
        "a phrase, not a name, so say it in the caller's language",
      );
      // ...and the rule it is deliberately distinguishing itself from is
      // untouched, in both the places that carry a half of it.
      expect(prompt).toContain(
        "Menu item names are never translated - say and confirm them exactly as get_menu gave them.",
      );
      expect(orderSection).toContain(
        "place_order takes only the exact English item name get_menu gave you",
      );
    });

    // Moving the wording into the payload was supposed to FREE
    // characters, not spend them: the rule stops carrying a phrase and
    // carries the shape of one instead. It replaced a 398-character line
    // with a 388-character one, and this is the ceiling that keeps the
    // 10 from being quietly re-spent by the next edit. The prompt-length
    // test below guards the whole; this guards the line that has grown
    // twice already.
    it("stays shorter than the rule that named a phrase", () => {
      const rule = SYSTEM_PROMPT_TEMPLATE.split("\n").find((line) =>
        line.startsWith("When get_menu gives an item a pick"),
      );
      expect(rule).toBeDefined();
      expect(rule!.length).toBeLessThanOrEqual(388);
    });

    it("never claims a preference it cannot have", () => {
      // She does not eat. The prompt already commits her to answering
      // truthfully when asked whether she is an AI, and a caller who hears
      // her name a favourite dish and then hears "I'm the automated
      // assistant" has caught her in something.
      expect(SYSTEM_PROMPT_TEMPLATE).not.toMatch(/my favou?rite/i);
      expect(SYSTEM_PROMPT_TEMPLATE).toMatch(/never say a dish is your favou?rite/i);
    });

    it("drops the vague reaction lines it replaces", () => {
      // These lost to "Keep every reply short" for two months. Leaving
      // them in alongside the specific rule recreates the same contest.
      expect(SYSTEM_PROMPT_TEMPLATE).not.toContain('A quick "nice" or "good choice" goes a long way');
      expect(SYSTEM_PROMPT_TEMPLATE).not.toContain('React a little too');
    });

    it("still transfers every allergy without exception", () => {
      expect(SYSTEM_PROMPT_TEMPLATE).toContain("There are no exceptions to this.");
    });
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
    // `hours_today` was removed with F2: the template no longer has a
    // slot for a day's hours to be baked into, which is the whole point.
    // `current_datetime` stays -- it is still a substitution, but what
    // gets substituted in is now a Liquid template Vapi renders per call
    // rather than a date formatted at build time.
    expect(new Set(found)).toEqual(
      new Set([
        "business_name",
        "address",
        "current_datetime",
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
  //
  // Re-blessed once, for F2, and this is that reviewed record of it. The
  // previous hash was 99042b5046cd347fd6cd11128f969a8b2cc83f3d9c0a95c20a54e2260a414cea.
  // Exactly one line of the template changed:
  //     -Hours today: {{hours_today}}
  //     +Hours: call get_hours - never state hours from memory.
  // Nothing else in the 8757 bytes moved -- the date line still reads
  // `Today's date and time: {{current_datetime}}`; what changed there is
  // what buildSystemPrompt substitutes INTO it, which is not part of this
  // template and so not part of this hash.
  //
  // Re-blessed again, for the warmth rule, and this is that reviewed
  // record of it. The previous hash was
  // 529b3a8f9cb294080b93b6f4eac54876e115f4c5ecbe256200beb3155d841de1.
  // Two lines changed, both deliberately narrowing vague guidance that
  // had been losing to "Keep every reply short" since it was written:
  //     -... A quick "nice" or "good choice" goes a long way.
  //     -Confirm each item ... React a little too - "nice" or "good choice" is plenty.
  //     +Confirm each item ... (plus the staff-pick paragraph)
  // The allergy rule and its "There are no exceptions to this." are
  // untouched, and a test above asserts that independently of this hash.
  //
  // Re-blessed a third time, for the pick labels, and this is that
  // reviewed record of it. The previous hash was
  // 28d98cd0639686fd130c4efd6cedf408c006cd410874ef3bd8a3f8c0dfb71701.
  // Exactly one line of the template changed, and only its first two
  // sentences within that line:
  //     -When get_menu marks an item as a staff pick, you may say once
  //      that it is the one people come back for. At most twice in a
  //      whole call, and only about an item get_menu marked - never
  //      about anything else on the menu.
  //     +When get_menu gives an item a pick, you may say once that it is
  //      that pick - a phrase, not a name, so say it in the caller's
  //      language. At most twice in a whole call, never about anything
  //      else on the menu.
  // The rest of that line -- "Never say a dish is your favourite, that
  // you love it, or that you have tried it. You do not eat. Say nothing
  // of the kind once an allergy has come up; that call is already
  // transferring." -- is unchanged, byte for byte, and every clause in
  // it is asserted above independently of this hash.
  //
  // What moved OUT of the template is the compliment itself: the prompt
  // no longer contains a phrase for the agent to say about a dish, only
  // the instruction to say the one get_menu sent. A restaurant changing
  // its mind between the two kinds is now a column value, not an edit to
  // this file, a re-bless of this hash and a re-push of the assistant.
  it("matches the blessed hash of the prompt text", () => {
    const hash = crypto
      .createHash("sha256")
      .update(SYSTEM_PROMPT_TEMPLATE, "utf-8")
      .digest("hex");
    expect(hash).toBe(
      "bd396c9be630aa1051a4526a983bb2def3449df9c5a9a818f063406ea1cd1560",
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
