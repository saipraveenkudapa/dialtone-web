import { beforeEach, describe, expect, it, vi } from "vitest";

/* The operator console's service-role readers.
 *
 * WHAT THIS FILE IS ABOUT. Every export in lib/admin/data.ts reads with
 * the service-role key, which bypasses RLS on every table for every
 * tenant on the platform. The only thing standing between one of them
 * and an anonymous HTTP request is a currentPlatformAdmin() call, and
 * two of the three did not have one -- they leaned on
 * app/admin/layout.tsx's notFound().
 *
 * A LAYOUT IS NOT AN AUTHORIZATION BOUNDARY. Next does not re-render a
 * layout segment that the requester's own Next-Router-State-Tree header
 * claims to already hold (renderComponentsOnThisLevel in
 * next/dist/server/app-render/walk-tree-with-flight-router-state.js),
 * and that header's SHAPE is validated while its correspondence to the
 * requested URL is not. Measured against the running dev server before
 * this fix: a curl with no cookies, `RSC: 1` and a hand-written state
 * tree for /admin returned HTTP 200 and 9,139 bytes of rendered
 * portfolio -- restaurant names, org names, timezones, both location
 * uuids, live state and the spend column -- with no "Sign out" and no
 * `admin-who` anywhere in the payload, which is the proof AdminLayout
 * never ran.
 *
 * So the assertions here are deliberately about TWO things per reader:
 * that the answer is empty, and that supabaseAdmin() was never
 * constructed. The second is the one that matters. A gate that refuses
 * after the query has already gone out has not refused anything.
 */

const currentPlatformAdmin = vi.fn();
vi.mock("@/lib/admin/auth", () => ({
  currentPlatformAdmin: () => currentPlatformAdmin(),
}));

/* The service-role client, counted. Nothing below asserts on its rows
   without first asserting on this call count. */
const serviceRoleClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => serviceRoleClient() }));

/* lib/admin/data.ts takes startOfDayUtc from lib/data.ts, which reaches
   next/headers through the session client. Nothing on this path uses
   it, so the module is stubbed at that seam rather than the whole of
   lib/data. */
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => {
    throw new Error("the session client has no business on this path");
  },
}));

const { getAdminCall, getAdminLocation, getPortfolio } = await import("@/lib/admin/data");

const LOCATION = "a10c0000-0000-0000-0000-00000000000a";
const RIVAL = "b10c0000-0000-0000-0000-00000000000b";
const CALL = "cc100000-0000-0000-0000-0000000000cc";

const STAFF = { userId: "11111111-1111-1111-1111-111111111111", email: "ops@dialtone.test", note: null };

/** Every filter the fake PostgREST was asked for, so a test can assert
 *  what actually went to the database rather than what came back. */
type Statement = { table: string; method: string; args: unknown[] };

/** A PostgREST stand-in. Every builder method records itself and returns
 *  the chain; the chain is thenable, so `await`ing it anywhere in the
 *  product resolves to the rows this table was seeded with. */
function fakeSupabase(rows: Record<string, unknown>) {
  const statements: Statement[] = [];

  const from = (table: string) => {
    const result = { data: rows[table] ?? [], error: null };
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gte", "order", "limit", "not", "in"]) {
      chain[method] = (...args: unknown[]) => {
        statements.push({ table, method, args });
        return chain;
      };
    }
    chain.maybeSingle = () => {
      statements.push({ table, method: "maybeSingle", args: [] });
      const single = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
      return Promise.resolve({ data: single, error: null });
    };
    chain.then = (ok: (v: unknown) => unknown, no?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(ok, no);
    return chain;
  };

  const createSignedUrl = vi.fn(async () => ({
    data: { signedUrl: "https://recordings.example.test/a.wav?sig=abc" },
    error: null,
  }));

  return {
    client: { from, storage: { from: () => ({ createSignedUrl }) } },
    statements,
    createSignedUrl,
  };
}

function seed(rows: Record<string, unknown>) {
  const fake = fakeSupabase(rows);
  serviceRoleClient.mockReturnValue(fake.client);
  return fake;
}

const A_LOCATION = {
  id: LOCATION,
  name: "Nonna Rosa",
  timezone: "America/New_York",
  is_live: true,
  kill_switch_on: false,
  business_phone: null,
  forwarding_verified_at: null,
  organizations: { name: "Rosa Group", plan: "pro" },
};

beforeEach(() => {
  vi.clearAllMocks();
  currentPlatformAdmin.mockResolvedValue(STAFF);
});

describe("getPortfolio", () => {
  it("reads nothing at all when the caller is not operator staff", async () => {
    currentPlatformAdmin.mockResolvedValue(null);
    seed({ locations: [A_LOCATION] });

    expect(await getPortfolio()).toEqual([]);
    // The whole assertion: the key was never even constructed, so no
    // query left this process.
    expect(serviceRoleClient).not.toHaveBeenCalled();
  });

  it("is the platform's whole portfolio for staff", async () => {
    seed({ locations: [A_LOCATION], calls: [], orders: [], bookings: [] });

    const rows = await getPortfolio();
    expect(rows).toHaveLength(1);
    expect(rows[0].location.name).toBe("Nonna Rosa");
    expect(rows[0].location.org_name).toBe("Rosa Group");
    expect(rows[0].health).toBe("live");
  });
});

describe("getAdminLocation", () => {
  it("reads nothing at all when the caller is not operator staff", async () => {
    currentPlatformAdmin.mockResolvedValue(null);
    seed({ locations: [A_LOCATION] });

    expect(await getAdminLocation(LOCATION)).toBeNull();
    expect(serviceRoleClient).not.toHaveBeenCalled();
  });

  it("never hands PostgREST an id that is not a uuid", async () => {
    seed({ locations: [A_LOCATION] });

    // Thirty-six dashes is the string the old /^[0-9a-f-]{36}$/i test
    // accepted, and it reaches Postgres as a malformed uuid cast.
    expect(await getAdminLocation("-".repeat(36))).toBeNull();
    expect(await getAdminLocation("not-a-uuid")).toBeNull();
    expect(await getAdminLocation(`${LOCATION}' or '1'='1`)).toBeNull();
    expect(serviceRoleClient).not.toHaveBeenCalled();
  });

  it("scopes every history query to the one restaurant asked for", async () => {
    const fake = seed({
      locations: [A_LOCATION],
      calls: [{ id: CALL, location_id: LOCATION, from_number: "+14093036272" }],
      orders: [],
      menu_items: [],
    });

    const data = await getAdminLocation(LOCATION);
    expect(data?.location.name).toBe("Nonna Rosa");
    expect(data?.calls).toHaveLength(1);

    // Twenty callers' phone numbers come back from `calls`; the tenant
    // boundary on them is this eq, in the WHERE clause and not after the
    // fact.
    for (const table of ["locations", "calls", "orders", "menu_items"]) {
      const scoped = fake.statements.filter(
        (s) => s.table === table && s.method === "eq" && s.args[1] === LOCATION,
      );
      expect(scoped.length, `${table} is scoped to the location`).toBeGreaterThan(0);
    }
    expect(fake.statements.some((s) => s.args.includes(RIVAL))).toBe(false);
  });

  it("is null, not a throw, for a restaurant that does not exist", async () => {
    seed({ locations: [], calls: [], orders: [], menu_items: [] });
    expect(await getAdminLocation(RIVAL)).toBeNull();
  });
});

describe("getAdminCall", () => {
  it("reads nothing at all when the caller is not operator staff", async () => {
    currentPlatformAdmin.mockResolvedValue(null);
    seed({ locations: [A_LOCATION] });

    expect(await getAdminCall(LOCATION, CALL)).toBeNull();
    expect(serviceRoleClient).not.toHaveBeenCalled();
  });

  it("never hands PostgREST an id that is not a uuid, on either argument", async () => {
    seed({ locations: [A_LOCATION] });

    expect(await getAdminCall("-".repeat(36), CALL)).toBeNull();
    expect(await getAdminCall(LOCATION, "-".repeat(36))).toBeNull();
    expect(serviceRoleClient).not.toHaveBeenCalled();
  });

  it("will not read a call across the tenant boundary", async () => {
    const fake = seed({
      locations: [A_LOCATION],
      calls: [{ id: CALL, location_id: LOCATION, recording_path: null }],
    });

    await getAdminCall(LOCATION, CALL);

    // Both ids in the WHERE clause: a callId belonging to another
    // restaurant comes back as no row rather than as a row that is then
    // checked.
    const onCalls = fake.statements.filter((s) => s.table === "calls" && s.method === "eq");
    expect(onCalls.map((s) => s.args)).toEqual(
      expect.arrayContaining([
        ["id", CALL],
        ["location_id", LOCATION],
      ]),
    );
  });

  it("refuses to sign a recording path that points outside its own location", async () => {
    // The service role bypasses storage RLS too, so the tenant boundary
    // the owner's screen gets from a policy has to be asserted in the
    // open here.
    const fake = seed({
      locations: [A_LOCATION],
      calls: [{ id: CALL, location_id: LOCATION, recording_path: `${RIVAL}/${CALL}.wav` }],
    });

    const data = await getAdminCall(LOCATION, CALL);
    expect(data?.recordingUrl).toBeNull();
    expect(fake.createSignedUrl).not.toHaveBeenCalled();
  });

  it("signs the recording that really is this location's", async () => {
    const fake = seed({
      locations: [A_LOCATION],
      calls: [{ id: CALL, location_id: LOCATION, recording_path: `${LOCATION}/${CALL}.wav` }],
    });

    const data = await getAdminCall(LOCATION, CALL);
    expect(data?.recordingUrl).toContain("sig=abc");
    // Short-lived, and the same 300 seconds the owner's link is signed
    // with -- a longer one would make the console the easiest place to
    // lift a recording from.
    expect(fake.createSignedUrl).toHaveBeenCalledWith(`${LOCATION}/${CALL}.wav`, 300);
  });
});
