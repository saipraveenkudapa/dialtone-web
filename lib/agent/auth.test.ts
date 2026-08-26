import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

type LocationStub = { id: string; agent_secret_hash: string | null };

const configuredHash = crypto
  .createHash("sha256")
  .update("swordfish", "utf-8")
  .digest("hex");

// The mocked table mirrors the real world today: Task 2 added
// `agent_secret_hash` with no backfill, so a location that has never
// configured a secret has it set to NULL, not to some sentinel string.
// Keeping a configured location alongside it means a test that finds
// nothing can't pass simply because the whole mock is empty.
const rows: LocationStub[] = [
  { id: "loc-configured", agent_secret_hash: configuredHash },
  { id: "loc-unconfigured", agent_secret_hash: null },
];

type Filter = (row: LocationStub) => boolean;

/** Stands in for postgrest-js just far enough to make `locationForSecret`
 *  run its real query logic against an in-memory table, instead of a
 *  hand-fed response. `.eq()` reproduces the specific behaviour that
 *  makes NULL dangerous here: PostgREST reads a literal `null` comparison
 *  value as `column IS NULL` (that's the documented meaning of
 *  `col=eq.null`), not as "never matches" -- so if a future change ever
 *  let a null value reach `.eq("agent_secret_hash", ...)`, this mock
 *  would hand back the unconfigured row instead of quietly excluding it,
 *  and the test below would fail. */
function filterBuilder(filters: Filter[]) {
  return {
    eq(column: keyof LocationStub, value: string | null) {
      const test: Filter =
        value === null
          ? (row) => row[column] === null
          : (row) => row[column] === value;
      return filterBuilder([...filters, test]);
    },
    not(column: keyof LocationStub, operator: "is", value: null) {
      if (operator !== "is" || value !== null) {
        throw new Error(`mock only supports .not(column, "is", null)`);
      }
      return filterBuilder([...filters, (row) => row[column] !== null]);
    },
    async maybeSingle() {
      const matches = rows.filter((row) => filters.every((f) => f(row)));
      if (matches.length > 1) {
        return { data: null, error: new Error("more than one row matched") };
      }
      return { data: matches[0] ?? null, error: null };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => filterBuilder([]),
    }),
  }),
}));

const { hashAgentSecret, agentSecretFromRequest, locationForSecret } =
  await import("./auth");

describe("agent auth", () => {
  it("hashes a secret to stable hex", () => {
    const a = hashAgentSecret("swordfish");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAgentSecret("swordfish")).toBe(a);
  });

  it("gives different secrets different hashes", () => {
    expect(hashAgentSecret("a")).not.toBe(hashAgentSecret("b"));
  });

  it("reads the secret header", () => {
    const req = new Request("https://x.test", {
      headers: { "x-dialtone-secret": "swordfish" },
    });
    expect(agentSecretFromRequest(req)).toBe("swordfish");
  });

  it("returns null when the header is missing", () => {
    expect(agentSecretFromRequest(new Request("https://x.test"))).toBeNull();
  });

  it("never matches a location with no secret set", async () => {
    // The correct secret still finds the location that configured it --
    // proves the mocked query path actually works, so the assertions
    // below mean something.
    const correct = await locationForSecret("swordfish");
    expect(correct?.id).toBe("loc-configured");

    // No guess -- right or wrong -- may ever resolve to the location
    // whose hash is NULL. hashAgentSecret always returns a 64-char hex
    // string, never `null`, so this also confirms the guard that keeps
    // that comparison value out of `.eq()` in the first place.
    const wrongGuess = await locationForSecret("not-the-secret");
    expect(wrongGuess).toBeNull();

    const emptyGuess = await locationForSecret("");
    expect(emptyGuess).toBeNull();
  });
});
