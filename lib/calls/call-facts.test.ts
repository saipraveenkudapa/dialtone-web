import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CallCostCard, CallTimelineCard } from "@/components/CallFacts";
import { transcriptNote, transcriptState } from "@/lib/format";

/* The pieces both call screens share: the timeline card, the cost card,
 * and the words for `calls.transcript_status`.
 *
 * These were a verbatim fork between app/dashboard/calls/[id]/page.tsx
 * and app/admin/[locationId]/calls/[callId]/page.tsx -- roughly sixty
 * lines of identical computation and markup in two files, with
 * `llm_cost_cents` changing meaning underneath them in the same pass.
 * One copy, one set of tests.
 *
 * Under lib/ because vitest.config.ts's node project takes
 * lib/**\/*.test.ts; the components are server components with no event
 * handlers, so renderToStaticMarkup is the whole of what they do.
 */

/** Tags dropped, entities put back, whitespace collapsed -- so the
 *  assertions are about what a reader reads. */
function prose(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&middot;/g, "·")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const TZ = "America/New_York";

/* 6:00:00pm UTC rang, picked up 7 seconds later, 69 seconds of talking.
   The real call this screen was built against. */
const RANG = "2026-08-14T18:00:00.000Z";
const PICKED_UP = "2026-08-14T18:00:07.000Z";
const HUNG_UP = "2026-08-14T18:01:16.000Z";

function timeline(call: Parameters<typeof CallTimelineCard>[0]["call"]): string {
  return renderToStaticMarkup(createElement(CallTimelineCard, { call, timezone: TZ }));
}

describe("the transcript status, in words", () => {
  /* THE DEFECT THIS PINS. The note used to be rendered whenever
     transcript_status was anything other than 'ready'. 'pending' is the
     column's DEFAULT (20260807000100_schema.sql), so every call whose
     end-of-call report had not landed -- including one still up while an
     operator watches the page -- read CallPlayer's "No transcript yet.
     It appears once the call is processed." and then, directly under it,
     "Nothing more will arrive for this call." Both sentences on screen,
     and they cannot both be true. */
  it("says nothing extra while the report is still in flight", () => {
    expect(transcriptNote("pending")).toBeNull();
  });

  it("says nothing extra when the transcript is there, or the column is empty", () => {
    expect(transcriptNote("ready")).toBeNull();
    expect(transcriptNote(null)).toBeNull();
  });

  it("says nothing extra about a state it does not recognise", () => {
    // A value added to the enum later is not one this sentence has
    // earned the right to make a promise about.
    expect(transcriptNote("redacted")).toBeNull();
  });

  it("explains the two states where nothing more is coming", () => {
    expect(transcriptNote("failed")).toContain("could not be taken");
    expect(transcriptNote("failed")).toContain("Nothing more will arrive");
    expect(transcriptNote("skipped")).toContain("not taken for this call");
    expect(transcriptNote("skipped")).toContain("Nothing more will arrive");
  });

  it("names each state the way both screens name it", () => {
    expect(transcriptState("ready")).toBe("ready");
    expect(transcriptState("pending")).toBe("still being written");
    expect(transcriptState("failed")).toBe("could not be taken");
    expect(transcriptState("skipped")).toBe("not taken for this call");
    // A row written before the column existed.
    expect(transcriptState(null)).toBe("not recorded");
  });
});

describe("the timeline card", () => {
  it("names the three moments, with the gap between each pair", () => {
    const said = prose(
      timeline({ started_at: RANG, answered_at: PICKED_UP, ended_at: HUNG_UP }),
    );
    expect(said).toContain("Rang");
    expect(said).toContain("Answered");
    expect(said).toContain("7s ringing");
    expect(said).toContain("Ended");
    expect(said).toContain("1:09 talking");
  });

  it("renders the clock in the restaurant's timezone, not UTC", () => {
    // Timestamps are UTC in the database and nobody at a restaurant
    // thinks in it. 18:00Z is 2:00 PM in New York in August.
    const said = prose(
      timeline({ started_at: RANG, answered_at: PICKED_UP, ended_at: HUNG_UP }),
    );
    expect(said).toContain("2:00 PM");
    expect(said).not.toContain("6:00 PM");
  });

  it("has no Answered row for a call nobody picked up, and says so", () => {
    const said = prose(
      timeline({ started_at: RANG, answered_at: null, ended_at: HUNG_UP }),
    );
    expect(said).not.toContain("Answered");
    expect(said).toContain("never answered");
    // Never a talking time computed off a pick-up that did not happen.
    expect(said).not.toContain("talking");
  });

  it("has no Ended row for a call that is still up", () => {
    const said = prose(
      timeline({ started_at: RANG, answered_at: PICKED_UP, ended_at: null }),
    );
    expect(said).toContain("Rang");
    expect(said).toContain("Answered");
    expect(said).not.toContain("Ended");
  });

  /* The house classes, named. AGENTS.md's first rule is that screens are
     built from app/industry.css's system classes rather than redesigned,
     and lifting markup out of two pages into one component is exactly
     where a class quietly goes missing -- the pages would still compile,
     still render, and just stop looking like the product. */
  it("is still the house blueprint card, with the house corner marks", () => {
    const html = timeline({ started_at: RANG, answered_at: PICKED_UP, ended_at: HUNG_UP });
    expect(html).toContain('class="card blueprint admin-facts"');
    expect(html).toContain('class="card-kicker"');
    expect(html).toContain('class="fact-row"');
    expect(html).toContain('class="text-muted"');
    // Numerals are tabular everywhere in this product.
    expect(html).toContain('class="num"');
    expect(html).toContain("timeline-delta");
    // <Corners /> is what makes a .blueprint card a blueprint card.
    expect(html).toContain("corner");
  });

  it("carries the caller-facing timezone in its own kicker", () => {
    expect(prose(timeline({ started_at: RANG, answered_at: null, ended_at: null }))).toContain(
      `Timeline · ${TZ}`,
    );
  });

  it("puts a screen's own extra rows inside the same list", () => {
    // The owner's screen appends "Handed off" here; the operator's does
    // not, because its facts card carries the handoff instead.
    const html = renderToStaticMarkup(
      createElement(
        CallTimelineCard,
        { call: { started_at: RANG, answered_at: PICKED_UP, ended_at: HUNG_UP }, timezone: TZ },
        createElement(
          "div",
          { className: "fact-row" },
          createElement("dt", null, "Handed off"),
          createElement("dd", null, "an allergy question"),
        ),
      ),
    );
    // Inside the <dl>, not after it: one description list, not two.
    expect(html).toContain("an allergy question</dd></div></dl>");
  });
});

describe("the cost card", () => {
  it("shows both columns and their sum, in integer cents", () => {
    const said = prose(
      renderToStaticMarkup(
        createElement(CallCostCard, {
          call: { telephony_cost_cents: 6, llm_cost_cents: 15 },
        }),
      ),
    );
    expect(said).toContain("Telephony $0.06");
    expect(said).toContain("Agent $0.15");
    expect(said).toContain("Total $0.21");
  });

  it("is still the house blueprint card", () => {
    const html = renderToStaticMarkup(
      createElement(CallCostCard, { call: { telephony_cost_cents: 6, llm_cost_cents: 15 } }),
    );
    expect(html).toContain('class="card blueprint admin-facts"');
    expect(html).toContain('class="card-kicker"');
    // Every money figure is .num: the three rows have to line up.
    expect(html.match(/class="num"/g)).toHaveLength(3);
    expect(html).toContain("corner");
  });

  it("reads $0.00 rather than blank when a report carried no cost", () => {
    const said = prose(
      renderToStaticMarkup(
        createElement(CallCostCard, {
          call: { telephony_cost_cents: 0, llm_cost_cents: 0 },
        }),
      ),
    );
    expect(said).toContain("Telephony $0.00");
    expect(said).toContain("Total $0.00");
  });
});
