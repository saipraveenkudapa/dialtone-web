import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Handover, handoverText } from "@/components/admin/GoLive";
import type { NewNumberHandover } from "@/lib/provisioning/go-live";

/* The handover screen, and the two files it depends on.
 *
 * This is the one screen in the product whose entire job is to not lose
 * a phone number. It is read down a phone to somebody who is standing at
 * a till, and its "Copy the whole thing" text is pasted into an email
 * that reaches a restaurant owner with nobody there to ask what it
 * means -- so what it says has to be true and has to be dialable, and
 * neither of those is something a type checker can hold.
 *
 * Rendered rather than inspected: `renderToStaticMarkup` is enough for a
 * dialog whose only state is which button was last copied, and asserting
 * on the markup an operator actually gets is the only way a claim about
 * copy can be regression-tested at all.
 */

const NANP = "+15106268819";

function view(overrides: Partial<NewNumberHandover> = {}): NewNumberHandover {
  return {
    e164: NANP,
    spoken: "+1 (510) 626-8819",
    businessPhone: "(510) 555-0142",
    carrier: "Comcast Business",
    locationName: "Nonna Rosa",
    ...overrides,
  };
}

function render(
  props: Partial<Parameters<typeof Handover>[0]> & { view?: NewNumberHandover } = {},
): string {
  return renderToStaticMarkup(
    createElement(Handover, {
      view: view(),
      fresh: true,
      onRecord: true,
      panelNumber: NANP,
      fallback: "+18787787878",
      verifiedAt: null,
      doneRef: { current: null },
      onDone: () => {},
      ...props,
    }),
  );
}

/** The rendered markup as prose: tags dropped, the entities React writes
 *  put back, whitespace collapsed. Assertions are then about what an
 *  operator reads rather than about where the tags fell. */
function prose(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the handover dialog", () => {
  it("wears the frame the mockup's only dialog wears", () => {
    // design/Dialtone.html renders its dialog as `dialog blueprint` with
    // the four registration marks. The panel that opens this one is a
    // .card.blueprint with corners; the dialog it opened was a plain
    // hairline box, so the ornament was on the container and missing
    // from the thing the operator actually reads.
    const html = render();
    expect(html).toContain('class="dialog blueprint handover-dialog"');
    for (const mark of ["corner tl", "corner tr", "corner bl", "corner br"]) {
      expect(html).toContain(mark);
    }
  });

  it("gives a landline a number a landline can dial", () => {
    // A desk-phone keypad has no + key. "*90 then the number" beside a
    // figure reading +15106268819 is an instruction nobody can carry
    // out, and this is the table an operator reads down the phone.
    const text = prose(render());
    expect(text).toContain("*90 then 5106268819");
    expect(text).toContain("*92 then 5106268819");
    expect(text).not.toContain("*90 then the number");
    // And the E.164 string survives as the copyable figure, because
    // app/api/twilio/voice/route.ts matches an inbound call on it.
    expect(render()).toContain(NANP);
  });

  it("keeps the country code in the mobile codes, which are dialled with it", () => {
    const text = prose(render());
    expect(text).toContain(`**67*${NANP}#`);
    expect(text).toContain(`**61*${NANP}#`);
  });

  it("says which table the GSM codes belong to", () => {
    // Every code in that paragraph is a 3GPP MMI code and every one of
    // them is inert on a landline. Read out to a desk-phone restaurant,
    // ##002# is dialled, the switch ignores it, and both parties believe
    // the line was cleared before new codes go on top of the old ones.
    const text = prose(render());
    expect(text).toMatch(/On a mobile, dial a code like a phone call/);
    expect(text).toContain("clears every forwarding rule on the mobile");
  });

  it("does not claim *#61# reads back every forwarding rule", () => {
    /* *#61# interrogates call-forward-no-reply alone. A restaurant that
       set the no-answer rule and silently failed to set the busy rule
       dials it, sees forwarding registered, and both parties conclude
       the arrangement is proved -- while every busy call goes to the
       carrier's voicemail instead of to Dialtone. */
    const text = prose(render());
    expect(text).toContain("*#002# reads back every forwarding rule");
    expect(text).toMatch(/\*#61# reads back the no-answer rule only/);
    expect(text).not.toContain("*#61# reads back what is set now");
  });

  it("teaches no forwarding at all to a restaurant with no line to forward", () => {
    const text = prose(render({ view: view({ businessPhone: null, carrier: null }) }));
    expect(text).toContain("Publish this number");
    expect(text).not.toContain("*90");
    expect(text).not.toContain("##002#");
  });

  it("leaves a number it cannot group exactly as Vapi reported it", () => {
    const uk = view({ e164: "+442071838750", spoken: "+442071838750" });
    const text = prose(render({ view: uk, panelNumber: "+442071838750" }));
    // No invented ten-digit form, and no "then the number" either: the
    // full string is all this screen honestly knows.
    expect(text).toContain("*90 then +442071838750");
    expect(text).not.toContain("ten digits");
  });
});

describe("what the handover promises about coming back to it", () => {
  it("offers the panel's own button when the number is on the record", () => {
    const text = prose(render({ onRecord: true }));
    expect(text).toContain("this is not your only look at it");
  });

  it("says the opposite when this dialog is the only copy of the number", () => {
    /* The blocker this exists for. `newNumber` is handed back on the
       failure branch too, and runProvision's "the update errored" branch
       leaves twilio_number NULL -- so the panel's What to tell the
       restaurant button is not even rendered, and a footer promising
       another look is how the only record of a real, billed,
       undeletable number gets dismissed with Done. */
    const text = prose(render({ onRecord: false, panelNumber: null }));
    expect(text).toContain("Only copy");
    expect(text).toContain("not written down on");
    expect(text).toContain("before you press Done");
    expect(text).not.toContain("this is not your only look at it");
  });

  it("names the different number the panel would open instead", () => {
    // runProvision's other failure: the compare-and-set lost, so the
    // column holds somebody else's minted number and the panel's button
    // opens a handover for THAT one, with no sign the number just
    // dismissed was a different, orphaned one.
    const text = prose(render({ onRecord: false, panelNumber: "+15105551111" }));
    expect(text).toContain("+15105551111");
    expect(text).toContain("which is a different number");
  });
});

describe("the text that gets pasted into an email", () => {
  it("gives the restaurant owner landline codes they can dial", () => {
    const text = handoverText(view(), "+18787787878");
    expect(text).toContain("Busy *90 then 5106268819");
    expect(text).toContain("No answer *92 then 5106268819");
    expect(text).not.toContain("then the number");
    // The mobile codes keep the country code; they are wrong without it.
    expect(text).toContain(`Busy **67*${NANP}#`);
  });

  it("falls back to the stored string where there is no shorter form to give", () => {
    const text = handoverText(view({ e164: "+442071838750" }), null);
    expect(text).toContain("Busy *90 then +442071838750");
  });

  it("tells a restaurant with no line of its own to publish the number instead", () => {
    const text = handoverText(view({ businessPhone: null }), null);
    expect(text).toContain("There is nothing to forward");
    expect(text).not.toContain("*90");
  });
});

/* ── the two shipped files this screen rests on ────────────────────── */

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("the panel's shipped surface", () => {
  it("sets the hero figure in the weight the condensed face is actually loaded at", () => {
    /* app/layout.tsx loads Barlow Condensed at 500/600/700 only. A rule
       that sets --font-heading without --font-heading-weight leaves the
       span inheriting body's 400, which matches no loaded face -- so the
       largest, most-read figure in the product renders lighter than the
       dialog title six lines above it. Every other figure in app.css
       pairs the two. */
    const css = source("../../app/app.css");
    const rule = /\.handover-number \.num \{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toContain("font-family: var(--font-heading)");
    expect(rule?.[1]).toContain("font-weight: var(--font-heading-weight)");
  });

  it("gives a one-click run longer than a platform default to finish in", () => {
    /* Route segment config, so it covers the server actions on this
       route. One press can cost three derivations at three Vapi reads
       each, an assistant provisioning and a POST /phone-number -- minutes
       against a ten-to-fifteen-second default. A request killed between
       createPhoneNumber resolving and the column write landing is the
       one failure in this feature that leaves a real, billed number on
       no screen and in no column. */
    const page = source("../../app/admin/[locationId]/page.tsx");
    const declared = /export const maxDuration = (\d+)/.exec(page);
    expect(declared).not.toBeNull();
    expect(Number(declared?.[1])).toBeGreaterThanOrEqual(120);
  });
});
