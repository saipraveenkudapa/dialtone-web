import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptLine } from "@/lib/data";

/* components/CallPlayer.tsx -- the one surface that shows what was said
 * on a call, worn by BOTH call screens: the owner's
 * app/dashboard/calls/[id] and the operator's
 * app/admin/[locationId]/calls/[callId].
 *
 * THE DEFECT THIS PINS. The component used to return early on `!src`:
 *
 *     if (!src) return <p>No recording for this call. ...</p>;
 *
 * which threw the TRANSCRIPT away along with the player, because the
 * transcript was rendered further down the same function. The two are
 * not the same answer and do not arrive together -- when a restaurant
 * has `recording_enabled` false the Vapi webhook skips storeRecording
 * entirely and still writes `transcript` with transcript_status 'ready'.
 * So every call at every restaurant that had turned recording off read
 * "No recording for this call." over a transcript sitting right there in
 * the row, on both screens. Recording off is a lawful setting, not a
 * broken call.
 *
 * Under lib/ because vitest.config.ts sets include:
 * ["lib/**\/*.test.ts"] -- the same reason and the same rendering trick
 * as lib/admin/edit-screen.test.ts and
 * lib/provisioning/go-live-panel.test.ts. CallPlayer takes TranscriptLine
 * from lib/data.ts as a TYPE import only, so nothing here drags in the
 * Supabase client.
 */

const { CallPlayer } = await import("@/components/CallPlayer");

const LINES: TranscriptLine[] = [
  { at: 1.017, who: "agent", text: "Hi. Thanks for calling Nonna Rosa." },
  { at: 5.27, who: "caller", text: "Do you do gluten free pasta?" },
];

function player(over: Partial<Parameters<typeof CallPlayer>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(CallPlayer, {
      src: "https://recordings.example.test/a.wav?sig=abc",
      lines: LINES,
      durationSeconds: 69,
      ...over,
    }),
  );
}

/** Tags dropped, entities put back, whitespace collapsed -- so the
 *  assertions are about what a reader reads. */
function prose(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("a call with a recording", () => {
  it("plays it and lists the lines", () => {
    const html = player();

    expect(html).toContain("<audio");
    expect(html).toContain("player-controls");
    expect(prose(html)).toContain("Do you do gluten free pasta?");
    // Every line is a live seek control.
    expect(html).not.toContain("disabled");
  });
});

describe("a call whose audio was never kept", () => {
  it("still shows every line of the transcript", () => {
    const html = player({ src: null });

    // The regression, stated as plainly as it can be: the words survive
    // the missing audio.
    expect(prose(html)).toContain("Hi. Thanks for calling Nonna Rosa.");
    expect(prose(html)).toContain("Do you do gluten free pasta?");
    expect(html).toContain("transcript");
  });

  it("says the recording is missing without pretending the words are", () => {
    const text = prose(player({ src: null }));

    expect(text).toContain("No recording for this call");
    // The other empty-state sentence belongs to a call with no lines and
    // must not appear over a transcript that is right there.
    expect(text).not.toContain("No transcript yet");
  });

  it("drops the player rather than offering controls that cannot work", () => {
    const html = player({ src: null });

    expect(html).not.toContain("<audio");
    expect(html).not.toContain("player-controls");
    expect(html).not.toContain("player-scrub");
    // Including the download, which would be an anchor to nothing.
    expect(prose(html)).not.toContain("Download");
  });

  it("stops each line offering a jump there is nothing to jump to", () => {
    const html = player({ src: null });

    // Still a <button> -- the whole of .transcript .line's styling hangs
    // off that selector -- but disabled, which takes it out of the focus
    // order instead of leaving a dead press behind. One per line.
    expect(html.match(/<button[^>]*disabled/g)).toHaveLength(LINES.length);
  });

  it("does not claim the transcript is following audio that is not there", () => {
    expect(prose(player())).toContain("Transcript follows the audio");
    expect(prose(player({ src: null }))).not.toContain("follows the audio");
  });

  it("marks no line as the one being spoken right now", () => {
    // `at` is pinned at 0 with no audio, and a line stamped 0.0s would
    // otherwise wear the "playing now" highlight over silence.
    const html = player({
      src: null,
      lines: [{ at: 0, who: "agent", text: "Hi." }, ...LINES],
    });

    expect(html).not.toContain("is-current");
  });
});

describe("a call with neither", () => {
  it("says both things, and offers nothing", () => {
    const text = prose(player({ src: null, lines: [] }));

    expect(text).toContain("No recording for this call");
    expect(text).toContain("No transcript yet");
  });
});
