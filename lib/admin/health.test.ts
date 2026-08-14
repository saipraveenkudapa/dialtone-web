import { describe, expect, it } from "vitest";
import { locationHealth } from "./data";

/* The one word the operator's portfolio puts next to a restaurant.
 *
 * This used to demote any live restaurant with no forwarding_verified_at
 * to "Forwarding unproven" — permanently, and for a step most of them
 * can never take. Forwarding only exists when the restaurant has a line
 * of its own that is being pointed at us; one that simply publishes the
 * Dialtone number forwards nothing, and there is nothing for anyone to
 * verify. It is answering, and the badge has to say so, or the operator
 * learns to ignore the column.
 *
 * The same rule is drawn on the same column in
 * lib/provisioning/go-live.ts, where it decides whether the checklist
 * shows a warning or "not needed". The two must not drift apart.
 */

function location(overrides: Partial<Parameters<typeof locationHealth>[0]> = {}) {
  return {
    is_live: true,
    kill_switch_on: false,
    business_phone: null,
    forwarding_verified_at: null,
    ...overrides,
  };
}

describe("what one word describes a restaurant", () => {
  it("says not-live before anything else", () => {
    expect(locationHealth(location({ is_live: false, kill_switch_on: true }))).toBe("not-live");
  });

  it("says kill-switch for a live restaurant handing every call to a person", () => {
    expect(locationHealth(location({ kill_switch_on: true }))).toBe("kill-switch");
  });

  it("says live for a restaurant that publishes the Dialtone number and forwards nothing", () => {
    // The behaviour this changed. business_phone is null, so there is no
    // forwarding to prove, and an unset timestamp means nothing.
    expect(locationHealth(location())).toBe("live");
  });

  it("says no-forwarding only when there is a line being forwarded and nobody has proved it", () => {
    expect(locationHealth(location({ business_phone: "+15105550123" }))).toBe("no-forwarding");
  });

  it("says live once that forwarding has been proved", () => {
    expect(
      locationHealth(
        location({ business_phone: "+15105550123", forwarding_verified_at: "2026-08-01T00:00:00Z" }),
      ),
    ).toBe("live");
  });
});
