import { beforeEach, describe, expect, it, vi } from "vitest";

/** The one call row in the database, belonging to ONE location.
 *
 *  The previous mock's `eq` ignored its arguments and handed back the row
 *  no matter what was asked for, so `callIdForProvider` could have
 *  dropped the `location_id` filter, or swapped the two filters, and both
 *  tests would still have passed -- the mock could not tell the
 *  difference. Since scoping by location is the whole point of that
 *  function (the provider id arrives in a request body and must never
 *  reach another restaurant's call), the mock has to behave like the
 *  filter it is standing in for: it records every `eq` applied, and
 *  yields the row only when the filters really select it. */
const CALL_ROW = {
  id: "call-1",
  location_id: "loc-1",
  provider_call_id: "vapi-123",
} as const;

/** Every filter set applied by a query, in order, so a test can assert
 *  which columns were actually filtered on and not just what came back. */
const queries: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    const applied: Record<string, unknown> = {};
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        applied[column] = value;
        return builder;
      },
      maybeSingle: async () => {
        queries.push(applied);
        // A row is returned only if it satisfies every filter asked for
        // AND both scoping columns were filtered on at all: an omitted
        // filter matches everything, which is precisely the bug this
        // mock has to be able to see.
        const scoped =
          "location_id" in applied && "provider_call_id" in applied;
        const matches = Object.entries(applied).every(
          ([column, value]) => CALL_ROW[column as keyof typeof CALL_ROW] === value,
        );
        return {
          data: scoped && matches ? { id: CALL_ROW.id } : null,
          error: null,
        };
      },
    };
    return { from: () => builder };
  },
}));

const { callIdForProvider } = await import("./context");

describe("call linkage", () => {
  beforeEach(() => {
    queries.length = 0;
  });

  it("returns null without a provider call id", async () => {
    expect(await callIdForProvider("loc-1", undefined)).toBeNull();
    // Nothing to look up, so nothing should have been asked of the
    // database either.
    expect(queries).toHaveLength(0);
  });

  it("finds the call row for a provider call id", async () => {
    expect(await callIdForProvider("loc-1", "vapi-123")).toBe("call-1");
    expect(queries).toEqual([
      { location_id: "loc-1", provider_call_id: "vapi-123" },
    ]);
  });

  it("will not cross the tenant boundary to find a call", async () => {
    // "vapi-123" is a real provider call id -- it just belongs to another
    // restaurant. A body value must never attach a booking or an order to
    // a call that is not this location's.
    expect(await callIdForProvider("loc-2", "vapi-123")).toBeNull();
    expect(queries).toEqual([
      { location_id: "loc-2", provider_call_id: "vapi-123" },
    ]);
  });
});
