import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantSecretWriteError } from "@/lib/provisioning/assistant";

/* Editing a restaurant that is already answering the phone.
 *
 * Three separate things can hurt somebody here, and the file is in three
 * parts because of it:
 *
 *   1. THE VALUES. Every range below is a CHECK constraint that really
 *      exists, and the cost of getting one wrong is not a Postgres error
 *      -- it is a restaurant that quietly takes 3 AM orders (an hours row
 *      that closes before it opens), refuses every booking (a seat count
 *      of zero), or charges the wrong tax on every ticket from the next
 *      call. The boundary cases are tested on both sides, because "0-2000"
 *      passing at 2000 and failing at 2001 is the whole assertion.
 *
 *   2. THE GATE AND THE TENANT BOUNDARY. Every export runs with the
 *      service-role key, which bypasses RLS on every table for every
 *      tenant, and each one is a live HTTP endpoint the moment it
 *      compiles. A menu item id is a selector, not a permission: swapping
 *      one restaurant's item id into another's editor must fail on a set
 *      this module rebuilds for itself. And a refusal must write NOTHING,
 *      which is why the fake PostgREST below records every statement.
 *
 *   3. THE PHONE. Six columns are baked into the Vapi assistant at build
 *      time and never re-read on a call. Editing one without a re-sync
 *      leaves the phone saying the old thing forever with no error
 *      anywhere -- so a failed rebuild must come back saying so, and must
 *      never roll the column back.
 */

const currentPlatformAdmin = vi.fn();
vi.mock("@/lib/admin/auth", () => ({
  currentPlatformAdmin: () => currentPlatformAdmin(),
}));

const serviceRoleClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: () => serviceRoleClient() }));

const provisionAssistantForLocation = vi.fn();
/* Partial, not whole: AssistantSecretWriteError has to be the REAL class
   or `err instanceof AssistantSecretWriteError` in edit.ts is testing a
   different constructor than the one the product throws -- and that
   branch is the one that tells an operator their assistant will answer
   the phone and then 401 on every tool call. */
vi.mock("@/lib/provisioning/assistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/provisioning/assistant")>()),
  provisionAssistantForLocation: (...args: unknown[]) => provisionAssistantForLocation(...args),
}));

/* The three reads syncAssistant makes BEFORE it pushes anything, to
   decide which assistant a rebuild is going to land on. Partial again:
   ProvisioningError has to be the real class, and so do the pure helpers
   the rest of the module exports. Nothing here reaches api.vapi.ai. */
const findAssistantForLocation = vi.fn();
const getAssistant = vi.fn();
const tagAssistantForLocation = vi.fn();
vi.mock("@/lib/vapi/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vapi/provision")>()),
  findAssistantForLocation: (...args: unknown[]) => findAssistantForLocation(...args),
  getAssistant: (...args: unknown[]) => getAssistant(...args),
  tagAssistantForLocation: (...args: unknown[]) => tagAssistantForLocation(...args),
}));

const {
  GREETING_MAX,
  SEATS_MAX,
  SYNCED_COLUMNS,
  createMenuCategory,
  createMenuItem,
  deleteHoliday,
  deleteMenuCategory,
  deleteMenuItem,
  getEditableRecord,
  hoursSignature,
  isValidTimezone,
  normaliseItemName,
  resyncAssistant,
  saveAnswering,
  saveBusiness,
  saveHoliday,
  saveHours,
  saveMenuCategory,
  saveMenuItem,
  saveOrderRouting,
  saveRecording,
  saveService,
  setMenuItemSoldOut,
  touchesAssistant,
  validateAnswering,
  validateBusiness,
  validateCategory,
  validateHoliday,
  validateHours,
  validateMenuItem,
  validateOrderRouting,
  validateRecording,
  validateService,
  validateSoldOut,
} = await import("./edit");

const STAFF = {
  userId: "99999999-9999-9999-9999-999999999999",
  email: "admin@dialtone.test",
  note: "operator",
};

const MARTY = "d7be1400-7c38-4933-a248-407ff339cd73";
const NONNA = "a10c0000-0000-0000-0000-00000000000a";
const MARTY_ORG = "0e9a0000-0000-0000-0000-0000000000a1";
const NONNA_ORG = "0e9a0000-0000-0000-0000-0000000000a2";
const ASSISTANT = "aaaaaaaa-0000-0000-0000-000000000001";

const MARTY_CATEGORY = "c0000000-0000-0000-0000-0000000000c1";
const NONNA_CATEGORY = "c0000000-0000-0000-0000-0000000000c2";
const MARTY_ITEM = "17e00000-0000-0000-0000-0000000000e1";
const NONNA_ITEM = "17e00000-0000-0000-0000-0000000000e2";
const MARTY_HOLIDAY = "40110000-0000-0000-0000-000000000d01";
const NONNA_HOLIDAY = "40110000-0000-0000-0000-000000000d02";

/* This deployment's own configured public origin -- what a rebuild is
   built from. NOT the browser's Origin header, which is only compared
   against it: see configuredOrigin() in edit.ts. */
const BASE = "https://dialtone.example.com";

/** locations.updated_at as a form rendered right now would carry it. The
 *  save is conditional on it, and the fake below moves it on every
 *  update the way the locations_touch trigger does, so reading it here
 *  is the same act the page performs. */
function seen(locationId: string = MARTY): string {
  const row = store.locations.find((l) => l.id === locationId);
  return String(row?.updated_at ?? "");
}

/** The week on file, as the grid that rendered it would send it back. */
function seenWeek(locationId: string = MARTY): string {
  return hoursSignature(
    store.hours
      .filter((h) => h.location_id === locationId)
      .map((h) => ({
        day_of_week: Number(h.day_of_week),
        open_time: h.open_time as string | null,
        close_time: h.close_time as string | null,
        is_closed: Boolean(h.is_closed),
      })),
  );
}

/* ════ 1. the values ══════════════════════════════════════════════ */

function businessInput(over: Partial<Parameters<typeof validateBusiness>[0]> = {}) {
  return {
    orgName: "Marty's Group",
    plan: "starter",
    name: "Marty's",
    timezone: "America/Los_Angeles",
    address: "1 Main St, Oakland CA",
    businessPhone: "(510) 555-0199",
    carrierName: "AT&T",
    ...over,
  };
}

describe("the business section, validated", () => {
  it("accepts a complete business and normalizes the display phone to E.164", () => {
    const checked = validateBusiness(businessInput());
    expect(checked).toMatchObject({ ok: true });
    if (!checked.ok) return;
    expect(checked.value.businessPhone).toBe("+15105550199");
    expect(checked.value.plan).toBe("starter");
  });

  it("refuses a blank restaurant name -- the agent says it twice per call", () => {
    expect(validateBusiness(businessInput({ name: "  " }))).toEqual({
      ok: false,
      error: "Enter the restaurant's name.",
    });
  });

  it("refuses a plan outside the CHECK constraint", () => {
    // check (plan in ('trial','starter','growth')), 20260807000100.
    expect(validateBusiness(businessInput({ plan: "enterprise" })).ok).toBe(false);
    for (const plan of ["trial", "starter", "growth"]) {
      expect(validateBusiness(businessInput({ plan })).ok).toBe(true);
    }
  });

  it("stores a blank address as null rather than an empty string", () => {
    const checked = validateBusiness(businessInput({ address: "   " }));
    expect(checked.ok && checked.value.address).toBeNull();
  });

  it("refuses a display phone that cannot be dialled, and keeps blank as blank", () => {
    expect(validateBusiness(businessInput({ businessPhone: "call us!" })).ok).toBe(false);
    const blank = validateBusiness(businessInput({ businessPhone: "" }));
    expect(blank.ok && blank.value.businessPhone).toBeNull();
  });
});

describe("timezone, which is the one free-text field that can kill a call", () => {
  it("accepts real IANA zones", () => {
    for (const zone of ["America/Los_Angeles", "America/New_York", "Europe/London", "UTC"]) {
      expect(isValidTimezone(zone)).toBe(true);
    }
  });

  it("refuses anything Intl would throw a RangeError on", () => {
    // No route under app/api/agent/ catches exceptions, so a RangeError
    // inside Intl.DateTimeFormat is a framework 500, which Vapi discards,
    // which the caller hears as dead air.
    for (const zone of ["Mars/Phobos", "America/Los Angeles", "not a zone", "", "   "]) {
      expect(isValidTimezone(zone)).toBe(false);
    }
  });

  it("refuses a bare UTC offset, which some engines accept and which loses daylight saving", () => {
    expect(isValidTimezone("+05:30")).toBe(false);
    expect(isValidTimezone("-08:00")).toBe(false);
  });

  it("refuses the whole business section on a bad zone, with a sentence about the list", () => {
    const checked = validateBusiness(businessInput({ timezone: "Pacific/Nowhere" }));
    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.error).toMatch(/Pick one from the list/);
  });
});

describe("answering the phone, validated", () => {
  it("normalizes the fallback number to E.164, which is all Vapi's transferCall accepts", () => {
    const checked = validateAnswering({ greetingText: "Hi!", fallbackNumber: "(510) 555-0100" });
    expect(checked.ok && checked.value.fallbackNumber).toBe("+15105550100");
  });

  it("refuses a blank fallback number rather than silently unhooking allergy transfers", () => {
    expect(validateAnswering({ greetingText: "", fallbackNumber: "  " }).ok).toBe(false);
    expect(validateAnswering({ greetingText: "", fallbackNumber: "nope" }).ok).toBe(false);
  });

  it("allows an empty greeting, which falls back to the generated line", () => {
    const checked = validateAnswering({ greetingText: "  ", fallbackNumber: "5105550100" });
    expect(checked.ok && checked.value.greetingText).toBe("");
  });

  it("refuses a greeting longer than Vapi's firstMessage should ever be", () => {
    const long = "a".repeat(GREETING_MAX + 1);
    expect(validateAnswering({ greetingText: long, fallbackNumber: "5105550100" }).ok).toBe(false);
    const atLimit = "a".repeat(GREETING_MAX);
    expect(validateAnswering({ greetingText: atLimit, fallbackNumber: "5105550100" }).ok).toBe(true);
  });
});

function serviceInput(over: Partial<Parameters<typeof validateService>[0]> = {}) {
  return {
    taxPercent: "8.75",
    orderTypes: "both",
    pickupPromiseMinutes: "25",
    deliveryPromiseMinutes: "45",
    seats: "40",
    maxPartySize: "8",
    reservationSlotMinutes: "90",
    ...over,
  };
}

describe("money & service, at every boundary of every constraint", () => {
  it("converts a typed percentage into whole basis points without a float multiply", () => {
    const checked = validateService(serviceInput({ taxPercent: "8.75" }));
    expect(checked.ok && checked.value.taxRateBps).toBe(875);
    // 6.625% is a real California district rate and rounds to the
    // nearest basis point; 6.625 * 100 in binary floating point is
    // 662.4999999999999.
    const odd = validateService(serviceInput({ taxPercent: "6.625" }));
    expect(odd.ok && odd.value.taxRateBps).toBe(663);
  });

  it("holds tax to 0..2000 basis points", () => {
    expect(validateService(serviceInput({ taxPercent: "0" })).ok).toBe(true);
    expect(validateService(serviceInput({ taxPercent: "20" })).ok).toBe(true);
    expect(validateService(serviceInput({ taxPercent: "20.01" })).ok).toBe(false);
    expect(validateService(serviceInput({ taxPercent: "-1" })).ok).toBe(false);
    expect(validateService(serviceInput({ taxPercent: "eight" })).ok).toBe(false);
  });

  it("holds order_types to the enum", () => {
    for (const value of ["pickup", "delivery", "both"]) {
      expect(validateService(serviceInput({ orderTypes: value })).ok).toBe(true);
    }
    expect(validateService(serviceInput({ orderTypes: "dine-in" })).ok).toBe(false);
  });

  it("holds both promise times to 5..180 minutes", () => {
    for (const field of ["pickupPromiseMinutes", "deliveryPromiseMinutes"] as const) {
      expect(validateService(serviceInput({ [field]: "4" })).ok).toBe(false);
      expect(validateService(serviceInput({ [field]: "5" })).ok).toBe(true);
      expect(validateService(serviceInput({ [field]: "180" })).ok).toBe(true);
      expect(validateService(serviceInput({ [field]: "181" })).ok).toBe(false);
      expect(validateService(serviceInput({ [field]: "22.5" })).ok).toBe(false);
    }
  });

  it("holds seats above zero, and refuses a fat-fingered dining room", () => {
    expect(validateService(serviceInput({ seats: "0" })).ok).toBe(false);
    expect(validateService(serviceInput({ seats: "1" })).ok).toBe(true);
    expect(validateService(serviceInput({ seats: String(SEATS_MAX) })).ok).toBe(true);
    expect(validateService(serviceInput({ seats: String(SEATS_MAX + 1) })).ok).toBe(false);
  });

  it("holds max party size to 1..40 and the reservation slot to 30..240", () => {
    expect(validateService(serviceInput({ maxPartySize: "0" })).ok).toBe(false);
    expect(validateService(serviceInput({ maxPartySize: "1" })).ok).toBe(true);
    expect(validateService(serviceInput({ maxPartySize: "40" })).ok).toBe(true);
    expect(validateService(serviceInput({ maxPartySize: "41" })).ok).toBe(false);

    expect(validateService(serviceInput({ reservationSlotMinutes: "29" })).ok).toBe(false);
    expect(validateService(serviceInput({ reservationSlotMinutes: "30" })).ok).toBe(true);
    expect(validateService(serviceInput({ reservationSlotMinutes: "240" })).ok).toBe(true);
    expect(validateService(serviceInput({ reservationSlotMinutes: "241" })).ok).toBe(false);
  });
});

describe("where orders go, validated", () => {
  it("normalizes the kitchen number, because Twilio silently drops anything else", () => {
    const checked = validateOrderRouting({
      orderDelivery: "sms",
      orderSmsTo: "510-555-0123",
      orderEmailTo: "",
    });
    expect(checked.ok && checked.value.orderSmsTo).toBe("+15105550123");
    expect(checked.ok && checked.value.orderEmailTo).toBeNull();
  });

  it("refuses a kitchen number that is not dialable, rather than storing a silent failure", () => {
    const checked = validateOrderRouting({
      orderDelivery: "sms",
      orderSmsTo: "the landline",
      orderEmailTo: "",
    });
    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.error).toMatch(/no ticket reaches the kitchen/);
  });

  it("holds order_delivery to the enum and checks the email", () => {
    for (const value of ["sms", "email", "both"]) {
      expect(
        validateOrderRouting({ orderDelivery: value, orderSmsTo: "", orderEmailTo: "" }).ok,
      ).toBe(true);
    }
    expect(
      validateOrderRouting({ orderDelivery: "fax", orderSmsTo: "", orderEmailTo: "" }).ok,
    ).toBe(false);
    expect(
      validateOrderRouting({ orderDelivery: "sms", orderSmsTo: "", orderEmailTo: "kitchen" }).ok,
    ).toBe(false);
  });
});

describe("recording retention, at its constraint", () => {
  it("holds retention to 1..365 days", () => {
    const at = (days: string) =>
      validateRecording({ recordingEnabled: true, recordingRetentionDays: days }).ok;
    expect(at("0")).toBe(false);
    expect(at("1")).toBe(true);
    expect(at("365")).toBe(true);
    expect(at("366")).toBe(false);
    expect(at("")).toBe(false);
  });
});

function week(over: Partial<Record<number, { closed?: boolean; open?: string; close?: string }>> = {}) {
  return [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek,
    closed: false,
    open: "11:00",
    close: "21:00",
    ...over[dayOfWeek],
  }));
}

describe("hours, where a bad row means a restaurant that never closes", () => {
  it("accepts a full week", () => {
    const checked = validateHours(week());
    expect(checked.ok).toBe(true);
    expect(checked.ok && checked.value).toHaveLength(7);
  });

  it("refuses anything short of seven days", () => {
    expect(validateHours(week().slice(0, 6))).toEqual({
      ok: false,
      error: "Set hours for all seven days.",
    });
  });

  it("refuses a day that is open with no times", () => {
    const checked = validateHours(week({ 2: { open: "", close: "" } }));
    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.error).toMatch(/Tuesday/);
  });

  it("refuses close <= open, which the database would happily accept", () => {
    // There is no such CHECK. Let one through and lib/agent/hours.ts's
    // openAt returns unknown/crosses_midnight, which every agent route
    // deliberately treats as OPEN -- a restaurant taking 3 AM orders,
    // with no error anywhere.
    const crosses = validateHours(week({ 5: { open: "17:00", close: "02:00" } }));
    expect(crosses.ok).toBe(false);
    expect(crosses.ok === false && crosses.error).toMatch(/cross midnight/);

    const equal = validateHours(week({ 5: { open: "17:00", close: "17:00" } }));
    expect(equal.ok).toBe(false);
  });

  it("drops the times on a closed day rather than storing hours nobody keeps", () => {
    const checked = validateHours(week({ 0: { closed: true } }));
    expect(checked.ok && checked.value[0]).toEqual({
      day_of_week: 0,
      open_time: null,
      close_time: null,
      is_closed: true,
    });
  });
});

describe("holiday hours, which have no constraints at all", () => {
  it("accepts a closed date", () => {
    const checked = validateHoliday({ date: "2026-11-26", closed: true, open: "", close: "" });
    expect(checked.ok && checked.value).toEqual({
      date: "2026-11-26",
      is_closed: true,
      open_time: null,
      close_time: null,
    });
  });

  it("refuses a date that is only shaped like one", () => {
    expect(validateHoliday({ date: "26/11/2026", closed: true, open: "", close: "" }).ok).toBe(false);
    // Shaped right, not a real day. Postgres would refuse it with a
    // sentence nobody can read.
    expect(validateHoliday({ date: "2026-02-30", closed: true, open: "", close: "" }).ok).toBe(false);
  });

  it("refuses an open date with no times, which otherwise reads as open all day", () => {
    const checked = validateHoliday({ date: "2026-12-24", closed: false, open: "", close: "" });
    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.error).toMatch(/reads as open all day/);
  });

  it("refuses close <= open on a holiday too", () => {
    expect(
      validateHoliday({ date: "2026-12-24", closed: false, open: "16:00", close: "02:00" }).ok,
    ).toBe(false);
  });
});

describe("the menu, validated", () => {
  function itemInput(over: Partial<Parameters<typeof validateMenuItem>[0]> = {}) {
    return {
      categoryId: MARTY_CATEGORY,
      name: "Carbonara",
      description: "Guanciale, pecorino, egg",
      priceDollars: "22.00",
      allergenNote: "contains egg",
      sortOrder: "3",
      soldOutUntil: "",
      staffPick: false,
      ...over,
    };
  }

  it("stores a typed price as integer cents", () => {
    const checked = validateMenuItem(itemInput({ priceDollars: "12.99" }));
    expect(checked.ok && checked.value.price_cents).toBe(1299);
    const free = validateMenuItem(itemInput({ priceDollars: "0" }));
    expect(free.ok && free.value.price_cents).toBe(0);
  });

  it("refuses a price finer than a cent, or negative, rather than guessing", () => {
    expect(validateMenuItem(itemInput({ priceDollars: "12.505" })).ok).toBe(false);
    expect(validateMenuItem(itemInput({ priceDollars: "-3.00" })).ok).toBe(false);
    expect(validateMenuItem(itemInput({ priceDollars: "$22" })).ok).toBe(false);
  });

  it("refuses a category id that is not a uuid before it can reach Postgres", () => {
    expect(validateMenuItem(itemInput({ categoryId: "" })).ok).toBe(false);
    expect(validateMenuItem(itemInput({ categoryId: "------------------------------------" })).ok).toBe(
      false,
    );
  });

  it("holds sold_out_until to the enum", () => {
    expect(validateSoldOut("")).toEqual({ ok: true, value: null });
    expect(validateSoldOut("reopen")).toEqual({ ok: true, value: "reopen" });
    expect(validateSoldOut("close")).toEqual({ ok: true, value: "close" });
    expect(validateSoldOut("tomorrow").ok).toBe(false);
  });

  it("keeps an empty description and allergen note as null", () => {
    const checked = validateMenuItem(itemInput({ description: "  ", allergenNote: "" }));
    expect(checked.ok && checked.value.description).toBeNull();
    expect(checked.ok && checked.value.allergen_note).toBeNull();
  });

  it("refuses a blank category name and a blank item name", () => {
    expect(validateCategory({ name: " ", sortOrder: "0" }).ok).toBe(false);
    expect(validateMenuItem(itemInput({ name: "" })).ok).toBe(false);
  });

  it("flattens names the way matchItem does, so a duplicate can be spotted", () => {
    expect(normaliseItemName("  Cheese   Fries ")).toBe("cheese fries");
    expect(normaliseItemName("CHEESE FRIES")).toBe(normaliseItemName("cheese fries"));
  });
});

describe("which columns the phone carries a copy of", () => {
  it("is exactly the six traced through buildAssistantPayload", () => {
    expect([...SYNCED_COLUMNS].sort()).toEqual([
      "address",
      "fallback_human_number",
      "greeting_text",
      "name",
      "order_types",
      "timezone",
    ]);
  });

  it("does not include anything the agent reads live per call", () => {
    // Tax, promise minutes, seats, slot length and max party size are
    // all queried from Postgres inside the call. A rebuild for one of
    // those would rotate the tool secret to push nothing.
    for (const column of [
      "tax_rate_bps",
      "pickup_promise_minutes",
      "delivery_promise_minutes",
      "seats",
      "reservation_slot_minutes",
      "max_party_size",
      "recording_enabled",
      "order_sms_to",
      "business_phone",
      "carrier_name",
    ]) {
      expect(touchesAssistant({ [column]: 1 })).toBe(false);
    }
    expect(touchesAssistant({ tax_rate_bps: 875, order_types: "both" })).toBe(true);
  });
});

/* ════ 2. the writes, end to end ══════════════════════════════════ */

type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;
type Table =
  | "locations"
  | "organizations"
  | "hours"
  | "holiday_hours"
  | "menu_categories"
  | "menu_items";
type Result = { data: Row[] | null; count: number | null; error: { code: string } | null };

type Store = Record<Table, Row[]> & {
  /** Every statement this module sent that could change a row, and how
   *  many rows it actually touched. A refusal that "wrote nothing" is
   *  asserted against this list, not against the absence of a message. */
  writes: {
    table: Table;
    op: "update" | "insert" | "upsert" | "delete";
    applied: number;
    /** The exact payload passed to `.update()`, present on update writes
     *  only -- staff-pick tests need to see is_staff_pick on the wire,
     *  not just that a row landed. */
    patch?: Row;
  }[];
  readFailures: Partial<Record<Table, { code: string }>>;
  singleFailures: Partial<Record<Table, { code: string }>>;
  writeFailures: Partial<Record<Table, { code: string }>>;
};

let idCounter = 0;
let touches = 0;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Just enough PostgREST to drive this module: the call shapes edit.ts
 *  actually uses, and a record of every write, so a test can assert that
 *  a refusal wrote nothing rather than only that it said no. Modelled on
 *  lib/provisioning/go-live.test.ts's FakeQuery, widened for insert,
 *  upsert, delete, order and the organizations join. */
class FakeQuery implements PromiseLike<Result> {
  private filters: [string, Cell][] = [];
  private columns = "";
  private counting = false;
  private op: "read" | "update" | "insert" | "upsert" | "delete" = "read";
  private payload: Row[] = [];
  private conflict: string[] = [];
  private ordered: string[] = [];
  private limited: number | null = null;

  constructor(
    private store: Store,
    private table: Table,
  ) {}

  select(columns: string, options?: { count?: string; head?: boolean }) {
    this.columns = columns;
    this.counting = options?.count !== undefined;
    return this;
  }
  eq(column: string, value: Cell) {
    this.filters.push([column, value]);
    return this;
  }
  is(column: string, value: Cell) {
    this.filters.push([column, value]);
    return this;
  }
  /* Recorded rather than discarded. Nothing asserts on either one yet --
     the fake returns rows in insertion order and every caller here reads
     a handful -- but a parameter with a leading underscore reads as a
     mistake the linter has been told to tolerate, and this way the shape
     is honest if a test ever does need to check the sort. */
  order(column: string) {
    this.ordered.push(column);
    return this;
  }
  limit(max: number) {
    this.limited = max;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.payload = [patch];
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row[], options?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = rows;
    this.conflict = (options?.onConflict ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }

  maybeSingle(): Promise<{ data: Row | null; error: { code: string } | null }> {
    const failure = this.store.singleFailures[this.table];
    if (failure) return Promise.resolve({ data: null, error: failure });
    const row = this.matched()[0];
    // A COPY, as PostgREST hands back. Handing back the live object
    // makes every derivation silently self-updating, which is the one
    // thing a database never does.
    return Promise.resolve({ data: row ? this.decorate(row) : null, error: null });
  }

  private matched(): Row[] {
    return this.store[this.table].filter((row) =>
      this.filters.every(([column, value]) => row[column] === value),
    );
  }

  /** `select("*, organizations(name, plan, stripe_customer_id)")`. */
  private decorate(row: Row): Row {
    const copy: Record<string, unknown> = { ...row };
    if (this.table === "locations" && this.columns.includes("organizations(")) {
      const org = this.store.organizations.find((o) => o.id === row.org_id);
      copy.organizations = org ? { ...org } : null;
    }
    return copy as Row;
  }

  private run(): Result {
    if (this.op !== "read") {
      const failure = this.store.writeFailures[this.table];
      if (failure) return { data: null, count: null, error: failure };
    }

    if (this.op === "update") {
      const matched = this.matched();
      for (const row of matched) {
        Object.assign(row, this.payload[0]);
        // The locations_touch trigger, modelled: `before update ... new
        // .updated_at := now()`. Without it the editor's compare-and-set
        // could never be seen to work, because the token a stale tab
        // holds would go on matching forever.
        if (this.table === "locations") row.updated_at = `2026-01-01T00:00:${pad(++touches)}Z`;
      }
      this.store.writes.push({
        table: this.table,
        op: "update",
        applied: matched.length,
        patch: this.payload[0],
      });
      return { data: matched.map((row) => ({ id: row.id })), count: null, error: null };
    }

    if (this.op === "delete") {
      const matched = this.matched();
      this.store[this.table] = this.store[this.table].filter((row) => !matched.includes(row));
      this.store.writes.push({ table: this.table, op: "delete", applied: matched.length });
      return { data: null, count: null, error: null };
    }

    if (this.op === "insert" || this.op === "upsert") {
      let applied = 0;
      for (const incoming of this.payload) {
        const existing =
          this.op === "upsert" && this.conflict.length > 0
            ? this.store[this.table].find((row) =>
                this.conflict.every((column) => row[column] === incoming[column]),
              )
            : undefined;

        if (existing) {
          Object.assign(existing, incoming);
        } else {
          // The unique indexes this module actually relies on, enforced
          // by the fake so 23505 is reachable from a test.
          const clash =
            this.table === "holiday_hours"
              ? this.store.holiday_hours.find(
                  (row) =>
                    row.location_id === incoming.location_id && row.date === incoming.date,
                )
              : undefined;
          if (clash) return { data: null, count: null, error: { code: "23505" } };

          this.store[this.table].push({ id: `generated-${++idCounter}`, ...incoming });
        }
        applied += 1;
      }
      this.store.writes.push({ table: this.table, op: this.op, applied });
      return { data: null, count: null, error: null };
    }

    const failure = this.store.readFailures[this.table];
    if (failure) return { data: null, count: null, error: failure };
    const rows = this.matched();
    return this.counting
      ? { data: null, count: rows.length, error: null }
      : { data: rows.map((row) => this.decorate(row)), count: null, error: null };
  }

  then<T1 = Result, T2 = never>(
    onfulfilled?: ((value: Result) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

let store: Store;

function locationRow(over: Row = {}): Row {
  return {
    id: MARTY,
    org_id: MARTY_ORG,
    name: "Marty's",
    timezone: "America/Los_Angeles",
    address: "1 Main St, Oakland CA",
    business_phone: null,
    twilio_number: "+15105550000",
    twilio_number_sid: null,
    fallback_human_number: "+18787787878",
    greeting_text: "",
    greeting_audio_path: null,
    recording_enabled: true,
    recording_retention_days: 30,
    is_live: true,
    kill_switch_on: false,
    order_delivery: "sms",
    order_sms_to: null,
    order_email_to: null,
    carrier_name: null,
    forwarding_verified_at: null,
    // The digest lib/agent/auth.ts matches every tool call against.
    // Never returned to a browser -- see the getEditableRecord test.
    agent_secret_hash: "sha256-on-file",
    tax_rate_bps: 875,
    seats: 40,
    reservation_slot_minutes: 90,
    max_party_size: 8,
    order_types: "pickup",
    pickup_promise_minutes: 25,
    delivery_promise_minutes: 45,
    onboarding_step: "menu",
    vapi_assistant_id: ASSISTANT,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function marty(): Row {
  return store.locations.find((l) => l.id === MARTY) as Row;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VAPI_PRIVATE_KEY", "vapi-test-key");
  // The deployment's own address, which is what a rebuild is built from.
  vi.stubEnv("DIALTONE_PUBLIC_ORIGIN", BASE);
  idCounter = 0;
  touches = 0;

  store = {
    locations: [
      locationRow(),
      locationRow({ id: NONNA, org_id: NONNA_ORG, name: "Nonna Rosa", twilio_number: "+15106268819" }),
    ],
    organizations: [
      { id: MARTY_ORG, name: "Marty's Group", plan: "starter", stripe_customer_id: null },
      { id: NONNA_ORG, name: "Nonna Rosa LLC", plan: "trial", stripe_customer_id: "cus_123" },
    ],
    hours: [
      { id: "h-0", location_id: MARTY, day_of_week: 0, open_time: null, close_time: null, is_closed: true },
    ],
    holiday_hours: [
      { id: MARTY_HOLIDAY, location_id: MARTY, date: "2026-11-26", is_closed: true, open_time: null, close_time: null },
      { id: NONNA_HOLIDAY, location_id: NONNA, date: "2026-12-25", is_closed: true, open_time: null, close_time: null },
    ],
    menu_categories: [
      { id: MARTY_CATEGORY, location_id: MARTY, name: "Pasta", sort_order: 0 },
      { id: NONNA_CATEGORY, location_id: NONNA, name: "Antipasti", sort_order: 0 },
    ],
    menu_items: [
      {
        id: MARTY_ITEM,
        location_id: MARTY,
        category_id: MARTY_CATEGORY,
        name: "Carbonara",
        description: "Guanciale, pecorino, egg",
        price_cents: 2200,
        allergen_note: null,
        sort_order: 0,
        sold_out_until: null,
        is_staff_pick: false,
      },
      {
        id: NONNA_ITEM,
        location_id: NONNA,
        category_id: NONNA_CATEGORY,
        name: "Bruschetta",
        description: null,
        price_cents: 900,
        allergen_note: null,
        sort_order: 0,
        sold_out_until: null,
        is_staff_pick: false,
      },
    ],
    writes: [],
    readFailures: {},
    singleFailures: {},
    writeFailures: {},
  };

  currentPlatformAdmin.mockResolvedValue(STAFF);
  serviceRoleClient.mockImplementation(() => ({
    from: (table: Table) => new FakeQuery(store, table),
  }));
  provisionAssistantForLocation.mockResolvedValue({
    secret: "fresh-secret",
    assistantId: ASSISTANT,
    created: false,
  });
  // The healthy shape: Vapi holds the assistant this record names, and
  // it still carries this location's tag.
  findAssistantForLocation.mockResolvedValue({ id: ASSISTANT });
  getAssistant.mockResolvedValue({ id: ASSISTANT });
  tagAssistantForLocation.mockResolvedValue({ id: ASSISTANT });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ── the gate ──────────────────────────────────────────────────────── */

describe("the gate, which is the first statement of every export", () => {
  /** One call of every mutation, so nothing can be added without being
   *  put through the two refusals below. */
  const everyMutation = (locationId: string) => [
    [
      "saveBusiness",
      () => saveBusiness({ locationId, input: businessInput(), base: BASE, seenUpdatedAt: seen() }),
    ],
    [
      "saveAnswering",
      () =>
        saveAnswering({
          locationId,
          input: { greetingText: "Hi", fallbackNumber: "5105550100" },
          base: BASE,
          seenUpdatedAt: seen(),
        }),
    ],
    [
      "saveService",
      () => saveService({ locationId, input: serviceInput(), base: BASE, seenUpdatedAt: seen() }),
    ],
    [
      "saveOrderRouting",
      () =>
        saveOrderRouting({
          locationId,
          input: { orderDelivery: "sms", orderSmsTo: "5105550123", orderEmailTo: "" },
          seenUpdatedAt: seen(),
        }),
    ],
    [
      "saveRecording",
      () =>
        saveRecording({
          locationId,
          input: { recordingEnabled: false, recordingRetentionDays: "14" },
          seenUpdatedAt: seen(),
        }),
    ],
    ["saveHours", () => saveHours({ locationId, input: week(), seenSignature: seenWeek() })],
    [
      "saveHoliday",
      () =>
        saveHoliday({
          locationId,
          holidayId: null,
          input: { date: "2026-07-04", closed: true, open: "", close: "" },
        }),
    ],
    ["deleteHoliday", () => deleteHoliday({ locationId, holidayId: MARTY_HOLIDAY })],
    [
      "createMenuCategory",
      () => createMenuCategory({ locationId, input: { name: "Dolci", sortOrder: "1" } }),
    ],
    [
      "saveMenuCategory",
      () =>
        saveMenuCategory({
          locationId,
          categoryId: MARTY_CATEGORY,
          input: { name: "Primi", sortOrder: "0" },
        }),
    ],
    ["deleteMenuCategory", () => deleteMenuCategory({ locationId, categoryId: MARTY_CATEGORY })],
    [
      "createMenuItem",
      () =>
        createMenuItem({
          locationId,
          input: {
            categoryId: MARTY_CATEGORY,
            name: "Cacio e Pepe",
            description: "",
            priceDollars: "19.00",
            allergenNote: "",
            sortOrder: "1",
            soldOutUntil: "",
            staffPick: false,
          },
        }),
    ],
    [
      "saveMenuItem",
      () =>
        saveMenuItem({
          locationId,
          itemId: MARTY_ITEM,
          input: {
            categoryId: MARTY_CATEGORY,
            name: "Carbonara",
            description: "",
            priceDollars: "24.00",
            allergenNote: "",
            sortOrder: "0",
            soldOutUntil: "",
            staffPick: false,
          },
        }),
    ],
    ["deleteMenuItem", () => deleteMenuItem({ locationId, itemId: MARTY_ITEM })],
    [
      "setMenuItemSoldOut",
      () => setMenuItemSoldOut({ locationId, itemId: MARTY_ITEM, until: "close" }),
    ],
    ["resyncAssistant", () => resyncAssistant({ locationId, base: BASE })],
  ] as const;

  it("refuses every mutation to a caller who is not staff, and writes nothing", async () => {
    // A "use server" export is a live endpoint the moment it compiles.
    // Not drawing the button is not a permission.
    currentPlatformAdmin.mockResolvedValue(null);

    for (const [name, run] of everyMutation(MARTY)) {
      await expect(run(), name).resolves.toEqual({ ok: false, error: "Not found." });
    }

    expect(store.writes).toEqual([]);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
    expect(marty().name).toBe("Marty's");
  });

  it("refuses a malformed location id before it reaches Postgres, and writes nothing", async () => {
    for (const [name, run] of everyMutation("------------------------------------")) {
      await expect(run(), name).resolves.toEqual({ ok: false, error: "Not found." });
    }
    expect(store.writes).toEqual([]);
  });

  it("tells a non-admin nothing about whether a restaurant exists", async () => {
    currentPlatformAdmin.mockResolvedValue(null);
    await expect(getEditableRecord(MARTY)).resolves.toBeNull();
    await expect(getEditableRecord("no")).resolves.toBeNull();
  });

  it("refuses a location that is not there with the same sentence", async () => {
    await expect(
      saveService({
        locationId: "b0000000-0000-0000-0000-00000000000b",
        input: serviceInput(),
        base: BASE,
        seenUpdatedAt: seen(),
      }),
    ).resolves.toEqual({ ok: false, error: "Not found." });
    expect(store.writes).toEqual([]);
  });
});

/* ── a refused write writes nothing ────────────────────────────────── */

describe("a refused value never reaches the database", () => {
  it("refuses an invalid timezone without touching the row", async () => {
    const result = await saveBusiness({
      locationId: MARTY,
      input: businessInput({ timezone: "Mars/Phobos" }),
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Nothing was saved\.$/);
    expect(store.writes).toEqual([]);
    expect(marty().timezone).toBe("America/Los_Angeles");
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("refuses a tax rate one basis point over the constraint without touching the row", async () => {
    const result = await saveService({
      locationId: MARTY,
      input: serviceInput({ taxPercent: "20.01" }),
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toEqual({ ok: false, error: "Sales tax must be between 0% and 20%. Nothing was saved." });
    expect(store.writes).toEqual([]);
    expect(marty().tax_rate_bps).toBe(875);
  });

  it("refuses a week whose Friday closes before it opens, and writes no day", async () => {
    const result = await saveHours({
      locationId: MARTY,
      input: week({ 5: { open: "17:00", close: "02:00" } }),
      seenSignature: seenWeek(),
    });

    expect(result.ok).toBe(false);
    expect(store.writes).toEqual([]);
    // The Sunday row that was already on file is untouched.
    expect(store.hours).toHaveLength(1);
  });

  it("refuses a blank fallback number without unhooking the transfer", async () => {
    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "Hi!", fallbackNumber: "" },
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result.ok).toBe(false);
    expect(store.writes).toEqual([]);
    expect(marty().fallback_human_number).toBe("+18787787878");
  });
});

/* ── the tenant boundary ───────────────────────────────────────────── */

describe("a child row id is a selector and proves nothing", () => {
  it("will not edit another restaurant's menu item", async () => {
    // Posting Nonna Rosa's item id at Marty's editor. The screen would
    // never draw this; the endpoint has to refuse it anyway.
    const result = await saveMenuItem({
      locationId: MARTY,
      itemId: NONNA_ITEM,
      input: {
        categoryId: MARTY_CATEGORY,
        name: "Bruschetta",
        description: "",
        priceDollars: "1.00",
        allergenNote: "",
        sortOrder: "0",
        soldOutUntil: "",
        staffPick: false,
      },
    });

    expect(result.ok).toBe(false);
    expect(store.writes).toEqual([]);
    expect(store.menu_items.find((i) => i.id === NONNA_ITEM)?.price_cents).toBe(900);
  });

  it("will not delete another restaurant's menu item", async () => {
    const result = await deleteMenuItem({ locationId: MARTY, itemId: NONNA_ITEM });
    expect(result.ok).toBe(false);
    expect(store.writes).toEqual([]);
    expect(store.menu_items).toHaveLength(2);
  });

  it("will not mark another restaurant's dish sold out", async () => {
    const result = await setMenuItemSoldOut({ locationId: MARTY, itemId: NONNA_ITEM, until: "close" });
    expect(result.ok).toBe(false);
    expect(store.writes).toEqual([]);
    expect(store.menu_items.find((i) => i.id === NONNA_ITEM)?.sold_out_until).toBeNull();
  });

  it("will not move an item into another restaurant's category", async () => {
    // The sharpest one. app.sync_menu_item_location re-derives
    // location_id FROM THE CATEGORY, so this would not fail -- Marty's
    // carbonara would silently become Nonna Rosa's, on their menu and in
    // their agent's mouth on the next call.
    const result = await saveMenuItem({
      locationId: MARTY,
      itemId: MARTY_ITEM,
      input: {
        categoryId: NONNA_CATEGORY,
        name: "Carbonara",
        description: "",
        priceDollars: "22.00",
        allergenNote: "",
        sortOrder: "0",
        soldOutUntil: "",
        staffPick: false,
      },
    });

    expect(result.ok).toBe(false);
    expect(store.writes).toEqual([]);
    expect(store.menu_items.find((i) => i.id === MARTY_ITEM)?.category_id).toBe(MARTY_CATEGORY);
  });

  it("will not create an item in another restaurant's category", async () => {
    const result = await createMenuItem({
      locationId: MARTY,
      input: {
        categoryId: NONNA_CATEGORY,
        name: "Smuggled dish",
        description: "",
        priceDollars: "5.00",
        allergenNote: "",
        sortOrder: "0",
        soldOutUntil: "",
        staffPick: false,
      },
    });

    expect(result.ok).toBe(false);
    expect(store.writes).toEqual([]);
    expect(store.menu_items).toHaveLength(2);
  });

  it("will not rename or delete another restaurant's category", async () => {
    await expect(
      saveMenuCategory({
        locationId: MARTY,
        categoryId: NONNA_CATEGORY,
        input: { name: "Renamed", sortOrder: "0" },
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      deleteMenuCategory({ locationId: MARTY, categoryId: NONNA_CATEGORY }),
    ).resolves.toMatchObject({ ok: false });

    expect(store.writes).toEqual([]);
    expect(store.menu_categories.find((c) => c.id === NONNA_CATEGORY)?.name).toBe("Antipasti");
  });

  it("will not edit or delete another restaurant's holiday", async () => {
    await expect(
      saveHoliday({
        locationId: MARTY,
        holidayId: NONNA_HOLIDAY,
        input: { date: "2026-12-25", closed: false, open: "09:00", close: "23:00" },
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      deleteHoliday({ locationId: MARTY, holidayId: NONNA_HOLIDAY }),
    ).resolves.toMatchObject({ ok: false });

    expect(store.writes).toEqual([]);
    expect(store.holiday_hours.find((h) => h.id === NONNA_HOLIDAY)?.is_closed).toBe(true);
  });

  it("refuses a child id that is not a uuid at all, without a round trip", async () => {
    await expect(
      deleteMenuItem({ locationId: MARTY, itemId: "'; drop table menu_items;--" }),
    ).resolves.toMatchObject({ ok: false });
    expect(store.writes).toEqual([]);
  });

  it("refuses rather than guessing when the ownership read itself fails", async () => {
    // A select that failed is not evidence the row belongs to somebody
    // else, and it must refuse without claiming it.
    store.singleFailures.menu_items = { code: "57014" };
    const result = await deleteMenuItem({ locationId: MARTY, itemId: MARTY_ITEM });
    expect(result.ok).toBe(false);
    expect(store.writes).toEqual([]);
    expect(store.menu_items).toHaveLength(2);
  });
});

/* ── the writes that land ──────────────────────────────────────────── */

describe("the edits that take effect on the next call", () => {
  it("saves the service settings and pushes nothing to the phone", async () => {
    const result = await saveService({
      locationId: MARTY,
      input: serviceInput({ taxPercent: "9.25", seats: "52", orderTypes: "pickup" }),
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "not-needed" } });
    expect(marty().tax_rate_bps).toBe(925);
    expect(marty().seats).toBe(52);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("writes all seven hours rows in one statement, and does not rebuild", async () => {
    const result = await saveHours({
      locationId: MARTY,
      input: week({ 1: { closed: true } }),
      seenSignature: seenWeek(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "not-needed" } });
    expect(result.ok && result.message).toMatch(/fresh on every call/);
    expect(store.writes).toEqual([{ table: "hours", op: "upsert", applied: 7 }]);
    expect(store.hours).toHaveLength(7);
    // The Sunday row already on file was updated in place, not doubled.
    expect(store.hours.filter((h) => h.day_of_week === 0)).toHaveLength(1);
    expect(store.hours.find((h) => h.day_of_week === 1)?.is_closed).toBe(true);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("adds a holiday, and refuses a second one on the same date with a useful sentence", async () => {
    await expect(
      saveHoliday({
        locationId: MARTY,
        holidayId: null,
        input: { date: "2026-12-24", closed: false, open: "11:00", close: "15:00" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.holiday_hours.filter((h) => h.location_id === MARTY)).toHaveLength(2);

    const clash = await saveHoliday({
      locationId: MARTY,
      holidayId: null,
      input: { date: "2026-12-24", closed: true, open: "", close: "" },
    });
    expect(clash.ok).toBe(false);
    expect(clash.ok === false && clash.error).toMatch(/already an entry for that date/);
  });

  it("edits and removes this restaurant's own holiday", async () => {
    await expect(
      saveHoliday({
        locationId: MARTY,
        holidayId: MARTY_HOLIDAY,
        input: { date: "2026-11-26", closed: false, open: "12:00", close: "16:00" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.holiday_hours.find((h) => h.id === MARTY_HOLIDAY)?.open_time).toBe("12:00");

    await expect(
      deleteHoliday({ locationId: MARTY, holidayId: MARTY_HOLIDAY }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.holiday_hours.find((h) => h.id === MARTY_HOLIDAY)).toBeUndefined();
  });

  it("does the whole menu CRUD for its own location", async () => {
    await expect(
      createMenuCategory({ locationId: MARTY, input: { name: "Dolci", sortOrder: "2" } }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.menu_categories.filter((c) => c.location_id === MARTY)).toHaveLength(2);

    await expect(
      saveMenuCategory({
        locationId: MARTY,
        categoryId: MARTY_CATEGORY,
        input: { name: "Primi", sortOrder: "1" },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.menu_categories.find((c) => c.id === MARTY_CATEGORY)?.name).toBe("Primi");

    const priced = await saveMenuItem({
      locationId: MARTY,
      itemId: MARTY_ITEM,
      input: {
        categoryId: MARTY_CATEGORY,
        name: "Carbonara",
        description: "Guanciale, pecorino, egg, black pepper",
        priceDollars: "24.50",
        allergenNote: "contains egg and pork",
        sortOrder: "0",
        soldOutUntil: "",
        staffPick: false,
      },
    });
    expect(priced).toMatchObject({ ok: true, phone: { state: "not-needed" } });
    expect(priced.ok && priced.message).toMatch(/\$24\.50/);
    const item = store.menu_items.find((i) => i.id === MARTY_ITEM);
    expect(item?.price_cents).toBe(2450);
    expect(item?.allergen_note).toBe("contains egg and pork");

    await expect(
      setMenuItemSoldOut({ locationId: MARTY, itemId: MARTY_ITEM, until: "reopen" }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.menu_items.find((i) => i.id === MARTY_ITEM)?.sold_out_until).toBe("reopen");

    await expect(
      deleteMenuItem({ locationId: MARTY, itemId: MARTY_ITEM }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.menu_items.find((i) => i.id === MARTY_ITEM)).toBeUndefined();

    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("refuses a second item whose name matches an existing one, and writes nothing", async () => {
    // Two rows whose names normalise the same are a permanent
    // ambiguous_item: the agent reads back two identical names, which is
    // a question the caller cannot answer.
    const result = await createMenuItem({
      locationId: MARTY,
      input: {
        categoryId: MARTY_CATEGORY,
        name: "  CARBONARA  ",
        description: "",
        priceDollars: "23.00",
        allergenNote: "",
        sortOrder: "1",
        soldOutUntil: "",
        staffPick: false,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/already has an item by that name/);
    expect(store.writes).toEqual([]);
    expect(store.menu_items.filter((i) => i.location_id === MARTY)).toHaveLength(1);
  });

  it("lets an item keep its own name while being edited", async () => {
    await expect(
      saveMenuItem({
        locationId: MARTY,
        itemId: MARTY_ITEM,
        input: {
          categoryId: MARTY_CATEGORY,
          name: "Carbonara",
          description: "",
          priceDollars: "25.00",
          allergenNote: "",
          sortOrder: "0",
          soldOutUntil: "",
          staffPick: false,
        },
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("edits an item that already has a same-named twin, as long as the name is not what moved", async () => {
    /* Twins are routine rather than exotic: app.publish_menu_import
       appends items with no name check at all, and neither does the
       owner's own menu screen -- so importing the same PDF twice, or a
       menu that prints "Side Salad" under both Lunch and Dinner, leaves
       two rows that normalise the same. Refusing on an UNTOUCHED name
       makes the one screen built to fix a restaurant's data the one
       screen that cannot touch the rows most likely to need fixing. */
    store.menu_items.push({
      id: "17e00000-0000-0000-0000-0000000000e9",
      location_id: MARTY,
      category_id: MARTY_CATEGORY,
      name: "carbonara",
      description: null,
      price_cents: 2100,
      allergen_note: null,
      sort_order: 1,
      sold_out_until: null,
    });

    const result = await saveMenuItem({
      locationId: MARTY,
      itemId: MARTY_ITEM,
      input: {
        categoryId: MARTY_CATEGORY,
        name: "Carbonara",
        description: "Guanciale, pecorino, egg yolk",
        priceDollars: "24.00",
        allergenNote: "",
        sortOrder: "0",
        soldOutUntil: "",
        staffPick: false,
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(store.menu_items.find((i) => i.id === MARTY_ITEM)?.price_cents).toBe(2400);
  });

  it("still refuses a rename onto another item's name", async () => {
    store.menu_items.push({
      id: "17e00000-0000-0000-0000-0000000000e8",
      location_id: MARTY,
      category_id: MARTY_CATEGORY,
      name: "Amatriciana",
      description: null,
      price_cents: 2100,
      allergen_note: null,
      sort_order: 1,
      sold_out_until: null,
    });

    const result = await saveMenuItem({
      locationId: MARTY,
      itemId: MARTY_ITEM,
      input: {
        categoryId: MARTY_CATEGORY,
        name: "  amatriciana ",
        description: "",
        priceDollars: "22.00",
        allergenNote: "",
        sortOrder: "0",
        soldOutUntil: "",
        staffPick: false,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/already has an item by that name/);
    expect(store.writes).toEqual([]);
    expect(store.menu_items.find((i) => i.id === MARTY_ITEM)?.name).toBe("Carbonara");
  });

  it("leaves the sold-out flag alone when a price or a description is saved", async () => {
    /* The edit row has no control for sold-out -- it is its own
       one-click action -- so every value a save could carry for it is a
       copy of a prop that may be minutes old. The owner marks the dish
       sold out from their own screen at seven; the operator fixes its
       description in a tab opened at ten to; writing the column back
       would put it on sale again, live on the very next call, while the
       success sentence talks about the description. */
    const item = store.menu_items.find((i) => i.id === MARTY_ITEM) as Record<string, unknown>;
    item.sold_out_until = "close";

    const result = await saveMenuItem({
      locationId: MARTY,
      itemId: MARTY_ITEM,
      input: {
        categoryId: MARTY_CATEGORY,
        name: "Carbonara",
        description: "Guanciale, pecorino, egg",
        priceDollars: "24.00",
        allergenNote: "",
        sortOrder: "0",
        // What a page rendered before the dish sold out would send.
        soldOutUntil: "",
        staffPick: false,
      },
    });

    expect(result).toMatchObject({ ok: true });
    expect(store.menu_items.find((i) => i.id === MARTY_ITEM)?.price_cents).toBe(2400);
    expect(store.menu_items.find((i) => i.id === MARTY_ITEM)?.sold_out_until).toBe("close");
  });

  it("still puts a dish back on sale through the one control that has one", async () => {
    const item = store.menu_items.find((i) => i.id === MARTY_ITEM) as Record<string, unknown>;
    item.sold_out_until = "close";

    await expect(
      setMenuItemSoldOut({ locationId: MARTY, itemId: MARTY_ITEM, until: "" }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.menu_items.find((i) => i.id === MARTY_ITEM)?.sold_out_until).toBeNull();
  });

  it("does not treat another restaurant's dish as a duplicate", async () => {
    await expect(
      createMenuItem({
        locationId: MARTY,
        input: {
          categoryId: MARTY_CATEGORY,
          name: "Bruschetta",
          description: "",
          priceDollars: "9.00",
          allergenNote: "",
          sortOrder: "1",
          soldOutUntil: "",
          staffPick: false,
        },
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("saves the organization's name and plan through the location's own org_id", async () => {
    const result = await saveBusiness({
      locationId: MARTY,
      input: businessInput({ orgName: "Marty's Holdings", plan: "growth" }),
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true });
    const org = store.organizations.find((o) => o.id === MARTY_ORG);
    expect(org?.name).toBe("Marty's Holdings");
    expect(org?.plan).toBe("growth");
    // Never the other tenant's, whatever the browser sent.
    expect(store.organizations.find((o) => o.id === NONNA_ORG)?.name).toBe("Nonna Rosa LLC");
  });

  it("writes nothing at all when the submitted values are already what is on file", async () => {
    const result = await saveRecording({
      locationId: MARTY,
      input: { recordingEnabled: true, recordingRetentionDays: "30" },
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "not-needed" } });
    expect(result.ok && result.message).toMatch(/Nothing to save/);
    expect(store.writes).toEqual([]);
  });

  it("reports a failed write as a failed write, without the Postgres text", async () => {
    store.writeFailures.locations = { code: "23514" };
    const result = await saveRecording({
      locationId: MARTY,
      input: { recordingEnabled: false, recordingRetentionDays: "14" },
      seenUpdatedAt: seen(),
    });

    expect(result).toEqual({ ok: false, error: "That did not save. Nothing was changed." });
  });

  it("saves the kitchen number and says plainly when there is none", async () => {
    const withNumber = await saveOrderRouting({
      locationId: MARTY,
      input: { orderDelivery: "sms", orderSmsTo: "(510) 555-0123", orderEmailTo: "kitchen@marty.test" },
      seenUpdatedAt: seen(),
    });
    expect(withNumber.ok && withNumber.message).toMatch(/\+15105550123/);
    expect(marty().order_sms_to).toBe("+15105550123");
    expect(marty().order_email_to).toBe("kitchen@marty.test");

    const cleared = await saveOrderRouting({
      locationId: MARTY,
      input: { orderDelivery: "sms", orderSmsTo: "", orderEmailTo: "" },
      seenUpdatedAt: seen(),
    });
    expect(cleared.ok && cleared.message).toMatch(/no ticket is sent/);
    expect(marty().order_sms_to).toBeNull();
  });
});

/* ── two operators, one restaurant ─────────────────────────────────── */

describe("a save from a page that was rendered before somebody else changed the restaurant", () => {
  /* Every section submits ALL of its columns, and changedColumns diffs
     them against the row as it stands NOW -- so a value the operator
     never touched, but whose column moved since their page loaded, would
     be written back to the stale value and, if it is one of the six,
     baked into the assistant on the way. The premise of this console is
     several operators editing restaurants that are already answering the
     phone; there is no realtime and no polling between one tab's render
     and its save. */

  it("refuses rather than putting the other operator's change back", async () => {
    const stale = seen(); // the token operator A's page was rendered with

    // Operator B moves the transfer number to the owner's new mobile.
    await expect(
      saveAnswering({
        locationId: MARTY,
        input: { greetingText: "", fallbackNumber: "(510) 555-0199" },
        base: BASE,
        seenUpdatedAt: seen(),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(marty().fallback_human_number).toBe("+15105550199");

    // Operator A, whose tab still shows the old number, edits only the
    // greeting and saves.
    provisionAssistantForLocation.mockClear();
    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "A's new greeting", fallbackNumber: "+18787787878" },
      base: BASE,
      seenUpdatedAt: stale,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/changed while this page was open/);
    expect(result.ok === false && result.error).toMatch(/Nothing was saved\.$/);
    // B's number survives, in the column AND on the phone.
    expect(marty().fallback_human_number).toBe("+15105550199");
    expect(marty().greeting_text).toBe("");
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("refuses a form that carries no token at all rather than writing without the guard", async () => {
    const result = await saveService({
      locationId: MARTY,
      input: serviceInput({ seats: "60" }),
      base: BASE,
      seenUpdatedAt: "",
    });

    expect(result.ok).toBe(false);
    expect(store.writes).toEqual([]);
    expect(marty().seats).toBe(40);
  });

  it("refuses a week saved from a grid rendered before the hours moved", async () => {
    const stale = seenWeek();

    await expect(
      saveHours({ locationId: MARTY, input: week({ 2: { open: "07:00", close: "15:00" } }), seenSignature: stale }),
    ).resolves.toMatchObject({ ok: true });

    // A second tab, still showing the week as it was before that save.
    const result = await saveHours({
      locationId: MARTY,
      input: week({ 4: { closed: true } }),
      seenSignature: stale,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Nothing was saved\.$/);
    // The other operator's Tuesday is still there.
    expect(store.hours.find((h) => h.day_of_week === 2)?.open_time).toBe("07:00");
    expect(store.hours.find((h) => h.day_of_week === 4)?.is_closed).toBe(false);
  });
});

/* ── one save, two tables ──────────────────────────────────────────── */

describe("the business section spans two tables and its sentence must be true of both", () => {
  it("does not report an organization-only change as nothing to save", async () => {
    const result = await saveBusiness({
      locationId: MARTY,
      // Every location column is exactly what is on file; only the org
      // name moves.
      input: businessInput({
        orgName: "Marty's Holdings",
        businessPhone: "",
        carrierName: "",
      }),
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.message).not.toMatch(/Nothing to save/);
    expect(store.organizations.find((o) => o.id === MARTY_ORG)?.name).toBe("Marty's Holdings");
  });

  it("does not say nothing was changed over an organization row that already changed", async () => {
    store.writeFailures.locations = { code: "23514" };

    const result = await saveBusiness({
      locationId: MARTY,
      input: businessInput({ orgName: "Marty's Holdings", name: "Marty's Deli" }),
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/organization/i);
    expect(result.ok === false && result.error).not.toMatch(/Nothing was changed/);
    // Which is the truth: the org row moved and the location row did not.
    expect(store.organizations.find((o) => o.id === MARTY_ORG)?.name).toBe("Marty's Holdings");
    expect(marty().name).toBe("Marty's");
  });
});

/* ════ 3. the phone ═══════════════════════════════════════════════ */

describe("editing a field that was baked into the assistant", () => {
  it("rebuilds the assistant when the greeting or the transfer number moves", async () => {
    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "Marty's, what can I get you?", fallbackNumber: "(510) 555-0100" },
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "updated" } });
    expect(result.ok && result.message).toMatch(/rebuilt/);
    expect(marty().greeting_text).toBe("Marty's, what can I get you?");
    expect(marty().fallback_human_number).toBe("+15105550100");

    expect(provisionAssistantForLocation).toHaveBeenCalledTimes(1);
    // Built from the row AS IT STANDS AFTER the write, not from the one
    // read before it -- otherwise the push carries the old value.
    const arg = provisionAssistantForLocation.mock.calls[0][0];
    expect(arg.location.greeting_text).toBe("Marty's, what can I get you?");
    expect(arg.location.fallback_human_number).toBe("+15105550100");
    expect(arg.base).toBe(BASE);
  });

  it("rebuilds when order_types moves, because the prompt states it and the route enforces it", async () => {
    const result = await saveService({
      locationId: MARTY,
      input: serviceInput({ orderTypes: "both" }),
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "updated" } });
    expect(provisionAssistantForLocation).toHaveBeenCalledTimes(1);
  });

  it("rebuilds when the name, address or timezone moves", async () => {
    for (const input of [
      businessInput({ name: "Marty's Deli" }),
      businessInput({ address: "2 Broadway, Oakland CA" }),
      businessInput({ timezone: "America/New_York" }),
    ]) {
      provisionAssistantForLocation.mockClear();
      await expect(
        saveBusiness({ locationId: MARTY, input, base: BASE, seenUpdatedAt: seen() }),
      ).resolves.toMatchObject({ ok: true, phone: { state: "updated" } });
      expect(provisionAssistantForLocation).toHaveBeenCalledTimes(1);
    }
  });

  it("does not rebuild for the display phone or the carrier, which are baked into nothing", async () => {
    await expect(
      saveBusiness({
        locationId: MARTY,
        input: businessInput({ businessPhone: "(510) 555-0199", carrierName: "Verizon" }),
        base: BASE,
        seenUpdatedAt: seen(),
      }),
    ).resolves.toMatchObject({ ok: true, phone: { state: "not-needed" } });
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("does not rebuild when a synced column is resubmitted unchanged", async () => {
    // A save that only moved the tax rate must not rotate the tool
    // secret because `name` came back in the same form untouched.
    await expect(
      saveBusiness({
        locationId: MARTY,
        input: businessInput({ businessPhone: "" }),
        base: BASE,
        seenUpdatedAt: seen(),
      }),
    ).resolves.toMatchObject({ ok: true, phone: { state: "not-needed" } });
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("skips the rebuild entirely when there is no assistant yet, and says so", async () => {
    store.locations[0].vapi_assistant_id = null;

    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "Ciao!", fallbackNumber: "5105550100" },
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "no-assistant" } });
    expect(result.ok && result.message).toMatch(/go-live panel/);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
    expect(marty().greeting_text).toBe("Ciao!");
  });
});

describe("when the rebuild fails", () => {
  it("keeps the column, refuses to claim success on the phone, and names the failure", async () => {
    provisionAssistantForLocation.mockRejectedValue(new Error("Vapi returned 503"));

    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "New greeting", fallbackNumber: "(510) 555-0100" },
      base: BASE,
      seenUpdatedAt: seen(),
    });

    // ok:true means THE DATABASE WAS WRITTEN. It never means the phone
    // agrees -- and the message must not let anyone read it that way.
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ phone: { state: "failed" } });
    if (!result.ok) return;
    expect(result.message).toMatch(/could NOT be rebuilt/i);
    expect(result.message).toMatch(/Vapi returned 503/);
    expect(result.message).toMatch(/still on the old value/);

    // NOT rolled back. The column is what every live route reads; the
    // recoverable state is "tools right, prompt stale".
    expect(marty().greeting_text).toBe("New greeting");
    expect(marty().fallback_human_number).toBe("+15105550100");
  });

  it("reports the secret-write failure as its own, worse thing", async () => {
    provisionAssistantForLocation.mockRejectedValue(
      new AssistantSecretWriteError("The AI assistant was created, but saving its secret failed.", ASSISTANT, false),
    );

    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "New greeting", fallbackNumber: "5105550100" },
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "secret-lost" } });
    if (!result.ok) return;
    expect(result.message).toMatch(/unable to read the menu or take an order/);
    expect(result.message).toMatch(/go-live panel/);
  });

  it("refuses to rebuild from a base Vapi could never call back to", async () => {
    // The deployment's OWN address is the localhost one here -- a laptop
    // running next dev. Vapi cannot reach it, so the push is refused
    // before it is made rather than pointing nine tools at a machine on
    // somebody's desk.
    vi.stubEnv("DIALTONE_PUBLIC_ORIGIN", "http://localhost:3000");
    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "Local dev", fallbackNumber: "5105550100" },
      base: "http://localhost:3000",
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "failed" } });
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
    // Saved anyway: the tools and every live route read the column.
    expect(marty().greeting_text).toBe("Local dev");
  });

  it("says the key is missing rather than pretending the phone was updated", async () => {
    vi.stubEnv("VAPI_PRIVATE_KEY", "");

    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "No key here", fallbackNumber: "5105550100" },
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "failed" } });
    expect(result.ok && result.message).toMatch(/VAPI_PRIVATE_KEY/);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("never puts Vapi's failure text into the returned phone state as success", async () => {
    provisionAssistantForLocation.mockRejectedValue(new Error("boom"));
    const result = await saveService({
      locationId: MARTY,
      input: serviceInput({ orderTypes: "delivery" }),
      base: BASE,
      seenUpdatedAt: seen(),
    });
    expect(result).toMatchObject({ ok: true, phone: { state: "failed" } });
    expect(marty().order_types).toBe("delivery");
  });
});

/* ── which assistant a rebuild lands on ────────────────────────────── */

describe("the assistant a rebuild is allowed to land on", () => {
  /* upsertAssistant looks an assistant up by
     metadata.dialtone_location_id and CREATES ONE when the search comes
     back empty. That is right on provisioning day and catastrophic here:
     an assistant cloned, restored or edited in the Vapi dashboard loses
     the tag while it goes on answering the phone, so an ordinary
     greeting edit would POST a second assistant, move vapi_assistant_id
     and agent_secret_hash onto it, and leave the phone NUMBER bound to
     the first -- which then carries a secret whose hash no longer
     exists, so every one of its nine tools 401s. The agent greets the
     caller and can then neither read the menu, take an order, nor
     transfer, while both screens report success. */

  it("puts the tag back on the assistant this record names instead of building a second one", async () => {
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockResolvedValue({ id: ASSISTANT, metadata: {} });

    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "Untagged but live", fallbackNumber: "5105550100" },
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "updated" } });
    expect(getAssistant).toHaveBeenCalledWith("vapi-test-key", ASSISTANT);
    expect(tagAssistantForLocation).toHaveBeenCalledWith(
      "vapi-test-key",
      { id: ASSISTANT, metadata: {} },
      MARTY,
    );
    // And only then is anything pushed -- to the assistant that is
    // answering the phone, not beside it.
    expect(provisionAssistantForLocation).toHaveBeenCalledTimes(1);
  });

  it("refuses when Vapi no longer has the assistant this record names", async () => {
    findAssistantForLocation.mockResolvedValue(null);
    getAssistant.mockResolvedValue(null);

    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "Nothing to push at", fallbackNumber: "5105550100" },
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "failed" } });
    expect(result.ok && result.message).toMatch(/go-live panel/);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
    expect(tagAssistantForLocation).not.toHaveBeenCalled();
    // Saved anyway: the column is what every live route reads.
    expect(marty().greeting_text).toBe("Nothing to push at");
  });

  it("refuses when the tagged assistant is not the one this record names", async () => {
    // The reconnect case. Pushing here would rebuild the tagged one and
    // rotate the secret out from under whichever one the phone number is
    // actually pointed at; go-live's repair reconnects the two without
    // touching Vapi at all.
    findAssistantForLocation.mockResolvedValue({ id: "aaaaaaaa-0000-0000-0000-0000000000ff" });

    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "Two candidates", fallbackNumber: "5105550100" },
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "failed" } });
    expect(result.ok && result.message).toMatch(/go-live panel/);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("refuses rather than guessing when Vapi cannot be asked which assistant is tagged", async () => {
    findAssistantForLocation.mockRejectedValue(new Error("Vapi returned 503"));

    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "Could not ask", fallbackNumber: "5105550100" },
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "failed" } });
    expect(result.ok && result.message).toMatch(/Vapi returned 503/);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });

  it("never reports a rebuild that built a second assistant as a phone that changed", async () => {
    // The guards above make this unreachable; if it ever happens anyway,
    // the number may still ring the old assistant, whose secret has just
    // been rotated away from it.
    provisionAssistantForLocation.mockResolvedValue({
      secret: "fresh-secret",
      assistantId: "aaaaaaaa-0000-0000-0000-0000000000ff",
      created: true,
    });

    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "Second assistant", fallbackNumber: "5105550100" },
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "failed" } });
    expect(result.ok && result.message).toMatch(/second assistant/);
    expect(result.ok && result.message).toMatch(/go-live panel/);
  });
});

/* ── the address a rebuild is built from ───────────────────────────── */

describe("where the assistant's nine tools are pointed", () => {
  it("builds from this deployment's own address, never from the console's origin", async () => {
    // An operator with the console open on a preview build. Trusting the
    // Origin header here would rewrite every tool URL of a live
    // restaurant to a deployment that is not serving it, and the only
    // symptom would be orders that stop arriving.
    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "From a preview", fallbackNumber: "5105550100" },
      base: "https://dialtone-web-git-branch.vercel.app",
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "failed" } });
    expect(result.ok && result.message).toMatch(/dialtone-web-git-branch\.vercel\.app/);
    expect(result.ok && result.message).toMatch(/dialtone\.example\.com/);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
    expect(marty().greeting_text).toBe("From a preview");
  });

  it("takes the origin off the configured base url, path and all removed", async () => {
    vi.stubEnv("DIALTONE_PUBLIC_ORIGIN", "");
    vi.stubEnv("TWILIO_WEBHOOK_BASE_URL", `${BASE}/api/twilio`);

    await expect(
      saveAnswering({
        locationId: MARTY,
        input: { greetingText: "Configured", fallbackNumber: "5105550100" },
        base: BASE,
        seenUpdatedAt: seen(),
      }),
    ).resolves.toMatchObject({ ok: true, phone: { state: "updated" } });

    expect(provisionAssistantForLocation.mock.calls[0][0].base).toBe(BASE);
  });

  it("refuses to push at all when the deployment does not say what its own address is", async () => {
    vi.stubEnv("DIALTONE_PUBLIC_ORIGIN", "");
    vi.stubEnv("TWILIO_WEBHOOK_BASE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");

    const result = await saveAnswering({
      locationId: MARTY,
      input: { greetingText: "Nowhere to call back to", fallbackNumber: "5105550100" },
      base: BASE,
      seenUpdatedAt: seen(),
    });

    expect(result).toMatchObject({ ok: true, phone: { state: "failed" } });
    expect(result.ok && result.message).toMatch(/DIALTONE_PUBLIC_ORIGIN/);
    expect(provisionAssistantForLocation).not.toHaveBeenCalled();
  });
});

describe("pushing an edit that did not push", () => {
  it("rebuilds from the row as it stands, writing no column", async () => {
    const result = await resyncAssistant({ locationId: MARTY, base: BASE });

    expect(result).toMatchObject({ ok: true, phone: { state: "updated" } });
    expect(provisionAssistantForLocation).toHaveBeenCalledTimes(1);
    expect(store.writes).toEqual([]);
  });

  it("comes back as a refusal when the rebuild fails, because nothing else happened", async () => {
    provisionAssistantForLocation.mockRejectedValue(new Error("Vapi is down"));
    const result = await resyncAssistant({ locationId: MARTY, base: BASE });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/still on the old value/);
    expect(store.writes).toEqual([]);
  });

  it("says there is nothing to push when the restaurant has no assistant", async () => {
    store.locations[0].vapi_assistant_id = null;
    await expect(resyncAssistant({ locationId: MARTY, base: BASE })).resolves.toMatchObject({
      ok: true,
      phone: { state: "no-assistant" },
    });
  });
});

/* ════ 4. the record the editor renders ═══════════════════════════ */

describe("reading the record", () => {
  it("returns every editable row, scoped to one restaurant", async () => {
    const record = await getEditableRecord(MARTY);
    expect(record).not.toBeNull();
    if (!record) return;

    expect(record.location.name).toBe("Marty's");
    expect(record.org).toEqual({
      name: "Marty's Group",
      plan: "starter",
      stripe_customer_on_file: false,
    });
    expect(record.hours).toHaveLength(1);
    expect(record.holidays.map((h) => h.id)).toEqual([MARTY_HOLIDAY]);
    expect(record.categories.map((c) => c.id)).toEqual([MARTY_CATEGORY]);
    expect(record.items.map((i) => i.id)).toEqual([MARTY_ITEM]);
  });

  it("never puts the tool secret or the Stripe id in the response body", async () => {
    const record = await getEditableRecord(NONNA);
    expect(record).not.toBeNull();
    if (!record) return;

    expect(record.location).not.toHaveProperty("agent_secret_hash");
    expect(record.location.tool_secret_on_file).toBe(true);
    // Nonna Rosa's org has a Stripe id; only its presence comes back.
    expect(record.org.stripe_customer_on_file).toBe(true);
    expect(JSON.stringify(record)).not.toMatch(/cus_123|sha256-on-file/);
  });

  it("throws rather than 404ing when the row could not be read", async () => {
    // A transient Postgres error must not delete a restaurant from the
    // console: null here becomes notFound(), which is a different fact.
    store.singleFailures.locations = { code: "57014" };
    await expect(getEditableRecord(MARTY)).rejects.toThrow();
  });

  it("returns null for a restaurant that is genuinely not there", async () => {
    await expect(getEditableRecord("b0000000-0000-0000-0000-00000000000b")).resolves.toBeNull();
  });
});

/* ── staff picks ───────────────────────────────────────────────────── */

/** A thin wrapper over saveMenuItem, using Marty's own item so ownership
 *  and category checks pass without being the point of the test. Reuses
 *  the same fake PostgREST client and `store` every other saveMenuItem
 *  test in this file drives -- `failWith` seeds store.writeFailures the
 *  same way the rest of the suite would, to reach the 23514 branch
 *  without a real trigger. */
async function runSaveMenuItem(
  over: Partial<Parameters<typeof validateMenuItem>[0]> = {},
  opts: { failWith?: string } = {},
) {
  if (opts.failWith) {
    store.writeFailures.menu_items = { code: opts.failWith };
  }
  const result = await saveMenuItem({
    locationId: MARTY,
    itemId: MARTY_ITEM,
    input: {
      categoryId: MARTY_CATEGORY,
      name: "Carbonara",
      description: "Guanciale, pecorino, egg",
      priceDollars: "22.00",
      allergenNote: "",
      sortOrder: "0",
      soldOutUntil: "",
      staffPick: false,
      ...over,
    },
  });
  return { ...result, writes: store.writes };
}

/** A thin wrapper over createMenuItem, the same shape runSaveMenuItem is
 *  above it, and named for the same reason: `failWith` seeds
 *  store.writeFailures to reach the 23514 branch without a real trigger.
 *  The dish is named "Tiramisu" rather than Marty's own "Carbonara" so
 *  the duplicate-name check does not refuse the write before it ever
 *  reaches the insert this test is about. */
async function runCreateMenuItem(opts: { failWith?: string } = {}) {
  if (opts.failWith) {
    store.writeFailures.menu_items = { code: opts.failWith };
  }
  const result = await createMenuItem({
    locationId: MARTY,
    input: {
      categoryId: MARTY_CATEGORY,
      name: "Tiramisu",
      description: "",
      priceDollars: "9.00",
      allergenNote: "",
      sortOrder: "0",
      soldOutUntil: "",
      staffPick: true,
    },
  });
  return { ...result, writes: store.writes };
}

describe("staff picks", () => {
  it("carries the flag through to the write", async () => {
    const { writes } = await runSaveMenuItem({ staffPick: true });
    expect(writes.at(-1)?.patch?.is_staff_pick).toBe(true);
  });

  it("turns the trigger's refusal into a sentence an operator can act on", async () => {
    // The trigger raises 23514. An operator must not be shown a Postgres
    // error, and must be told the actual rule.
    const result = await runSaveMenuItem({ staffPick: true }, { failWith: "23514" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/three/i);
    expect(result.ok === false && result.error).not.toMatch(/23514|violates|constraint/i);
  });

  it("maps the same cap refusal on create as on save", async () => {
    // AddItemForm hardcodes staffPick: false today, so this path is not
    // reachable through the shipped UI -- but createItemAction accepts
    // the flag from the client regardless, and the two writers of this
    // table have to stay symmetric rather than depend on which form
    // happens to expose the checkbox. Before this fix, createMenuItem
    // returned the generic WRITE_FAILED for the identical 23514 here.
    const result = await runCreateMenuItem({ failWith: "23514" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/three/i);
    expect(result.ok === false && result.error).not.toMatch(/23514|violates|constraint/i);
  });
});
