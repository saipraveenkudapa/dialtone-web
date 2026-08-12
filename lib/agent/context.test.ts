import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { id: "call-1" }, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

const { callIdForProvider } = await import("./context");

describe("call linkage", () => {
  it("returns null without a provider call id", async () => {
    expect(await callIdForProvider("loc-1", undefined)).toBeNull();
  });

  it("finds the call row for a provider call id", async () => {
    expect(await callIdForProvider("loc-1", "vapi-123")).toBe("call-1");
  });
});
