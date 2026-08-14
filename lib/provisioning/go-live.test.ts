import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantSecretWriteError } from "@/lib/provisioning/assistant";
import { NoNumberInAreaCodeError, NumberOutcomeUnknownError } from "@/lib/vapi/phone-numbers";
import type { AttachableNumber, GoLiveFacts } from "./go-live";
import type { VapiPhoneNumber } from "@/lib/vapi/phone-numbers";

/* Whether a restaurant can be turned on, and who is allowed to turn it.
 *
 * Two separate concerns live in this file because they are the two ways
 * this feature can hurt somebody:
 *
 *   1. The checklist. Getting it wrong in the permissive direction puts
 *      a restaurant on the phone that cannot transfer a caller asking
 *      about an allergy, or points a number at an assistant that no
 *      longer exists. Getting it wrong in the strict direction strands
 *      an operator on a page whose only button is greyed out.
 *   2. The gate. Every export here runs with the service-role key, which
 *      bypasses RLS on every table for every tenant, and each one is a
 *      live HTTP endpoint the moment it compiles -- a "use server"
 *      action id can be POSTed to without ever loading /admin.
 *
 * The cross-tenant tests are the sharp end of both: one restaurant must
 * not be able to take another's phone number, and the defence must be a
 * set this module rebuilds for itself rather than anything the browser
 * was handed.
 */

const currentPlatformAdmin = vi.fn();
vi.mock("@/lib/admin/auth", () => ({
  currentPlatformAdmin: () => currentPlatformAdmin(),
}));

const serviceRoleClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => serviceRoleClient() }));

const findAssistantForLocation = vi.fn();
const getAssistant = vi.fn();
const tagAssistantForLocation = vi.fn();
const deleteAssistant = vi.fn();
vi.mock("@/lib/vapi/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vapi/provision")>()),
  findAssistantForLocation: (...args: unknown[]) => findAssistantForLocation(...args),
  getAssistant: (...args: unknown[]) => getAssistant(...args),
  tagAssistantForLocation: (...args: unknown[]) => tagAssistantForLocation(...args),
  deleteAssistant: (...args: unknown[]) => deleteAssistant(...args),
}));

const listPhoneNumbers = vi.fn();
const bindPhoneNumber = vi.fn();
const createPhoneNumber = vi.fn();
/* Partial, for the same reason the assistant mock below is: NoNumberInAreaCodeError
   has to be the REAL class or `err instanceof NoNumberInAreaCodeError` in
   go-live.ts is testing a different constructor than the one the product
   throws -- and that branch is the one that tells an operator to try a
   neighbouring area code rather than to go and debug a deployment.
   areaCodeOf and isAreaCode come through unmocked for the same reason
   spokenNumber does: they are the rule under test, not a collaborator. */
vi.mock("@/lib/vapi/phone-numbers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vapi/phone-numbers")>()),
  listPhoneNumbers: (...args: unknown[]) => listPhoneNumbers(...args),
  bindPhoneNumber: (...args: unknown[]) => bindPhoneNumber(...args),
  createPhoneNumber: (...args: unknown[]) => createPhoneNumber(...args),
}));

const provisionAssistantForLocation = vi.fn();
/* Partial, not whole: AssistantSecretWriteError has to be the REAL class
   or `err instanceof AssistantSecretWriteError` in go-live.ts is testing
   a different constructor than the one the product throws -- and that
   branch is the one that deletes an assistant off Vapi. */
vi.mock("@/lib/provisioning/assistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provisioning/assistant")>()),
  provisionAssistantForLocation: (...args: unknown[]) => provisionAssistantForLocation(...args),
}));

const {
  CLAIMANT_LIMIT,
  attachNumberToLocation,
  blockersOf,
  buildChecks,
  classifyNumbers,
  getGoLiveState,
  makeItLive,
  planNumber,
  provisionNumberForLocation,
  repairAssistant,
  setFallbackNumber,
  setForwardingVerified,
  setKillSwitch,
  setLocationLive,
  spokenNumber,
} = await import("./go-live");

const STAFF = { userId: "99999999-9999-9999-9999-999999999999", email: "admin@dialtone.test", note: "operator" };
const OWNER_ID = "11111111-1111-1111-1111-111111111111";

const NONNA = "a10c0000-0000-0000-0000-00000000000a";
const MARTY = "d7be1400-7c38-4933-a248-407ff339cd73";

/* ── the checklist ─────────────────────────────────────────────────── */

const ASSISTANT = "aaaaaaaa-0000-0000-0000-000000000001";

const BOUND: VapiPhoneNumber = {
  id: "62aa9658-4974-45e2-aff1-e640e0aa7e15",
  number: "+15106268819",
  name: "Nonna Rosa",
  provider: "vapi",
  assistantId: ASSISTANT,
  status: "active",
};

/** A restaurant with nothing wrong with it, so each test can break
 *  exactly one thing and name it. */
function facts(
  overrides: Partial<Omit<GoLiveFacts, "location">> & {
    location?: Partial<GoLiveFacts["location"]>;
  } = {},
): GoLiveFacts {
  const { location, ...rest } = overrides;
  return {
    location: {
      twilio_number: "+15106268819",
      fallback_human_number: "+18787787878",
      vapi_assistant_id: ASSISTANT,
      business_phone: null,
      forwarding_verified_at: null,
      ...location,
    },
    // A restaurant whose assistant can actually authenticate its tool
    // calls. lib/agent/auth.ts matches on this column, so a fixture
    // without it is a restaurant whose agent 401s on every menu read.
    secretOnFile: true,
    vapiReachable: true,
    taggedAssistantId: ASSISTANT,
    assistantOnFileExists: true,
    boundNumber: BOUND,
    boundNumberBlockedReason: null,
    assistantNumber: null,
    menuItems: 12,
    hoursRows: 7,
    ...rest,
  };
}

function status(list: ReturnType<typeof buildChecks>, key: string) {
  return list.find((c) => c.key === key)?.status;
}

describe("the go-live checklist", () => {
  it("clears a restaurant whose assistant, number and fallback all check out", () => {
    const checks = buildChecks(facts());
    expect(blockersOf(checks)).toEqual([]);
    expect(status(checks, "assistant")).toBe("ok");
    expect(status(checks, "number")).toBe("ok");
    expect(status(checks, "fallback")).toBe("ok");
  });

  it("blocks on a missing fallback number, because transfers and the kill switch dial it", () => {
    const checks = buildChecks(facts({ location: { fallback_human_number: null } }));
    expect(status(checks, "fallback")).toBe("blocked");
    expect(blockersOf(checks)).toContain("fallback");
  });

  it("blocks when the record has lost its assistant, even though Vapi still has one", () => {
    // The drift this feature exists to repair: an assistant answering
    // calls and a column that forgot its id.
    const checks = buildChecks(
      facts({ location: { vapi_assistant_id: null }, taggedAssistantId: ASSISTANT }),
    );
    expect(status(checks, "assistant")).toBe("blocked");
    expect(checks.find((c) => c.key === "assistant")?.note).toMatch(/lost track of it/);
  });

  it("blocks when Vapi has no assistant for the id on file", () => {
    const checks = buildChecks(facts({ taggedAssistantId: null, assistantOnFileExists: false }));
    expect(status(checks, "assistant")).toBe("blocked");
    expect(checks.find((c) => c.key === "assistant")?.note).toMatch(/not on the Vapi account/);
  });

  it("tells 'lost its label' apart from 'gone', because one repair forks a live assistant", () => {
    // The assistant this record names IS on Vapi and answering calls;
    // only metadata.dialtone_location_id has been rubbed off, which is
    // what cloning or restoring one in the Vapi dashboard does. The tag
    // search cannot see it, and reporting that as "gone" sent Repair
    // down the build path: a SECOND assistant, and agent_secret_hash
    // rotated out from under the one the phone number still rings.
    const check = buildChecks(
      facts({ taggedAssistantId: null, assistantOnFileExists: true }),
    ).find((c) => c.key === "assistant");

    expect(check?.status).toBe("blocked");
    expect(check?.note).toMatch(/no longer labelled/);
    // The promise the button has to keep in this state.
    expect(check?.note).toMatch(/no rebuild/);
    expect(check?.note).not.toMatch(/rotates/);
  });

  it("blocks an assistant with no tool secret on file, instead of going green over one that 401s", () => {
    // The state this could not see at all. Vapi holds the assistant, the
    // column names it, and lib/agent/auth.ts has no digest to match its
    // tool calls against -- so it answers, greets the caller, and then
    // cannot read the menu, take the order or transfer. Six-for-six
    // green over that is how the one-click ships a restaurant that
    // sounds live and is not.
    const checks = buildChecks(facts({ secretOnFile: false }));
    expect(status(checks, "assistant")).toBe("blocked");
    expect(checks.find((c) => c.key === "assistant")?.note).toMatch(/tool secret/);
    expect(blockersOf(checks)).toContain("assistant");
  });

  it("still says there is no assistant at all when there is neither an assistant nor a secret", () => {
    // A brand-new restaurant has neither, and "there is no assistant
    // yet" is the sentence with somewhere to go.
    const checks = buildChecks(
      facts({
        secretOnFile: false,
        location: { vapi_assistant_id: null },
        taggedAssistantId: null,
        assistantOnFileExists: null,
      }),
    );
    expect(status(checks, "assistant")).toBe("blocked");
    expect(checks.find((c) => c.key === "assistant")?.note).toMatch(/no assistant yet/);
  });

  it("says the assistant is gone, not that its secret is missing, when Vapi has neither", () => {
    // The secret block above is about an assistant Vapi actually has.
    // A record naming one that is gone gets the truer sentence, and the
    // repair behind it mints a secret anyway.
    const checks = buildChecks(
      facts({ secretOnFile: false, taggedAssistantId: null, assistantOnFileExists: false }),
    );
    expect(status(checks, "assistant")).toBe("blocked");
    expect(checks.find((c) => c.key === "assistant")?.note).toMatch(/not on the Vapi account/);
  });

  it("blocks when Vapi points the number at somebody else's assistant", () => {
    const checks = buildChecks(
      facts({ boundNumber: { ...BOUND, assistantId: "bbbbbbbb-0000-0000-0000-000000000002" } }),
    );
    expect(status(checks, "number")).toBe("blocked");
    expect(checks.find((c) => c.key === "number")?.note).toMatch(/not pointing it at/);
  });

  it("blocks when the number on file is not on the Vapi account at all", () => {
    const checks = buildChecks(facts({ boundNumber: null }));
    expect(status(checks, "number")).toBe("blocked");
  });

  it("never says 'attach it again' about a number classifyNumbers refuses to attach", () => {
    // Two restaurants claim this number -- the column here, Vapi's
    // binding there -- so classifyNumbers marks it unattachable and
    // attachNumberToLocation refuses it. The note used to say "Attach it
    // again", pointing at a button that cannot be pressed, with nothing
    // in the product able to clear either claim.
    const check = buildChecks(
      facts({
        boundNumber: { ...BOUND, assistantId: "bbbbbbbb-0000-0000-0000-000000000002" },
        boundNumberBlockedReason: "claimed by both Marty's and Nonna Rosa",
      }),
    ).find((c) => c.key === "number");

    expect(check?.status).toBe("blocked");
    expect(check?.note).not.toMatch(/Attach it again\./);
    expect(check?.note).toMatch(/claimed by both/);
    // Names somewhere the operator can actually go.
    expect(check?.note).toMatch(/Vapi dashboard/);
  });

  it("does not say 'no number yet' while a number is already ringing this assistant", () => {
    // The other side of the same conflict: this restaurant's assistant
    // is the one answering on the number, and only its column is empty.
    const check = buildChecks(
      facts({
        location: { twilio_number: null },
        boundNumber: null,
        assistantNumber: { number: "+15105550000", blockedReason: "claimed by both Marty's and Nonna Rosa" },
      }),
    ).find((c) => c.key === "number");

    expect(check?.status).toBe("blocked");
    expect(check?.note).not.toMatch(/No number yet/);
    expect(check?.note).toMatch(/\+15105550000 already rings/);
    expect(check?.note).toMatch(/Vapi dashboard/);
  });

  it("blocks both Vapi-backed checks when Vapi could not be read, without claiming they failed", () => {
    const checks = buildChecks(facts({ vapiReachable: false, taggedAssistantId: null, boundNumber: null }));
    expect(status(checks, "assistant")).toBe("blocked");
    expect(status(checks, "number")).toBe("blocked");
    // "could not be confirmed", not "is wrong".
    expect(checks.find((c) => c.key === "number")?.note).toMatch(/could not be confirmed/);
    // The single-column truths are untouched by a Vapi outage.
    expect(status(checks, "fallback")).toBe("ok");
  });

  it("warns about an empty menu and empty hours but never blocks on them", () => {
    const checks = buildChecks(facts({ menuItems: 0, hoursRows: 0 }));
    expect(status(checks, "menu")).toBe("warn");
    expect(status(checks, "hours")).toBe("warn");
    expect(blockersOf(checks)).toEqual([]);
  });

  it("calls forwarding 'not applicable' when the restaurant has no line of its own", () => {
    const checks = buildChecks(facts({ location: { business_phone: null } }));
    expect(status(checks, "forwarding")).toBe("na");
    expect(blockersOf(checks)).toEqual([]);
  });

  it("warns about unproven forwarding only once there is a line being forwarded", () => {
    const theirs = { business_phone: "+15105550123" };
    expect(status(buildChecks(facts({ location: theirs })), "forwarding")).toBe("warn");
    expect(
      status(
        buildChecks(facts({ location: { ...theirs, forwarding_verified_at: "2026-08-01T00:00:00Z" } })),
        "forwarding",
      ),
    ).toBe("ok");
    // Still never a blocker either way.
    expect(blockersOf(buildChecks(facts({ location: theirs })))).toEqual([]);
  });
});

/* ── who may claim which number ────────────────────────────────────── */

function number(overrides: Partial<VapiPhoneNumber> = {}): VapiPhoneNumber {
  return {
    id: "62aa9658-4974-45e2-aff1-e640e0aa7e15",
    number: "+15106268819",
    name: "Nonna Rosa",
    provider: "vapi",
    assistantId: null,
    status: "active",
    ...overrides,
  };
}

const CLAIMANTS = [
  { id: NONNA, name: "Nonna Rosa", twilio_number: "+15106268819", vapi_assistant_id: null },
  { id: MARTY, name: "Marty's", twilio_number: null, vapi_assistant_id: "06390622-e738-451c-8295-4cea449107dd" },
];

describe("which numbers a restaurant may claim", () => {
  it("offers a number nobody has claimed", () => {
    const [row] = classifyNumbers({
      numbers: [number({ number: "+15105550000", name: null })],
      locationId: MARTY,
      claimants: CLAIMANTS,
    });
    expect(row.claim).toBe("free");
    expect(row.attachable).toBe(true);
  });

  it("offers a restaurant the number its own column already holds, even when Vapi points it elsewhere", () => {
    // Exactly the live drift: the number is Nonna Rosa's in the
    // database, and bound on Vapi to an assistant no location owns.
    const [row] = classifyNumbers({
      numbers: [number({ assistantId: "50816d6a-a8c2-44eb-90bd-1daa0f26cef2" })],
      locationId: NONNA,
      claimants: CLAIMANTS,
    });
    expect(row.claim).toBe("mine");
    expect(row.attachable).toBe(true);
  });

  it("refuses another restaurant's number, and says whose it is", () => {
    const [row] = classifyNumbers({
      numbers: [number()],
      locationId: MARTY,
      claimants: CLAIMANTS,
    });
    expect(row.claim).toBe("other-location");
    expect(row.attachable).toBe(false);
    expect(row.claimedBy).toEqual({ locationId: NONNA, locationName: "Nonna Rosa" });
  });

  it("refuses a number bound to an assistant that belongs to no restaurant here", () => {
    const [row] = classifyNumbers({
      numbers: [number({ number: "+15105550001", assistantId: "ffffffff-0000-0000-0000-00000000000f" })],
      locationId: MARTY,
      claimants: CLAIMANTS,
    });
    expect(row.claim).toBe("foreign");
    expect(row.attachable).toBe(false);
  });

  it("refuses a number two restaurants both claim, rather than letting one take it", () => {
    // The database says Nonna Rosa's; Vapi says Marty's assistant. A
    // one-click re-point here would silently take a live number off
    // whichever of them is actually answering on it.
    const [row] = classifyNumbers({
      numbers: [number({ assistantId: "06390622-e738-451c-8295-4cea449107dd" })],
      locationId: MARTY,
      claimants: CLAIMANTS,
    });
    expect(row.attachable).toBe(false);
    expect(row.blockedReason).toMatch(/both/);
  });

  it("refuses everything when the claims could not be read, instead of reading silence as consent", () => {
    // The guard is a set difference. An empty claimant list means
    // "nobody owns these"; a claimant list that could not be READ means
    // nothing at all, and handing the second in as the first turned
    // every other restaurant's live number into a free one.
    const rows = classifyNumbers({
      numbers: [number(), number({ id: "n2", number: "+15105550000", assistantId: null })],
      locationId: MARTY,
      claimants: [],
      claimsKnown: false,
    });

    expect(rows.map((r) => r.attachable)).toEqual([false, false]);
    expect(rows.map((r) => r.claim)).toEqual(["unknown", "unknown"]);
    // The rows stay in the list carrying the reason, so "there are no
    // numbers" and "we could not check" never look like each other.
    expect(rows[0].blockedReason).toMatch(/could not be read/);
  });
});

/* ── the gate ──────────────────────────────────────────────────────── */

describe("who may change any of this", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Any of these being reached by an unauthorized caller is already
    // the breach, so they fail loudly rather than quietly succeeding.
    serviceRoleClient.mockImplementation(() => {
      throw new Error("the service-role client must not be reachable by a non-admin caller");
    });
    listPhoneNumbers.mockImplementation(() => {
      throw new Error("Vapi must not be called by a non-admin caller");
    });
    findAssistantForLocation.mockImplementation(() => {
      throw new Error("Vapi must not be called by a non-admin caller");
    });
    bindPhoneNumber.mockImplementation(() => {
      throw new Error("Vapi must not be called by a non-admin caller");
    });
    createPhoneNumber.mockImplementation(() => {
      throw new Error("Vapi must not be called by a non-admin caller");
    });
    provisionAssistantForLocation.mockImplementation(() => {
      throw new Error("Vapi must not be called by a non-admin caller");
    });
  });

  const calls: [string, () => Promise<{ ok: boolean }>][] = [
    ["setLocationLive(on)", () => setLocationLive({ locationId: NONNA, live: true })],
    ["setLocationLive(off)", () => setLocationLive({ locationId: NONNA, live: false })],
    ["setKillSwitch(on)", () => setKillSwitch({ locationId: NONNA, on: true })],
    ["setKillSwitch(off)", () => setKillSwitch({ locationId: NONNA, on: false })],
    ["setForwardingVerified", () => setForwardingVerified({ locationId: NONNA, verified: true })],
    ["setFallbackNumber", () => setFallbackNumber({ locationId: NONNA, number: "+15105550100" })],
    [
      "attachNumberToLocation",
      () => attachNumberToLocation({ locationId: NONNA, phoneNumberId: "62aa9658-4974-45e2-aff1-e640e0aa7e15" }),
    ],
    [
      "provisionNumberForLocation",
      // A well-formed area code on purpose: this asserts the GATE refuses,
      // not the shape check in front of it.
      () => provisionNumberForLocation({ locationId: NONNA, areaCode: "510" }),
    ],
    ["repairAssistant", () => repairAssistant({ locationId: NONNA, base: "https://dialtone.example.com" })],
  ];

  it.each(calls)("%s refuses a signed-out caller", async (_name, call) => {
    currentPlatformAdmin.mockResolvedValue(null);
    await expect(call()).resolves.toEqual({ ok: false, error: "Not found." });
  });

  it.each(calls)("%s refuses a restaurant owner", async (_name, call) => {
    // Not staff. The same sentence, so a signed-in owner cannot tell
    // this location apart from one that does not exist.
    currentPlatformAdmin.mockResolvedValue(null);
    await expect(call()).resolves.toEqual({ ok: false, error: "Not found." });
  });

  it("tells an owner nothing through getGoLiveState either", async () => {
    currentPlatformAdmin.mockResolvedValue(null);
    await expect(getGoLiveState(NONNA)).resolves.toBeNull();
  });

  it("refuses a malformed location id before it reaches the database", async () => {
    currentPlatformAdmin.mockResolvedValue(STAFF);
    await expect(setLocationLive({ locationId: "------------------------------------", live: false })).resolves.toEqual(
      { ok: false, error: "Not found." },
    );
    await expect(getGoLiveState(`../../${OWNER_ID}`)).resolves.toBeNull();
  });
});

/* ── the writes, end to end ────────────────────────────────────────── */

type Cell = string | boolean | null;
type Row = Record<string, Cell>;
type Result = { data: Row[] | null; count: number | null; error: { code: string } | null };
type Table = "locations" | "menu_items" | "hours";
type Store = Record<Table, Row[]> & {
  /** Every update this module sent, and how many rows it actually
   *  changed. `applied: 0` is a compare-and-set that lost, which is a
   *  different event from a write that never happened -- and the whole
   *  point of the conditional write behind provisioning. */
  writes: { table: Table; patch: Row; applied: number }[];
  /** Tables whose LIST select should fail -- the claimants read is one
   *  of these. A degraded read is the whole point of several tests
   *  below, and a fake that can only succeed cannot exercise the
   *  direction this module fails in. */
  readFailures: Partial<Record<Table, { code: string }>>;
  /** Tables whose single-row select should fail. Kept apart from the
   *  above because both of go-live.ts's reads of `locations` would
   *  otherwise be the same switch, and they fail in opposite
   *  directions: losing the row is fail-closed, losing the claimants is
   *  where this module used to fail OPEN. */
  singleFailures: Partial<Record<Table, { code: string }>>;
  /** Tables whose UPDATE should fail. Optional so every store literal
   *  written before conditional writes existed still type-checks.
   *  "Vapi did the thing and Postgres did not" is the failure this
   *  module has to report honestly rather than roll back. */
  updateFailures?: Partial<Record<Table, { code: string }>>;
};

/** Just enough PostgREST to drive this module: the call shapes
 *  go-live.ts actually uses, and a record of every write, so a test can
 *  assert that a refusal wrote nothing rather than only that it said no. */
class FakeQuery implements PromiseLike<Result> {
  private filters: [string, Cell][] = [];
  private counting = false;
  private patch: Row | null = null;
  private max: number | null = null;

  constructor(
    private store: Store,
    private table: Table,
  ) {}

  select(_columns: string, options?: { count?: string; head?: boolean }) {
    this.counting = options?.count !== undefined;
    return this;
  }
  eq(column: string, value: Cell) {
    this.filters.push([column, value]);
    return this;
  }
  /* PostgREST's IS, which is how a compare-and-set on a nullable column
     is written: .update(...).eq("id", x).is("twilio_number", null). */
  is(column: string, value: Cell) {
    this.filters.push([column, value]);
    return this;
  }
  limit(max: number) {
    this.max = max;
    return this;
  }
  update(patch: Row) {
    this.patch = patch;
    return this;
  }
  maybeSingle(): Promise<{ data: Row | null; error: { code: string } | null }> {
    const failure = this.store.singleFailures[this.table];
    if (failure) return Promise.resolve({ data: null, error: failure });
    // A COPY, as PostgREST hands back: a read is a photograph taken at a
    // moment, and the whole hazard these tests exist for is the row
    // moving underneath a decision made from one. Handing back the live
    // object made every derivation silently self-updating, which is the
    // one thing a database never does.
    const row = this.rows()[0];
    return Promise.resolve({ data: row ? { ...row } : null, error: null });
  }
  private rows(): Row[] {
    const matched = this.store[this.table].filter((row) =>
      this.filters.every(([column, value]) => row[column] === value),
    );
    return this.max === null ? matched : matched.slice(0, this.max);
  }
  private run(): Result {
    if (this.patch) {
      const failure = this.store.updateFailures?.[this.table];
      if (failure) return { data: null, count: null, error: failure };
      const patch = this.patch;
      // Matched BEFORE the patch lands, which is what makes a
      // conditional update conditional.
      const matched = this.rows();
      for (const row of matched) Object.assign(row, patch);
      this.store.writes.push({ table: this.table, patch, applied: matched.length });
      // The rows a `.select()` after an `.update()` returns. Zero of
      // them is how the loser of a compare-and-set finds out.
      return { data: matched.map((row) => ({ id: row.id })), count: null, error: null };
    }
    const failure = this.store.readFailures[this.table];
    if (failure) return { data: null, count: null, error: failure };
    const rows = this.rows();
    return this.counting
      ? { data: null, count: rows.length, error: null }
      : { data: rows.map((row) => ({ ...row })), count: null, error: null };
  }
  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

let store: Store;

function location(overrides: Row = {}): Row {
  return {
    id: MARTY,
    name: "Marty's",
    twilio_number: null,
    vapi_assistant_id: ASSISTANT,
    // The digest lib/agent/auth.ts matches every tool call against. A
    // row without one is a restaurant whose assistant answers the phone
    // and then cannot read its own menu, which is its own test below.
    agent_secret_hash: "sha256-on-file",
    fallback_human_number: "+18787787878",
    business_phone: null,
    carrier_name: null,
    forwarding_verified_at: null,
    is_live: false,
    kill_switch_on: false,
    ...overrides,
  };
}

describe("changing the state of the line", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VAPI_PRIVATE_KEY", "vapi-test-key");

    store = {
      locations: [
        location(),
        location({ id: NONNA, name: "Nonna Rosa", twilio_number: "+15106268819", vapi_assistant_id: null, is_live: true }),
      ],
      menu_items: [{ id: "m1", location_id: MARTY }],
      hours: [{ location_id: MARTY, day_of_week: null, open_time: "09:00", close_time: "21:00", is_closed: false }],
      writes: [],
      readFailures: {},
      singleFailures: {},
    };

    currentPlatformAdmin.mockResolvedValue(STAFF);
    serviceRoleClient.mockImplementation(() => ({
      from: (table: Table) => new FakeQuery(store, table),
    }));
    listPhoneNumbers.mockResolvedValue([]);
    findAssistantForLocation.mockResolvedValue({ id: ASSISTANT });
    getAssistant.mockResolvedValue({ id: ASSISTANT });
    tagAssistantForLocation.mockResolvedValue({ id: ASSISTANT });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function marty(): Row {
    return store.locations.find((l) => l.id === MARTY) as Row;
  }

  it("takes a restaurant offline without asking Vapi anything", async () => {
    // The point of this one: a Vapi outage must never be able to keep a
    // bad deployment answering the phone.
    listPhoneNumbers.mockRejectedValue(new Error("Vapi is down"));
    findAssistantForLocation.mockRejectedValue(new Error("Vapi is down"));

    await expect(setLocationLive({ locationId: NONNA, live: false })).resolves.toMatchObject({ ok: true });
    expect(store.locations.find((l) => l.id === NONNA)?.is_live).toBe(false);
    expect(listPhoneNumbers).not.toHaveBeenCalled();
    expect(findAssistantForLocation).not.toHaveBeenCalled();
  });

  it("throws the kill switch while Vapi is unreachable", async () => {
    listPhoneNumbers.mockRejectedValue(new Error("Vapi is down"));
    await expect(setKillSwitch({ locationId: MARTY, on: true })).resolves.toMatchObject({ ok: true });
    expect(marty().kill_switch_on).toBe(true);
  });

  it("refuses to go live while a blocker stands, and writes nothing", async () => {
    // Marty's has an assistant but no number.
    const result = await setLocationLive({ locationId: MARTY, live: true });
    expect(result).toMatchObject({ ok: false, blockedBy: ["number"] });
    expect(marty().is_live).toBe(false);
    expect(store.writes).toEqual([]);
  });

  it("refuses to go live when Vapi could not be read, rather than assuming the best", async () => {
    store.locations[0].twilio_number = "+15105550000";
    listPhoneNumbers.mockRejectedValue(new Error("Vapi is down"));

    const result = await setLocationLive({ locationId: MARTY, live: true });
    expect(result.ok).toBe(false);
    expect(store.writes).toEqual([]);
  });

  it("goes live once the number, assistant and fallback all check out", async () => {
    store.locations[0].twilio_number = "+15105550000";
    listPhoneNumbers.mockResolvedValue([
      { id: "n1", number: "+15105550000", name: "Marty's", provider: "vapi", assistantId: ASSISTANT, status: "active" },
    ]);

    await expect(setLocationLive({ locationId: MARTY, live: true })).resolves.toMatchObject({ ok: true });
    expect(marty().is_live).toBe(true);
  });

  it("will not attach a number another restaurant claims", async () => {
    // Posting Nonna Rosa's number id from Marty's page. The panel would
    // never draw this; the endpoint has to refuse it anyway.
    listPhoneNumbers.mockResolvedValue([
      { id: "n-nonna", number: "+15106268819", name: "Nonna Rosa", provider: "vapi", assistantId: null, status: "active" },
    ]);

    const result = await attachNumberToLocation({ locationId: MARTY, phoneNumberId: "n-nonna" });
    expect(result.ok).toBe(false);
    expect(bindPhoneNumber).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    expect(marty().twilio_number).toBeNull();
  });

  it("attaches a free number, and saves the string Vapi reports rather than anything it was handed", async () => {
    listPhoneNumbers.mockResolvedValue([
      { id: "n-free", number: "+15105550001", name: null, provider: "vapi", assistantId: null, status: "active" },
    ]);
    bindPhoneNumber.mockResolvedValue({
      id: "n-free",
      number: "+15105550002",
      name: "Marty's",
      provider: "vapi",
      assistantId: ASSISTANT,
      status: "active",
    });

    await expect(attachNumberToLocation({ locationId: MARTY, phoneNumberId: "n-free" })).resolves.toMatchObject({
      ok: true,
    });
    expect(bindPhoneNumber).toHaveBeenCalledWith("vapi-test-key", {
      phoneNumberId: "n-free",
      assistantId: ASSISTANT,
      name: "Marty's",
    });
    // Vapi's own string, not the picker's.
    expect(marty().twilio_number).toBe("+15105550002");
  });

  it("re-reads the account before it binds, and refuses a number claimed since", async () => {
    /* The cross-tenant race the deterministic pick makes likely rather
       than rare. Two restaurants, one free number: both derivations see
       it free, and planNumber -- deterministically, on purpose -- points
       both at the same row. `pick.attachable` cannot catch that; it was
       computed from the same photograph. Only a fresh read can, and it
       has to happen after the decision and before the PATCH. */
    const free = { id: "n-free", number: "+15105550001", name: null, provider: "vapi", assistantId: null, status: "active" };
    listPhoneNumbers
      .mockResolvedValueOnce([free])
      .mockResolvedValue([{ ...free, assistantId: "bbbbbbbb-0000-0000-0000-000000000002" }]);

    const result = await attachNumberToLocation({ locationId: MARTY, phoneNumberId: "n-free" });

    expect(result.ok).toBe(false);
    // Nothing is taken off whoever won it: the other restaurant may be
    // answering calls on this number already.
    expect(bindPhoneNumber).not.toHaveBeenCalled();
    expect(marty().twilio_number).toBeNull();
    expect(store.writes).toEqual([]);
  });

  it("still attaches a number this restaurant's own second press already bound", async () => {
    // The re-read refuses a number that MOVED, not one that arrived
    // where it was going. Re-binding a number to the assistant it
    // already rings is a no-op PATCH, and refusing it would turn a
    // duplicate press into a dead end.
    const free = { id: "n-free", number: "+15105550001", name: null, provider: "vapi", assistantId: null, status: "active" };
    listPhoneNumbers
      .mockResolvedValueOnce([free])
      .mockResolvedValue([{ ...free, name: "Marty's", assistantId: ASSISTANT }]);
    bindPhoneNumber.mockResolvedValue({ ...free, name: "Marty's", assistantId: ASSISTANT });

    await expect(attachNumberToLocation({ locationId: MARTY, phoneNumberId: "n-free" })).resolves.toMatchObject({
      ok: true,
    });
    expect(marty().twilio_number).toBe("+15105550001");
  });

  it("never overwrites a number written down while it was away binding", async () => {
    // The other half of the same race: this run's claim was decided on
    // an empty column, and by the time Vapi answered the column was not
    // empty any more. The number in it may be on a door.
    const free = { id: "n-free", number: "+15105550001", name: null, provider: "vapi", assistantId: null, status: "active" };
    listPhoneNumbers.mockResolvedValue([free]);
    bindPhoneNumber.mockImplementation(async () => {
      marty().twilio_number = "+15105551111";
      return { ...free, name: "Marty's", assistantId: ASSISTANT };
    });

    const result = await attachNumberToLocation({ locationId: MARTY, phoneNumberId: "n-free" });

    expect(result.ok).toBe(false);
    expect(marty().twilio_number).toBe("+15105551111");
    // The number Vapi did bind is the operator's fact, on this road too:
    // the standalone button hands back nothing but this sentence.
    expect(result.ok === false && result.error).toMatch(/\+15105550001/);
    expect(store.writes.some((w) => "twilio_number" in w.patch && w.applied === 0)).toBe(true);
  });

  it("still re-attaches a restaurant's own number while the column has not moved", async () => {
    // The conditional write must not refuse the legitimate replacement:
    // re-attaching after a rebuild writes a non-null column with the
    // same string it was derived from.
    store.locations[0].twilio_number = "+15105550000";
    listPhoneNumbers.mockResolvedValue([
      { id: "n-mine", number: "+15105550000", name: "Marty's", provider: "vapi", assistantId: null, status: "active" },
    ]);
    bindPhoneNumber.mockResolvedValue({
      id: "n-mine",
      number: "+15105550000",
      name: "Marty's",
      provider: "vapi",
      assistantId: ASSISTANT,
      status: "active",
    });

    await expect(attachNumberToLocation({ locationId: MARTY, phoneNumberId: "n-mine" })).resolves.toMatchObject({
      ok: true,
    });
    expect(marty().twilio_number).toBe("+15105550000");
  });

  it("will not spend a second free number on a restaurant that already has one", async () => {
    store.locations[0].twilio_number = "+15105550000";
    listPhoneNumbers.mockResolvedValue([
      { id: "n1", number: "+15105550000", name: "Marty's", provider: "vapi", assistantId: ASSISTANT, status: "active" },
    ]);

    const result = await provisionNumberForLocation({ locationId: MARTY, areaCode: "510" });
    expect(result.ok).toBe(false);
    expect(createPhoneNumber).not.toHaveBeenCalled();
  });

  /* ── the area code a new number is issued in ─────────────────────── */

  it.each([
    ["begins with 0", "015"],
    ["begins with 1", "115"],
    ["is two digits", "51"],
    ["is four digits", "5105"],
    ["is not numeric", "bay"],
    ["is empty", ""],
  ])("refuses an area code that %s before it reads anything at all", async (_why, value) => {
    // A typo in this field should cost nothing whatsoever -- not a Vapi
    // read, not a Postgres read, and above all not a number. The gate
    // runs first and this runs second, ahead of stateForWrite.
    const result = await provisionNumberForLocation({ locationId: MARTY, areaCode: value });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/not an area code/);
    expect(listPhoneNumbers).not.toHaveBeenCalled();
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });

  it("asks Vapi for a number in the area code the operator confirmed", async () => {
    // Not the derived default, and not anything this file worked out:
    // the operator typed 925 in the confirmation, so 925 is what is
    // spent. Marty's own numbers would have offered 878.
    createPhoneNumber.mockResolvedValue({
      id: "n-new",
      number: "+19255551234",
      name: "Marty's",
      provider: "vapi",
      assistantId: ASSISTANT,
      status: "active",
    });

    await expect(
      provisionNumberForLocation({ locationId: MARTY, areaCode: "925" }),
    ).resolves.toMatchObject({ ok: true });

    expect(createPhoneNumber).toHaveBeenCalledWith("vapi-test-key", {
      assistantId: ASSISTANT,
      name: "Marty's",
      areaCode: "925",
    });
    expect(marty().twilio_number).toBe("+19255551234");
  });

  it("tells an operator to try a neighbouring area code, not that something is broken", async () => {
    // An empty pool in one area code is Vapi working correctly. Reported
    // as a generic failure it sends somebody to check a deployment that
    // is fine, while the one move that would work -- 925 instead of 510
    // -- goes unsaid. Nothing was issued, so there is nothing to undo.
    createPhoneNumber.mockRejectedValue(new NoNumberInAreaCodeError("510"));

    const result = await provisionNumberForLocation({ locationId: MARTY, areaCode: "510" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no free number in area code 510/);
    expect(result.ok === false && result.error).toMatch(/neighbouring area code/);
    // Distinct: the generic road appends this sentence and this one must
    // not, or the two failures read as the same failure again.
    expect(result.ok === false && result.error).not.toMatch(/No number was issued\./);
    expect(marty().twilio_number).toBeNull();
    expect(store.writes).toEqual([]);
  });

  it("still reports an ordinary Vapi failure as one", async () => {
    createPhoneNumber.mockRejectedValue(new Error("Vapi returned 402 on POST /phone-number"));

    const result = await provisionNumberForLocation({ locationId: MARTY, areaCode: "510" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/402/);
    expect(result.ok === false && result.error).toMatch(/No number was issued/);
  });

  it("offers the restaurant's own area code, business phone first", async () => {
    // The number its customers already dial. Marty's fallback would
    // offer 878, so this also proves the order.
    marty().business_phone = "(510) 555-0142";

    await expect(getGoLiveState(MARTY)).resolves.toMatchObject({ defaultAreaCode: "510" });
  });

  it("falls back to the human number when there is no business phone", async () => {
    // A person at this restaurant is the next best evidence of where the
    // restaurant is. Marty's fixture has no business_phone.
    expect(marty().business_phone).toBeNull();

    await expect(getGoLiveState(MARTY)).resolves.toMatchObject({ defaultAreaCode: "878" });
  });

  it("offers nothing when neither number yields an area code", async () => {
    // The state that must NOT produce a default. A London fallback has
    // no NANP area code in it, and "442" is not one.
    marty().business_phone = null;
    marty().fallback_human_number = "+442071838750";

    await expect(getGoLiveState(MARTY)).resolves.toMatchObject({ defaultAreaCode: null });
  });

  it("reconnects a record that lost its assistant id, without touching Vapi", async () => {
    // Nonna Rosa: answering calls right now, with a null column.
    findAssistantForLocation.mockResolvedValue({ id: "50816d6a-a8c2-44eb-90bd-1daa0f26cef2" });

    await expect(repairAssistant({ locationId: NONNA, base: "https://dialtone.example.com" })).resolves.toMatchObject({
      ok: true,
    });
    expect(store.locations.find((l) => l.id === NONNA)?.vapi_assistant_id).toBe(
      "50816d6a-a8c2-44eb-90bd-1daa0f26cef2",
    );
    // Nothing was built, so no secret was rotated under a live call.
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("refuses to build a brand-new assistant against an address Vapi cannot reach", async () => {
    // Nothing tagged AND nothing at the id on file: the only state in
    // which anything is built, and so the only one where `base` matters.
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockResolvedValue(null);

    const result = await repairAssistant({ locationId: MARTY, base: "http://localhost:3000" });
    expect(result.ok).toBe(false);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("builds one when Vapi has none and the deployment is reachable", async () => {
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockResolvedValue(null);
    provisionAssistantForLocation.mockResolvedValue({ secret: "s", assistantId: "new" });

    await expect(repairAssistant({ locationId: MARTY, base: "https://dialtone.example.com" })).resolves.toMatchObject({
      ok: true,
    });
    expect(provisionAssistantForLocation).toHaveBeenCalledTimes(1);
  });

  it("removes the half-made assistant when its tool secret could not be saved", async () => {
    /* The orphan, and why it cannot be left there. Vapi holds an
       assistant TAGGED for this location, carrying a secret whose hash
       never landed -- so the next repair finds it by that tag, takes the
       reconnect branch, and the checklist goes green over an agent that
       401s on every tool call. Deleted here, exactly as
       lib/provisioning/create-restaurant.ts deletes it for the identical
       failure. */
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockResolvedValue(null);
    provisionAssistantForLocation.mockRejectedValue(
      new AssistantSecretWriteError("saving its secret failed", "a-orphan", true),
    );

    const result = await repairAssistant({ locationId: MARTY, base: "https://dialtone.example.com" });

    expect(result.ok).toBe(false);
    expect(deleteAssistant).toHaveBeenCalledWith("vapi-test-key", "a-orphan");
    expect(marty().vapi_assistant_id).toBe(ASSISTANT);
  });

  it("does not delete the live assistant it merely re-provisioned", async () => {
    /* The other side of the same branch, and the reason it reads
       `created`. With no secret on file the repair re-provisions the
       assistant Vapi ALREADY HAS -- upsertAssistant PATCHes it rather
       than building a second one -- so deleting on a failed hash write
       would take a restaurant that is answering calls off the air to
       tidy up a write. */
    marty().agent_secret_hash = null;
    findAssistantForLocation.mockResolvedValue({ id: ASSISTANT });
    provisionAssistantForLocation.mockRejectedValue(
      new AssistantSecretWriteError("saving its secret failed", ASSISTANT, false),
    );

    const result = await repairAssistant({ locationId: MARTY, base: "https://dialtone.example.com" });

    expect(result.ok).toBe(false);
    expect(deleteAssistant).not.toHaveBeenCalled();
    // And it went to provisioning at all, rather than reconnecting a
    // record to an assistant nothing here can authenticate.
    expect(provisionAssistantForLocation).toHaveBeenCalledTimes(1);
  });

  it("re-provisions rather than reconnects when there is no tool secret on file", async () => {
    marty().agent_secret_hash = null;
    marty().vapi_assistant_id = null;
    findAssistantForLocation.mockResolvedValue({ id: ASSISTANT });
    provisionAssistantForLocation.mockImplementation(async () => {
      marty().vapi_assistant_id = ASSISTANT;
      marty().agent_secret_hash = "sha256-fresh";
      return { secret: "s", assistantId: ASSISTANT, created: false };
    });

    await expect(
      repairAssistant({ locationId: MARTY, base: "https://dialtone.example.com" }),
    ).resolves.toMatchObject({ ok: true });

    // The reconnect shortcut would have written the column and stopped,
    // leaving every tool call unauthenticated behind a green checklist.
    expect(provisionAssistantForLocation).toHaveBeenCalledTimes(1);
    expect(marty().agent_secret_hash).toBe("sha256-fresh");
  });

  it("saves a fallback number as E.164, and refuses what will not normalize", async () => {
    await expect(setFallbackNumber({ locationId: MARTY, number: "(510) 555-0123" })).resolves.toMatchObject({
      ok: true,
    });
    expect(marty().fallback_human_number).toBe("+15105550123");

    store.writes = [];
    const result = await setFallbackNumber({ locationId: MARTY, number: "ring the bell" });
    expect(result.ok).toBe(false);
    expect(store.writes).toEqual([]);
  });

  it("stamps and clears the forwarding timestamp server-side", async () => {
    await setForwardingVerified({ locationId: MARTY, verified: true });
    expect(typeof marty().forwarding_verified_at).toBe("string");

    await setForwardingVerified({ locationId: MARTY, verified: false });
    expect(marty().forwarding_verified_at).toBeNull();
  });

  /* ── reads that fail, and which direction they fail in ───────────── */

  it("will not hand out another restaurant's number when the ownership read fails", async () => {
    // The fail-open that was here: the claimants select errored, the
    // error was logged, and classifyNumbers was then called with an
    // empty claim set -- so Nonna Rosa's live number classified as
    // "free" and Marty's page could point it at Marty's assistant.
    // Callers would have reached the wrong restaurant.
    store.readFailures.locations = { code: "57014" };
    listPhoneNumbers.mockResolvedValue([
      { id: "n-nonna", number: "+15106268819", name: "Nonna Rosa", provider: "vapi", assistantId: null, status: "active" },
    ]);

    const state = await getGoLiveState(MARTY);
    expect(state?.ownershipError).not.toBeNull();
    expect(state?.numbers.every((n) => !n.attachable)).toBe(true);

    const result = await attachNumberToLocation({ locationId: MARTY, phoneNumberId: "n-nonna" });
    expect(result.ok).toBe(false);
    expect(bindPhoneNumber).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    expect(marty().twilio_number).toBeNull();
  });

  it("refuses just as hard when the claimant read is merely truncated", async () => {
    // No error at all, and the same fail-open: this select used to
    // inherit PostgREST's max-rows cap, so once the platform outgrew one
    // page the restaurants past the cut silently stopped claiming their
    // own numbers. An explicit ceiling turns that into something this
    // file can see.
    while (store.locations.length < CLAIMANT_LIMIT) {
      store.locations.push(location({ id: `filler-${store.locations.length}` }));
    }
    listPhoneNumbers.mockResolvedValue([
      { id: "n-free", number: "+15105550001", name: null, provider: "vapi", assistantId: null, status: "active" },
    ]);

    const state = await getGoLiveState(MARTY);
    expect(state?.ownershipError).not.toBeNull();
    expect(state?.numbers.every((n) => !n.attachable)).toBe(true);

    await expect(
      attachNumberToLocation({ locationId: MARTY, phoneNumberId: "n-free" }),
    ).resolves.toMatchObject({ ok: false });
    expect(bindPhoneNumber).not.toHaveBeenCalled();
  });

  it("still lets a restaurant be silenced while the ownership read is failing", async () => {
    // The refusal above must not spread. Nothing about who owns which
    // number bears on taking a restaurant down.
    store.readFailures.locations = { code: "57014" };

    await expect(setLocationLive({ locationId: NONNA, live: false })).resolves.toMatchObject({ ok: true });
    await expect(setKillSwitch({ locationId: NONNA, on: true })).resolves.toMatchObject({ ok: true });
  });

  it("throws the kill switch even when the row cannot be read, and does not say 'Not found.'", async () => {
    // That read only ever chose between two sentences, and gating the
    // emergency control on it meant an operator mid-incident was told
    // the restaurant does not exist. Taking a restaurant offline has
    // never been gated this way; the switch beside it must not be.
    store.singleFailures.locations = { code: "57014" };

    const result = await setKillSwitch({ locationId: MARTY, on: true });
    expect(result).toMatchObject({ ok: true });
    expect(marty().kill_switch_on).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/Not found/);
  });

  it("tells a failed read apart from a missing restaurant instead of 404-ing the operator", async () => {
    // getGoLiveState throws rather than returning null, so the page can
    // render an error boundary -- inside the operator layout, with its
    // bar and its nav -- instead of Next's bare 404, which renders in
    // the root layout and has no way back to anything.
    store.singleFailures.locations = { code: "57014" };

    await expect(getGoLiveState(MARTY)).rejects.toThrow(/Could not read this restaurant/);

    // A location that genuinely is not there is still null, not a throw.
    store.singleFailures = {};
    await expect(getGoLiveState("00000000-0000-0000-0000-000000000000")).resolves.toBeNull();
  });

  it("turns that same failed read into a refusal rather than an exception in a mutation", async () => {
    // A "use server" export may not throw a raw read failure at a
    // browser; every one of these has to answer with a sentence.
    store.singleFailures.locations = { code: "57014" };

    for (const call of [
      () => setLocationLive({ locationId: MARTY, live: true }),
      () => setFallbackNumber({ locationId: MARTY, number: "+15105550123" }),
      () => attachNumberToLocation({ locationId: MARTY, phoneNumberId: "n-free" }),
      () => provisionNumberForLocation({ locationId: MARTY, areaCode: "510" }),
      () => repairAssistant({ locationId: MARTY, base: "https://dialtone.example.com" }),
    ]) {
      await expect(call()).resolves.toMatchObject({ ok: false });
    }
    expect(store.writes).toEqual([]);
  });

  /* ── the assistant this record NAMES ─────────────────────────────── */

  it("re-labels an untagged assistant instead of building a second one beside it", async () => {
    // Marty's assistant exists on Vapi and is answering; its metadata
    // lost dialtone_location_id, so the tag search cannot see it. The
    // old code treated that as "gone" and rebuilt -- minting a new tool
    // secret and overwriting agent_secret_hash, while the phone number
    // still rang the original, whose baked-in secret now 401s on every
    // tool call. The restaurant silently loses hours, menu and ordering.
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockResolvedValue({ id: ASSISTANT, metadata: { some_other_tool: "keep me" } });

    const result = await repairAssistant({ locationId: MARTY, base: "https://dialtone.example.com" });

    expect(result).toMatchObject({ ok: true });
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
    expect(tagAssistantForLocation).toHaveBeenCalledWith(
      "vapi-test-key",
      { id: ASSISTANT, metadata: { some_other_tool: "keep me" } },
      MARTY,
    );
    // Nothing was rewritten here either: the column already named it.
    expect(store.writes).toEqual([]);
  });

  it("does not rebuild on a Vapi error, because 'could not ask' is not 'not there'", async () => {
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockRejectedValue(new Error("Vapi returned 500"));

    const result = await repairAssistant({ locationId: MARTY, base: "https://dialtone.example.com" });
    expect(result.ok).toBe(false);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("still builds one when the named assistant really is gone", async () => {
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockResolvedValue(null);
    provisionAssistantForLocation.mockResolvedValue({ secret: "s", assistantId: "new" });

    await expect(
      repairAssistant({ locationId: MARTY, base: "https://dialtone.example.com" }),
    ).resolves.toMatchObject({ ok: true });
    expect(provisionAssistantForLocation).toHaveBeenCalledTimes(1);
  });

  it("gives the two Vapi reads behind the page a deadline", async () => {
    // Without one, `fetch` waits on undici's 300s headersTimeout, and
    // the page carrying Take offline and the kill switch does not paint
    // for five minutes while Vapi hangs. The deadline is what turns a
    // hang into the vapiError path the panel already handles.
    await getGoLiveState(MARTY);

    expect(listPhoneNumbers).toHaveBeenCalledWith("vapi-test-key", { timeoutMs: expect.any(Number) });
    expect(findAssistantForLocation).toHaveBeenCalledWith("vapi-test-key", MARTY, {
      timeoutMs: expect.any(Number),
    });

    const [, options] = listPhoneNumbers.mock.calls[0] as [string, { timeoutMs: number }];
    expect(options.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it("paints the panel with the shutdown switches live when Vapi hangs past that deadline", async () => {
    listPhoneNumbers.mockRejectedValue(new Error("Vapi did not answer within 5s (GET /phone-number)"));

    const state = await getGoLiveState(MARTY);
    expect(state?.vapiError).toMatch(/did not answer/);
    expect(state?.location.id).toBe(MARTY);
  });
});

/* ── one click ─────────────────────────────────────────────────────── */

/* WHAT MAKES THIS ONE WORTH TESTING HARD
 *
 * makeItLive is the only thing in the product that can, unattended,
 * create a real outside resource with no undo: POST /phone-number spends
 * one of the org's free numbers and there is deliberately no release
 * wrapper anywhere in this codebase. So the tests below are mostly about
 * what it does NOT do -- it does not mint a number a restaurant could
 * have reused, it does not mint one twice, it does not mint one when it
 * could not prove who owns what, and it does not mark a restaurant live
 * without a working number no matter where it failed.
 *
 * Every one of them asserts on the recorded writes, not only on the
 * sentence that came back: "it said no" and "it changed nothing" are
 * different claims, and only the second one is the safety property.
 */

const NEW_ASSISTANT = "cccccccc-0000-0000-0000-000000000003";
const NONNA_ASSISTANT = "50816d6a-a8c2-44eb-90bd-1daa0f26cef2";
const BASE = "https://dialtone.example.com";

function attachable(overrides: Partial<AttachableNumber> = {}): AttachableNumber {
  return {
    id: "n1",
    number: "+15105550000",
    name: null,
    provider: "vapi",
    assistantId: null,
    claim: "free",
    claimedBy: null,
    attachable: true,
    blockedReason: null,
    ...overrides,
  };
}

describe("deciding what to do about the phone number", () => {
  it("does nothing at all when the number on file already rings this assistant", () => {
    expect(
      planNumber({
        numberCheckOk: true,
        onFile: "+15106268819",
        numbers: [attachable()],
        claimsKnown: true,
        assistantId: ASSISTANT,
      }),
    ).toEqual({ kind: "already-bound" });
  });

  it("refuses to mint anything when it could not find out who owns what", () => {
    // Stricter than the standalone provision button on purpose. That
    // button is pressed by a person who meant it; this one's entire
    // licence to spend a one-way-door resource is that it PROVED reuse
    // was impossible, and with the claimant read lost it has proved
    // nothing -- the restaurant may already own a number it pays for.
    const plan = planNumber({
      numberCheckOk: false,
      onFile: null,
      numbers: [attachable({ claim: "unknown", attachable: false })],
      claimsKnown: false,
      assistantId: ASSISTANT,
    });
    expect(plan).toMatchObject({ kind: "halt", halt: "ownership-unreadable" });
  });

  it("re-points the restaurant's own number rather than taking a free one", () => {
    const plan = planNumber({
      numberCheckOk: false,
      onFile: "+15106268819",
      numbers: [
        attachable({ id: "n-free", number: "+15105550000" }),
        attachable({ id: "n-mine", number: "+15106268819", claim: "mine" }),
      ],
      claimsKnown: true,
      assistantId: ASSISTANT,
    });
    // The one that may already be printed on a door beats every free
    // number on the account.
    expect(plan).toEqual({ kind: "attach", id: "n-mine", number: "+15106268819", because: "own" });
  });

  it("never replaces a number already on file, even when it has vanished from Vapi", () => {
    // "The number moved to another provider" and "the number was
    // released" are facts only a human has. Minting a second one here
    // would spend an allowance slot AND leave a door, a menu and a
    // Google listing pointing at a number this record no longer knows.
    const plan = planNumber({
      numberCheckOk: false,
      onFile: "+15106268819",
      numbers: [attachable({ id: "n-free", number: "+15105550000" })],
      claimsKnown: true,
      assistantId: ASSISTANT,
    });
    expect(plan).toMatchObject({ kind: "halt", halt: "vapi-dashboard" });
    expect(plan).not.toMatchObject({ kind: "provision" });
  });

  it("halts on a number two restaurants both claim, quoting the reason", () => {
    const plan = planNumber({
      numberCheckOk: false,
      onFile: "+15106268819",
      numbers: [
        attachable({
          id: "n-both",
          number: "+15106268819",
          claim: "other-location",
          attachable: false,
          blockedReason: "claimed by both Marty's and Nonna Rosa",
        }),
      ],
      claimsKnown: true,
      assistantId: ASSISTANT,
    });
    expect(plan).toMatchObject({ kind: "halt", halt: "vapi-dashboard" });
    expect(plan).toMatchObject({ note: expect.stringMatching(/claimed by both/) });
  });

  it("takes a number already ringing this assistant before it takes a free one", () => {
    const plan = planNumber({
      numberCheckOk: false,
      onFile: null,
      numbers: [
        attachable({ id: "n-free", number: "+15105550000" }),
        attachable({ id: "n-mine", number: "+15109990000", claim: "mine" }),
      ],
      claimsKnown: true,
      assistantId: ASSISTANT,
    });
    expect(plan).toEqual({ kind: "attach", id: "n-mine", number: "+15109990000", because: "own" });
  });

  it("picks free numbers deterministically, so two runs converge on one binding", () => {
    // Not cosmetic. Two runs deriving the same account state must pick
    // the SAME row, or their PATCHes split the account across two
    // restaurants instead of landing on top of each other.
    const numbers = [
      attachable({ id: "n-c", number: "+15105550003" }),
      attachable({ id: "n-a", number: "+15105550001" }),
      attachable({ id: "n-b", number: "+15105550002" }),
    ];
    const args = { numberCheckOk: false, onFile: null, claimsKnown: true, assistantId: ASSISTANT };
    expect(planNumber({ ...args, numbers })).toEqual(
      planNumber({ ...args, numbers: [...numbers].reverse() }),
    );
    expect(planNumber({ ...args, numbers })).toMatchObject({ id: "n-a" });
  });

  it("halts rather than mints when a contested number already rings this assistant", () => {
    /* The subcase the empty column used to fall through. The database
       says one restaurant owns +15106268819 and Vapi points it at THIS
       restaurant's assistant, so classifyNumbers refuses it to everybody
       and no row reads as "mine" -- while callers are reaching this
       restaurant on it right now. Minting here spends the one
       irreversible resource in the feature on a restaurant that is
       already answering, bills a second number per minute for nothing,
       and settles none of the double claim. */
    const plan = planNumber({
      numberCheckOk: false,
      onFile: null,
      numbers: [
        attachable({
          id: "n-both",
          number: "+15106268819",
          assistantId: ASSISTANT,
          claim: "other-location",
          attachable: false,
          blockedReason: "claimed by both Marty's and Nonna Rosa",
        }),
      ],
      claimsKnown: true,
      assistantId: ASSISTANT,
    });

    expect(plan).toMatchObject({ kind: "halt", halt: "vapi-dashboard" });
    expect(plan).toMatchObject({ note: expect.stringMatching(/already rings this restaurant/) });
    expect(plan).toMatchObject({ note: expect.stringMatching(/claimed by both/) });
  });

  it("still mints when the unattachable rows ring somebody else's assistant", () => {
    // The halt above is about a number ringing THIS assistant. Another
    // restaurant's number blocks nothing here.
    expect(
      planNumber({
        numberCheckOk: false,
        onFile: null,
        numbers: [
          attachable({
            claim: "other-location",
            attachable: false,
            assistantId: "bbbbbbbb-0000-0000-0000-000000000002",
          }),
        ],
        claimsKnown: true,
        assistantId: ASSISTANT,
      }),
    ).toEqual({ kind: "provision" });
  });

  it("mints one only when there is nothing at all to reuse", () => {
    expect(
      planNumber({
        numberCheckOk: false,
        onFile: null,
        numbers: [attachable({ claim: "other-location", attachable: false })],
        claimsKnown: true,
        assistantId: ASSISTANT,
      }),
    ).toEqual({ kind: "provision" });
  });
});

describe("a number set for reading down a phone", () => {
  it("groups a NANP number and leaves anything else exactly as Vapi reported it", () => {
    expect(spokenNumber("+15106268819")).toBe("+1 (510) 626-8819");
    // Never guessed at: the stored string is what
    // app/api/twilio/voice/route.ts matches inbound calls on.
    expect(spokenNumber("+442071838750")).toBe("+442071838750");
  });
});

describe("turning a restaurant on with one button", () => {
  /** What the operator answered when this run's confirmation asked which
   *  area code a brand-new number should be issued in.
   *
   *  Every run below that reaches the mint carries one, because a run
   *  that does not cannot reach it -- see "refuses to mint in an area
   *  code nobody confirmed". It is deliberately NOT the code either of
   *  Marty's numbers would suggest: an argument that happens to equal
   *  the derivation proves nothing about which of the two was spent. */
  const CONFIRMED = "925";

  beforeEach(() => {
    // reset, not clear: several tests below install implementations that
    // reach over and re-arm another mock (a number Vapi issues turns up
    // in the next account listing, as it does in life). Those must not
    // survive into the next test.
    vi.resetAllMocks();
    vi.stubEnv("VAPI_PRIVATE_KEY", "vapi-test-key");

    store = {
      locations: [
        location(),
        location({
          id: NONNA,
          name: "Nonna Rosa",
          twilio_number: "+15106268819",
          vapi_assistant_id: null,
          business_phone: "(510) 555-0142",
          carrier_name: "Comcast Business",
          is_live: true,
        }),
      ],
      menu_items: [{ id: "m1", location_id: MARTY }],
      hours: [{ location_id: MARTY, day_of_week: null, open_time: "09:00", close_time: "21:00", is_closed: false }],
      writes: [],
      readFailures: {},
      singleFailures: {},
      updateFailures: {},
    };

    currentPlatformAdmin.mockResolvedValue(STAFF);
    serviceRoleClient.mockImplementation(() => ({
      from: (table: Table) => new FakeQuery(store, table),
    }));
    listPhoneNumbers.mockResolvedValue([]);
    findAssistantForLocation.mockResolvedValue({ id: ASSISTANT });
    getAssistant.mockResolvedValue({ id: ASSISTANT });
    tagAssistantForLocation.mockResolvedValue({ id: ASSISTANT });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function marty(): Row {
    return store.locations.find((l) => l.id === MARTY) as Row;
  }
  function nonna(): Row {
    return store.locations.find((l) => l.id === NONNA) as Row;
  }
  function step(result: { steps: { key: string }[] }, key: string) {
    return result.steps.find((s) => s.key === key) as {
      key: string;
      outcome: string;
      note: string;
      action?: string | null;
      number?: string | null;
    };
  }

  /** The assistant build, as it actually behaves: Vapi ends up holding a
   *  tagged assistant and the column ends up naming it. A mock that
   *  returned a bare object would let the run "succeed" against a Vapi
   *  that has nothing, which is the one thing this feature must not do. */
  function assistantGetsBuilt() {
    provisionAssistantForLocation.mockImplementation(async () => {
      marty().vapi_assistant_id = NEW_ASSISTANT;
      // Both columns, together, which is what the real one writes -- and
      // the difference between an assistant that can take an order and
      // one that 401s on every tool call.
      marty().agent_secret_hash = "sha256-fresh";
      findAssistantForLocation.mockResolvedValue({ id: NEW_ASSISTANT });
      getAssistant.mockResolvedValue({ id: NEW_ASSISTANT });
      return { secret: "s", assistantId: NEW_ASSISTANT };
    });
  }

  /** Vapi issues a number and binds it in the same call, so the account
   *  listing has it from that moment -- which is what the go-live check
   *  reads a beat later. */
  function vapiIssues(number = "+15105559999") {
    createPhoneNumber.mockImplementation(
      async (_key: string, { assistantId, name }: { assistantId: string; name: string }) => {
        const fresh = {
          id: "n-new",
          number,
          name,
          provider: "vapi",
          assistantId,
          status: "active",
        };
        listPhoneNumbers.mockResolvedValue([fresh]);
        return fresh;
      },
    );
  }

  function vapiBinds(number: string) {
    bindPhoneNumber.mockImplementation(
      async (
        _key: string,
        { phoneNumberId, assistantId, name }: { phoneNumberId: string; assistantId: string; name: string },
      ) => {
        const bound = { id: phoneNumberId, number, name, provider: "vapi", assistantId, status: "active" };
        listPhoneNumbers.mockResolvedValue([bound]);
        return bound;
      },
    );
  }

  /* ── the paved road ──────────────────────────────────────────────── */

  it("takes a restaurant with nothing but a fallback number all the way live", async () => {
    // Marty's from nothing: no assistant, no number, one field filled in.
    marty().vapi_assistant_id = null;
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockResolvedValue(null);
    assistantGetsBuilt();
    vapiIssues();

    const result = await makeItLive({ locationId: MARTY, base: BASE, areaCode: CONFIRMED });

    expect(result.ok).toBe(true);
    expect(marty().vapi_assistant_id).toBe(NEW_ASSISTANT);
    expect(marty().twilio_number).toBe("+15105559999");
    expect(marty().is_live).toBe(true);
    // Exactly one number was spent.
    expect(createPhoneNumber).toHaveBeenCalledTimes(1);

    expect(step(result, "fallback").outcome).toBe("already-ok");
    expect(step(result, "assistant")).toMatchObject({ outcome: "changed", action: "rebuilt" });
    expect(step(result, "number")).toMatchObject({ outcome: "changed", action: "provisioned" });
    expect(step(result, "live").outcome).toBe("changed");
  });

  it("hands back everything the operator has to read down the phone, and only on a new number", async () => {
    marty().vapi_assistant_id = null;
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockResolvedValue(null);
    assistantGetsBuilt();
    vapiIssues("+15106268819");

    const result = await makeItLive({ locationId: MARTY, base: BASE, areaCode: CONFIRMED });

    expect(result.newNumber).toEqual({
      // Vapi's own string, verbatim -- the Twilio voice route matches
      // inbound calls on it.
      e164: "+15106268819",
      spoken: "+1 (510) 626-8819",
      // Marty's has no line of its own, so there is nothing to forward
      // and the dialog has to say "publish this" rather than teach
      // forwarding codes.
      businessPhone: null,
      carrier: null,
      locationName: "Marty's",
    });
  });

  it("re-points a number the restaurant already owns instead of buying another", async () => {
    marty().twilio_number = "+15105550000";
    listPhoneNumbers.mockResolvedValue([
      { id: "n-mine", number: "+15105550000", name: "Marty's", provider: "vapi", assistantId: null, status: "active" },
    ]);
    vapiBinds("+15105550000");

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result.ok).toBe(true);
    expect(marty().is_live).toBe(true);
    expect(step(result, "number")).toMatchObject({ outcome: "changed", action: "attached-own" });
    // The whole point: the one-way door stayed shut.
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(result.newNumber).toBeNull();
    // And no assistant was rebuilt under a restaurant that had a working
    // one, so no tool secret rotated.
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("repairs the live restaurant whose record forgot its assistant, buying nothing", async () => {
    // Nonna Rosa as she actually is: live, answering calls on
    // +15106268819, vapi_assistant_id null in our database, and the
    // assistant tagged for her on Vapi.
    findAssistantForLocation.mockResolvedValue({ id: NONNA_ASSISTANT });
    getAssistant.mockResolvedValue({ id: NONNA_ASSISTANT });
    listPhoneNumbers.mockResolvedValue([
      {
        id: "n-nonna",
        number: "+15106268819",
        name: "Nonna Rosa",
        provider: "vapi",
        assistantId: NONNA_ASSISTANT,
        status: "active",
      },
    ]);

    const result = await makeItLive({ locationId: NONNA, base: BASE });

    expect(result.ok).toBe(true);
    expect(nonna().vapi_assistant_id).toBe(NONNA_ASSISTANT);
    expect(nonna().is_live).toBe(true);
    expect(nonna().twilio_number).toBe("+15106268819");

    expect(step(result, "assistant")).toMatchObject({ outcome: "changed", action: "reconnected" });
    expect(step(result, "number")).toMatchObject({ outcome: "already-ok", action: "already-bound" });

    // Nothing on Vapi moved: no rebuild (which rotates the secret the
    // assistant answering right now still uses), no re-bind, no number.
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
    expect(bindPhoneNumber).not.toHaveBeenCalled();
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(result.newNumber).toBeNull();
    // One write, and it is the repair. A number that already rings the
    // right assistant is not re-written for the sake of it.
    expect(store.writes.filter((w) => "twilio_number" in w.patch)).toEqual([]);
  });

  it("leaves somebody's kill switch exactly where they left it", async () => {
    // Turning a restaurant live is not authority to undo an emergency
    // act. setLocationLive's own sentence carries the caveat instead.
    marty().kill_switch_on = true;
    marty().twilio_number = "+15105550000";
    listPhoneNumbers.mockResolvedValue([
      { id: "n-mine", number: "+15105550000", name: "Marty's", provider: "vapi", assistantId: ASSISTANT, status: "active" },
    ]);

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result.ok).toBe(true);
    expect(marty().kill_switch_on).toBe(true);
    expect(store.writes.some((w) => "kill_switch_on" in w.patch)).toBe(false);
    expect(result.ok && result.message).toMatch(/straight to a person/);
  });

  /* ── the blocker no button can clear ─────────────────────────────── */

  it("stops on a missing fallback number before it reads, writes or spends anything", async () => {
    // The one fact only a human has. It is checked first precisely
    // because the step after it is the one that mints an undeletable
    // resource -- a run that would stop here anyway must not get that
    // far.
    marty().fallback_human_number = null;
    marty().vapi_assistant_id = null;
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockResolvedValue(null);

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result).toMatchObject({
      ok: false,
      halt: "fallback",
      // The whole UI instruction: put the cursor in the one field that
      // can be the answer.
      focus: "fallback",
      blockedBy: ["fallback"],
    });
    expect(result.ok === false && result.error).toMatch(/fallback number/);

    expect(store.writes).toEqual([]);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
    expect(bindPhoneNumber).not.toHaveBeenCalled();
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(tagAssistantForLocation).not.toHaveBeenCalled();
    expect(marty().is_live).toBe(false);

    expect(step(result, "fallback").outcome).toBe("refused");
    expect(step(result, "assistant").outcome).toBe("not-reached");
    expect(step(result, "number").outcome).toBe("not-reached");
    expect(step(result, "live").outcome).toBe("not-reached");
  });

  it("refuses to mint a number while who-owns-what could not be read", async () => {
    store.readFailures.locations = { code: "57014" };
    listPhoneNumbers.mockResolvedValue([
      { id: "n-free", number: "+15105550001", name: null, provider: "vapi", assistantId: null, status: "active" },
    ]);

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result).toMatchObject({ ok: false, halt: "ownership-unreadable" });
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(bindPhoneNumber).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
    expect(marty().is_live).toBe(false);
  });

  /* ── failing partway ─────────────────────────────────────────────── */

  it("refuses outright while Vapi cannot be read, rather than acting on unread facts", async () => {
    listPhoneNumbers.mockRejectedValue(new Error("Vapi did not answer within 5s (GET /phone-number)"));

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result).toMatchObject({ ok: false, halt: "vapi-unreadable" });
    expect(store.writes).toEqual([]);
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(marty().is_live).toBe(false);
  });

  it("stops at the assistant when Vapi fails there, and never reaches the number", async () => {
    marty().vapi_assistant_id = null;
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockResolvedValue(null);
    provisionAssistantForLocation.mockRejectedValue(new Error("Vapi returned 500"));

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result.ok).toBe(false);
    expect(step(result, "assistant").outcome).toBe("failed");
    expect(step(result, "number").outcome).toBe("not-reached");
    expect(step(result, "live").outcome).toBe("not-reached");
    // Nothing was bought for a restaurant that cannot answer.
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(marty().is_live).toBe(false);
  });

  it("says so and stays offline when Vapi refuses to issue a number", async () => {
    createPhoneNumber.mockRejectedValue(new Error("Vapi returned 402"));

    const result = await makeItLive({ locationId: MARTY, base: BASE, areaCode: CONFIRMED });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/No number was issued/);
    expect(result.newNumber).toBeNull();
    expect(marty().twilio_number).toBeNull();
    expect(marty().is_live).toBe(false);
    expect(step(result, "live").outcome).toBe("not-reached");
  });

  it("mints in the area code the operator confirmed, not the one the record suggests", async () => {
    /* The record suggests 510 -- business_phone -- and the operator
       typed 925 into the confirmation before pressing. 925 is the code
       a customer will read off the door, so 925 is what Vapi is asked
       for. The suggestion is a suggestion; what a person answered is
       what gets spent. */
    marty().business_phone = "(510) 555-0142";
    vapiIssues("+19255559999");

    await expect(
      makeItLive({ locationId: MARTY, base: BASE, areaCode: "925" }),
    ).resolves.toMatchObject({ ok: true });

    expect(createPhoneNumber).toHaveBeenCalledWith("vapi-test-key", {
      assistantId: ASSISTANT,
      name: "Marty's",
      areaCode: "925",
    });
  });

  it("refuses to mint in an area code nobody confirmed, however plainly the record suggests one", async () => {
    /* The regression, and the reason the confirmation exists. This is
       the common first-run shape: a restaurant with its own line, an
       assistant, a fallback, and an account with nothing on it to
       reuse. One press used to reach POST /phone-number and issue a
       real, billed, unreturnable number in whatever area code
       business_phone happened to be in -- a code that appeared nowhere
       on the screen before or during the press.

       A suggestion nobody looked at is a guess with a citation, so the
       run stops at the number step, turns nothing on, and names the
       code it WOULD offer so the next press is one press. */
    marty().business_phone = "(510) 555-0142";
    vapiIssues();

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result.ok).toBe(false);
    // The assertion that matters: nothing left this process. A rejected
    // promise proves nothing once a number can exist.
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(marty().twilio_number).toBeNull();
    expect(marty().is_live).toBe(false);
    expect(result.newNumber).toBeNull();
    expect(result.ok === false && result.halt).toBe("area-code");
    expect(step(result, "number")).toMatchObject({ outcome: "refused", action: null, number: null });
    expect(result.ok === false && result.error).toMatch(/510/);
    expect(result.ok === false && result.error).toMatch(/nothing was spent/i);
    expect(step(result, "live").outcome).toBe("not-reached");
  });

  it("refuses an area code that is not one, before it asks Vapi for anything", async () => {
    // A hand-rolled POST to the action id can carry anything at all, and
    // the shape is checked on this road exactly as it is on the
    // standalone one -- before a number is asked for, not after.
    marty().business_phone = "(510) 555-0142";
    vapiIssues();

    for (const bogus of ["115", "015", "51", "5105", "bay", ""]) {
      const result = await makeItLive({ locationId: MARTY, base: BASE, areaCode: bogus });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.halt).toBe("area-code");
    }
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(marty().twilio_number).toBeNull();
    expect(marty().is_live).toBe(false);
  });

  it("never says a number was not issued when nobody could read whether it was", async () => {
    /* A deadline, a gateway 5xx or an unparseable 201 on a POST that
       ALLOCATES leaves one question open, and the one answer that must
       never be given to it is "No number was issued" -- an operator who
       reads that presses the button again, and the second press is the
       one that mints the duplicate. */
    createPhoneNumber.mockRejectedValue(
      new NumberOutcomeUnknownError("Vapi did not answer within 20s (POST /phone-number)."),
    );

    const result = await makeItLive({ locationId: MARTY, base: BASE, areaCode: CONFIRMED });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toMatch(/No number was issued/);
    expect(result.ok === false && result.error).toMatch(/cannot tell whether a number was issued/);
    expect(result.ok === false && result.error).toMatch(/Vapi dashboard/);
    expect(marty().twilio_number).toBeNull();
    expect(marty().is_live).toBe(false);
  });

  it("refuses to guess an area code, and mints nothing, when neither number yields one", async () => {
    /* The whole point of the field. A guessed area code is a real,
       billed, unreturnable number in the wrong city, printed on a door
       -- and it only becomes visible after it cannot be taken back. So
       this step stops exactly as the missing-fallback step stops, and
       the sentence names the button that fixes it. */
    marty().business_phone = null;
    marty().fallback_human_number = "+442071838750";
    vapiIssues();

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result.ok).toBe(false);
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(marty().twilio_number).toBeNull();
    expect(marty().is_live).toBe(false);
    expect(result.newNumber).toBeNull();
    expect(step(result, "number")).toMatchObject({ outcome: "refused", action: null, number: null });
    expect(result.ok === false && result.error).toMatch(/no area code to get a number in/i);
    // The button that fixes it, named, and on this panel.
    expect(result.ok === false && result.error).toMatch(/Get a new number/);
    expect(step(result, "live").outcome).toBe("not-reached");
  });

  it("carries an empty area code through as its own sentence, not as a broken deployment", async () => {
    createPhoneNumber.mockRejectedValue(new NoNumberInAreaCodeError("878"));

    const result = await makeItLive({ locationId: MARTY, base: BASE, areaCode: CONFIRMED });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/no free number in area code 878/);
    expect(result.ok === false && result.error).toMatch(/neighbouring area code/);
    expect(result.newNumber).toBeNull();
    expect(marty().is_live).toBe(false);
  });

  it("keeps a number Vapi issued, names it, and shows the handover even though the run failed", async () => {
    // The number exists and is billing. Deleting it is the one
    // irreversible act in this feature and no machine gets to take it
    // seconds after the number came into being -- so the rollback IS
    // reporting it. The next run finds it claimed by this assistant and
    // attaches it.
    vapiIssues("+15105557777");
    store.updateFailures = { locations: { code: "57014" } };

    const result = await makeItLive({ locationId: MARTY, base: BASE, areaCode: CONFIRMED });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/\+15105557777/);
    expect(result.ok === false && result.error).toMatch(/Do not ask for another one/);
    // The dialog must still open: this is the operator's only copy.
    expect(result.newNumber).toMatchObject({ e164: "+15105557777", spoken: "+1 (510) 555-7777" });
    expect(step(result, "number")).toMatchObject({ outcome: "failed", action: "provisioned" });
    expect(marty().is_live).toBe(false);
  });

  it("never overwrites a number that appeared while it was away at Vapi", async () => {
    // The compare-and-set. Between deciding to mint and writing the
    // result there is a Vapi round trip, and another run can win it.
    // The loser must keep the winner's number in the column and shout
    // about the one it just created.
    createPhoneNumber.mockImplementation(async () => {
      marty().twilio_number = "+15105551111";
      return { id: "n-new", number: "+15105558888", name: "Marty's", provider: "vapi", assistantId: ASSISTANT, status: "active" };
    });

    const result = await makeItLive({ locationId: MARTY, base: BASE, areaCode: CONFIRMED });

    expect(result.ok).toBe(false);
    expect(marty().twilio_number).toBe("+15105551111");
    expect(result.ok === false && result.error).toMatch(/\+15105558888/);
    expect(result.newNumber).toMatchObject({ e164: "+15105558888" });
    // The update ran and changed nothing, which is what "lost the
    // compare-and-set" looks like from here.
    expect(store.writes.some((w) => "twilio_number" in w.patch && w.applied === 0)).toBe(true);
    expect(marty().is_live).toBe(false);
  });

  it("keeps a number Vapi bound when only writing it down failed, and names it", async () => {
    marty().twilio_number = null;
    listPhoneNumbers.mockResolvedValue([
      { id: "n-free", number: "+15105550001", name: null, provider: "vapi", assistantId: null, status: "active" },
    ]);
    bindPhoneNumber.mockResolvedValue({
      id: "n-free",
      number: "+15105550001",
      name: "Marty's",
      provider: "vapi",
      assistantId: ASSISTANT,
      status: "active",
    });
    store.updateFailures = { locations: { code: "57014" } };

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result.ok).toBe(false);
    // Unbinding would take a number away from a restaurant that is now
    // reachable on it, and the binding is the correct end state anyway.
    expect(result.ok === false && result.error).toMatch(/\+15105550001/);
    expect(step(result, "number")).toMatchObject({ outcome: "failed", number: "+15105550001" });
    expect(marty().is_live).toBe(false);
  });

  it("never marks a restaurant live once the number stops checking out", async () => {
    // The safety property that survives every ordering of failures:
    // is_live is written by setLocationLive alone, which re-derives all
    // three blockers from Postgres AND Vapi. Here the number disappears
    // from the account in the instant after it was bound.
    marty().twilio_number = null;
    listPhoneNumbers.mockResolvedValue([
      { id: "n-free", number: "+15105550001", name: null, provider: "vapi", assistantId: null, status: "active" },
    ]);
    bindPhoneNumber.mockImplementation(async () => {
      listPhoneNumbers.mockResolvedValue([]);
      return { id: "n-free", number: "+15105550001", name: "Marty's", provider: "vapi", assistantId: ASSISTANT, status: "active" };
    });

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result.ok).toBe(false);
    expect(marty().is_live).toBe(false);
    expect(store.writes.some((w) => "is_live" in w.patch)).toBe(false);
    expect(step(result, "number").outcome).toBe("changed");
    expect(step(result, "live").outcome).toBe("failed");
  });

  /* ── the account moving underneath a derivation ──────────────────── */

  it("does not take a free number another restaurant's run bound while this one was deciding", async () => {
    /* Two operators, two restaurants, one free number, ten seconds
       apart. Both runs derive while it is unclaimed and planNumber sends
       both at the same row. Without the re-read before the PATCH, the
       second run points a number the first restaurant is already live on
       at its own assistant -- every customer who dials it then orders
       from the wrong menu, and nothing turns the first restaurant back
       off, because its is_live was written before any of this. */
    marty().twilio_number = null;
    const free = { id: "n-free", number: "+15105550001", name: null, provider: "vapi", assistantId: null, status: "active" };
    listPhoneNumbers
      .mockResolvedValueOnce([free])
      .mockResolvedValue([{ ...free, name: "Nonna Rosa", assistantId: NONNA_ASSISTANT }]);

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result.ok).toBe(false);
    expect(bindPhoneNumber).not.toHaveBeenCalled();
    // And it does not "recover" by spending a new one on the strength of
    // a derivation that has just been proved stale.
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(marty().twilio_number).toBeNull();
    expect(marty().is_live).toBe(false);
  });

  it("does not buy a second number for a restaurant already answering on a contested one", async () => {
    /* Nonna Rosa's row still holds +15106268819 and somebody has
       re-pointed that number at Marty's assistant in the Vapi dashboard.
       Callers dialling it reach Marty's right now. The double claim is
       something only a person can settle -- and buying Marty's a second
       number settles none of it while billing per minute for the
       privilege. */
    marty().twilio_number = null;
    listPhoneNumbers.mockResolvedValue([
      { id: "n-both", number: "+15106268819", name: "Nonna Rosa", provider: "vapi", assistantId: ASSISTANT, status: "active" },
    ]);

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.halt).toBe("vapi-dashboard");
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(bindPhoneNumber).not.toHaveBeenCalled();
    expect(step(result, "number").outcome).toBe("refused");
    expect(marty().is_live).toBe(false);
  });

  /* ── an assistant nothing can authenticate ───────────────────────── */

  it("re-provisions an assistant with no tool secret instead of reconnecting and going live", async () => {
    /* The state a failed hash write leaves behind: Vapi holds a tagged
       assistant, the record names it, and there is no digest for
       lib/agent/auth.ts to match its tool calls against. Reconnecting
       would take one press to a green checklist over an agent that
       greets the caller and then cannot read the menu. */
    marty().agent_secret_hash = null;
    marty().twilio_number = "+15105550000";
    listPhoneNumbers.mockResolvedValue([
      { id: "n-mine", number: "+15105550000", name: "Marty's", provider: "vapi", assistantId: ASSISTANT, status: "active" },
    ]);
    provisionAssistantForLocation.mockImplementation(async () => {
      marty().agent_secret_hash = "sha256-fresh";
      return { secret: "s", assistantId: ASSISTANT, created: false };
    });

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(provisionAssistantForLocation).toHaveBeenCalledTimes(1);
    expect(step(result, "assistant")).toMatchObject({ outcome: "changed", action: "rebuilt" });
    expect(result.ok).toBe(true);
    expect(marty().agent_secret_hash).toBe("sha256-fresh");
    expect(marty().is_live).toBe(true);
    // The number it was already answering on was not re-bought.
    expect(createPhoneNumber).not.toHaveBeenCalled();
  });

  it("leaves a restaurant off when its tool secret still cannot be minted", async () => {
    marty().agent_secret_hash = null;
    marty().twilio_number = "+15105550000";
    listPhoneNumbers.mockResolvedValue([
      { id: "n-mine", number: "+15105550000", name: "Marty's", provider: "vapi", assistantId: ASSISTANT, status: "active" },
    ]);
    provisionAssistantForLocation.mockRejectedValue(new Error("Vapi returned 500"));

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result.ok).toBe(false);
    expect(marty().is_live).toBe(false);
    expect(store.writes.some((w) => "is_live" in w.patch)).toBe(false);
  });

  /* ── pressing it twice ───────────────────────────────────────────── */

  it("does not issue two numbers when the button is double-clicked", async () => {
    vapiIssues();

    const [first, second] = await Promise.all([
      makeItLive({ locationId: MARTY, base: BASE, areaCode: CONFIRMED }),
      makeItLive({ locationId: MARTY, base: BASE, areaCode: CONFIRMED }),
    ]);

    // A single flight per restaurant: the second press joins the first
    // run rather than starting its own.
    expect(createPhoneNumber).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.ok).toBe(true);
    expect(store.writes.filter((w) => "twilio_number" in w.patch)).toHaveLength(1);
    expect(marty().twilio_number).toBe("+15105559999");
  });

  it("does not issue a second number when it is pressed again after it worked", async () => {
    vapiIssues();

    await expect(
      makeItLive({ locationId: MARTY, base: BASE, areaCode: CONFIRMED }),
    ).resolves.toMatchObject({ ok: true });
    const again = await makeItLive({ locationId: MARTY, base: BASE, areaCode: CONFIRMED });

    // Every irreversible decision is re-derived from a fresh read, so
    // the second run simply finds a restaurant that is already right.
    expect(again.ok).toBe(true);
    expect(createPhoneNumber).toHaveBeenCalledTimes(1);
    expect(again.newNumber).toBeNull();
    expect(step(again, "number")).toMatchObject({ outcome: "already-ok", action: "already-bound" });
    expect(marty().twilio_number).toBe("+15105559999");
  });

  it("runs two different restaurants at once without either waiting on the other", async () => {
    // The single flight is keyed by restaurant, not global. An operator
    // turning on two restaurants must not have one silently return the
    // other's result, and must not have one blocked behind the other.
    marty().twilio_number = "+15105550000";
    findAssistantForLocation.mockImplementation(async (_key: string, id: string) =>
      id === NONNA ? { id: NONNA_ASSISTANT } : { id: ASSISTANT },
    );
    getAssistant.mockImplementation(async (_key: string, id: string) => ({ id }));
    listPhoneNumbers.mockResolvedValue([
      { id: "n-nonna", number: "+15106268819", name: "Nonna Rosa", provider: "vapi", assistantId: NONNA_ASSISTANT, status: "active" },
      { id: "n-marty", number: "+15105550000", name: "Marty's", provider: "vapi", assistantId: ASSISTANT, status: "active" },
    ]);

    const [a, b] = await Promise.all([
      makeItLive({ locationId: NONNA, base: BASE }),
      makeItLive({ locationId: MARTY, base: BASE }),
    ]);

    // Two runs, two results. Not one run answering for both.
    expect(a).not.toBe(b);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(nonna().is_live).toBe(true);
    expect(marty().is_live).toBe(true);
    expect(createPhoneNumber).not.toHaveBeenCalled();
  });

  /* ── the gate ────────────────────────────────────────────────────── */

  it("tells a caller who is not staff nothing, and touches nothing", async () => {
    // A "use server" export is a live endpoint the moment it compiles,
    // and this one can spend money. The gate is its first statement --
    // before the uuid check, and before the single-flight map, because
    // joining a run in progress is itself an answer.
    currentPlatformAdmin.mockResolvedValue(null);
    serviceRoleClient.mockImplementation(() => {
      throw new Error("the service-role client must not be reachable by a non-admin caller");
    });

    const result = await makeItLive({ locationId: MARTY, base: BASE });

    expect(result).toMatchObject({ ok: false, error: "Not found." });
    expect(listPhoneNumbers).not.toHaveBeenCalled();
    expect(findAssistantForLocation).not.toHaveBeenCalled();
    expect(createPhoneNumber).not.toHaveBeenCalled();
  });

  it("refuses a malformed location id before it reaches the database", async () => {
    const result = await makeItLive({ locationId: `../../${OWNER_ID}`, base: BASE });
    expect(result).toMatchObject({ ok: false, error: "Not found." });
    expect(store.writes).toEqual([]);
  });

  it("refuses a restaurant that is not there with the same sentence", async () => {
    const result = await makeItLive({
      locationId: "00000000-0000-0000-0000-000000000000",
      base: BASE,
    });
    expect(result).toMatchObject({ ok: false, error: "Not found." });
    expect(store.writes).toEqual([]);
  });

  it("will not build an assistant against an address Vapi cannot reach", async () => {
    marty().vapi_assistant_id = null;
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockResolvedValue(null);

    const result = await makeItLive({ locationId: MARTY, base: "http://localhost:3000" });

    expect(result).toMatchObject({ ok: false, halt: "deployment-address" });
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
    expect(createPhoneNumber).not.toHaveBeenCalled();
    expect(store.writes).toEqual([]);
  });
});
