import { beforeEach, describe, expect, it, vi } from "vitest";

/** The one call row `callIdForProvider` (lib/agent/context.ts) can find,
 *  reused across these tests exactly like context.test.ts's own fixture:
 *  scoped by both `location_id` and `provider_call_id`, so a lookup for
 *  the wrong location or the wrong provider id comes back empty instead
 *  of matching by accident. */
const CALL_ROW = {
  id: "call-1",
  location_id: "loc-1",
  provider_call_id: "vapi-123",
} as const;

/** Every `calls.update(...)` call this mock has seen, so a test can
 *  assert what was actually about to be written -- not just that
 *  logTransferOutcome resolved without throwing. */
let updateCalls: { values: Record<string, unknown>; id: string }[];
/** What the mocked `.update(...).eq(...)` resolves (or rejects) with.
 *  Each test sets this to the exact failure mode it's pinning down. */
let updateResult: () => Promise<{ error: { code: string } | null }>;

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== "calls") throw new Error(`unexpected table ${table}`);
      return {
        // Mirrors callIdForProvider's own query shape exactly, so this
        // mock exercises the real lookup logic rather than a hand-fed
        // response.
        select: () => ({
          eq: (col1: string, val1: unknown) => ({
            eq: (col2: string, val2: unknown) => ({
              maybeSingle: async () => {
                const row: Record<string, unknown> = CALL_ROW;
                const matches = row[col1] === val1 && row[col2] === val2;
                return { data: matches ? { id: CALL_ROW.id } : null, error: null };
              },
            }),
          }),
        }),
        update: (values: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            updateCalls.push({ values, id });
            return updateResult();
          },
        }),
      };
    },
  }),
}));

const { buildTransferLogUpdate, logTransferOutcome } = await import("./transfer");

describe("building the transfer log update", () => {
  it("uses the given reason", () => {
    expect(buildTransferLogUpdate("caller has a shellfish allergy")).toEqual({
      transferred_to_human: true,
      transfer_reason: "caller has a shellfish allergy",
      outcome: "transferred",
    });
  });

  it("falls back to a generic reason when none is given", () => {
    expect(buildTransferLogUpdate(undefined).transfer_reason).toBe("Agent handed off");
  });

  it("truncates a long reason to 200 characters", () => {
    const long = "x".repeat(500);
    expect(buildTransferLogUpdate(long).transfer_reason).toHaveLength(200);
  });

  // Truncating before redacting can slice a card number in half at the
  // 200-char cut, leaving a partial run too short to be recognised as
  // one -- so redaction has to see the whole reason first.
  it("redacts a card number that would otherwise straddle the truncation boundary", () => {
    const padding = "x".repeat(190);
    const reason = `${padding} 4111 1111 1111 1111`;
    const built = buildTransferLogUpdate(reason);
    expect(built.transfer_reason).not.toMatch(/\d{13,19}/);
    expect(built.transfer_reason.length).toBeLessThanOrEqual(200);
  });

  it("redacts a card number in an ordinary-length reason", () => {
    const built = buildTransferLogUpdate("card 4111 1111 1111 1111 declined, wants a manager");
    expect(built.transfer_reason).toBe("card [redacted] declined, wants a manager");
  });

  it("always marks the outcome as transferred", () => {
    expect(buildTransferLogUpdate("anything").outcome).toBe("transferred");
    expect(buildTransferLogUpdate("anything").transferred_to_human).toBe(true);
  });
});

describe("logging the transfer outcome, best effort", () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    updateCalls = [];
    updateResult = async () => ({ error: null });
    errorSpy.mockClear();
  });

  it("does nothing, and touches no table, when there is no provider call id", async () => {
    await expect(
      logTransferOutcome("loc-1", undefined, "reason"),
    ).resolves.toBeUndefined();
    expect(updateCalls).toHaveLength(0);
  });

  it("does nothing when the provider call id belongs to no known call", async () => {
    await logTransferOutcome("loc-1", "not-a-real-call", "reason");
    expect(updateCalls).toHaveLength(0);
  });

  it("will not cross the tenant boundary to log a transfer", async () => {
    // "vapi-123" is real, but for loc-2, not loc-1.
    await logTransferOutcome("loc-2", "vapi-123", "reason");
    expect(updateCalls).toHaveLength(0);
  });

  it("writes the redacted, truncated reason to the matched call", async () => {
    await logTransferOutcome("loc-1", "vapi-123", "card 4111 1111 1111 1111, upset");
    expect(updateCalls).toEqual([
      {
        id: "call-1",
        values: {
          transferred_to_human: true,
          transfer_reason: "card [redacted], upset",
          outcome: "transferred",
        },
      },
    ]);
  });

  // The critical property: this function is called from `after()`, once
  // the caller already has the transfer number. Nothing that happens to
  // the write may ever surface as a thrown error or a rejected promise.
  it("resolves, without throwing, when the update rejects outright", async () => {
    updateResult = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(
      logTransferOutcome("loc-1", "vapi-123", "reason"),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("resolves, without throwing, when the update returns an ordinary Postgrest error", async () => {
    updateResult = async () => ({ error: { code: "23505" } });
    await expect(
      logTransferOutcome("loc-1", "vapi-123", "reason"),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("logs the SQLSTATE on a Postgrest error, never the reason text", async () => {
    updateResult = async () => ({ error: { code: "23505" } });
    await logTransferOutcome("loc-1", "vapi-123", "caller's card is 4111111111111111");

    for (const call of errorSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain("4111111111111111");
      expect(serialized).not.toContain("caller's card");
    }
  });
});
