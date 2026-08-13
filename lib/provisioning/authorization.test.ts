import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestaurantDraft } from "./draft";

/* Who is allowed to create a restaurant.
 *
 * The answer is "platform staff, and nobody else," and the only version
 * of that answer worth anything is the one enforced on the server. The
 * "Create a new restaurant" button lives behind app/admin/layout.tsx, but
 * a "use server" export is a live HTTP endpoint from the moment it is
 * compiled: anyone who can find its action id can POST to it without ever
 * loading the page that renders the button. These tests drive the action
 * and the module beneath it directly, exactly the way that POST would --
 * no page, no layout, no button.
 *
 * What makes the stakes specific rather than generic: this is the one
 * code path in the product that holds the service-role key, which bypasses
 * RLS on every table in the database. A restaurant owner who could reach
 * it would not just be creating an unwanted organization; they would be
 * running code that can read and write every other tenant's rows. */

const currentPlatformAdmin = vi.fn();

vi.mock("@/lib/admin/auth", () => ({
  currentPlatformAdmin: () => currentPlatformAdmin(),
}));

// If any of these is ever touched by an unauthorized call, the test
// fails loudly rather than quietly succeeding. supabaseAdmin() is the
// service-role client; reaching it at all is already the breach.
const serviceRoleClientRequested = vi.fn(() => {
  throw new Error("the service-role client must not be reachable by a non-admin caller");
});
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => serviceRoleClientRequested(),
}));

const upsertAssistant = vi.fn(() => {
  throw new Error("Vapi must not be called by a non-admin caller");
});
vi.mock("@/lib/vapi/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vapi/provision")>()),
  upsertAssistant: () => upsertAssistant(),
  deleteAssistant: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: "https://dialtone.example.com" }),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: () => revalidatePath() }));

const { createRestaurantAction } = await import("@/app/admin/new/actions");
const { createRestaurant } = await import("./create-restaurant");

const OWNER = { userId: "11111111-1111-1111-1111-111111111111", email: "owner@nonnarosa.test" };
const STAFF = { userId: "99999999-9999-9999-9999-999999999999", email: "admin@dialtone.test", note: "operator" };

function draft(overrides: Partial<RestaurantDraft> = {}): RestaurantDraft {
  return {
    name: "Someone Else's Restaurant",
    address: "1 Nowhere St",
    timezone: "America/Los_Angeles",
    businessPhone: "",
    fallbackNumber: "(510) 555-0100",
    ownerEmail: "attacker@example.test",
    hours: Array.from({ length: 7 }, (_, day) => ({
      dayOfWeek: day,
      closed: false,
      open: "09:00",
      close: "21:00",
    })),
    taxPercent: "8.75",
    orderTypes: "both",
    pickupPromiseMinutes: "25",
    deliveryPromiseMinutes: "45",
    seats: "40",
    maxPartySize: "8",
    reservationSlotMinutes: "90",
    menu: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VAPI_PRIVATE_KEY = "test-key";
});

describe("createRestaurantAction, called by someone who is not staff", () => {
  it.each([
    ["a signed-out stranger", null],
    ["a signed-in restaurant owner", null],
  ])("refuses %s", async (_who, admin) => {
    currentPlatformAdmin.mockResolvedValue(admin);

    const result = await createRestaurantAction(draft());

    expect(result).toEqual({ error: "Not found." });
    expect(serviceRoleClientRequested).not.toHaveBeenCalled();
    expect(upsertAssistant).not.toHaveBeenCalled();
  });

  it("tells a restaurant owner nothing about what this action is or wants", async () => {
    currentPlatformAdmin.mockResolvedValue(null);

    // A deliberately invalid draft: if the gate ran after validation, the
    // refusal would leak the shape of the form to someone who should not
    // know the endpoint exists.
    const result = await createRestaurantAction(draft({ name: "", taxPercent: "999" }));

    expect(result.error).toBe("Not found.");
    expect(result.error).not.toContain("tax");
    expect(result.error).not.toContain("name");
  });

  it("does not even revalidate a cache, so no timing or side effect distinguishes the refusal", async () => {
    currentPlatformAdmin.mockResolvedValue(null);
    await createRestaurantAction(draft());
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("createRestaurant, the module that holds the service-role key", () => {
  it("refuses a non-admin on its own, without trusting its caller to have checked", async () => {
    // The action above already checks. This is the second, independent
    // check: the module that can bypass RLS does not depend on somebody
    // else having remembered to guard it.
    currentPlatformAdmin.mockResolvedValue(null);

    const result = await createRestaurant(draft(), { base: "https://dialtone.example.com" });

    expect(result).toEqual({ ok: false, error: "Not found." });
    expect(serviceRoleClientRequested).not.toHaveBeenCalled();
  });

  it("refuses an ordinary signed-in user, membership or not", async () => {
    // currentPlatformAdmin returns null for anyone missing from
    // platform_admins -- including the owner of a real restaurant, who is
    // a fully authenticated user with rows of their own.
    currentPlatformAdmin.mockResolvedValue(null);
    expect(OWNER.email).not.toBe(STAFF.email);

    const result = await createRestaurant(draft(), { base: "https://dialtone.example.com" });

    expect(result.ok).toBe(false);
    expect(serviceRoleClientRequested).not.toHaveBeenCalled();
  });
});

describe("the gate is a gate, not a wall", () => {
  it("lets staff through to validation instead of refusing everyone", async () => {
    // Without this, every test above would pass on a function that just
    // returns "Not found." unconditionally. A staff caller with a bad
    // draft must get the validation error -- proof the gate opened.
    currentPlatformAdmin.mockResolvedValue(STAFF);

    const result = await createRestaurantAction(draft({ taxPercent: "99" }));

    expect(result.error).toContain("between 0% and 20%");
    expect(serviceRoleClientRequested).not.toHaveBeenCalled();
  });

  it("still writes nothing when staff submit a draft that cannot be stored", async () => {
    currentPlatformAdmin.mockResolvedValue(STAFF);

    const result = await createRestaurantAction(draft({ fallbackNumber: "" }));

    expect(result.error).toContain("fallback number");
    expect(serviceRoleClientRequested).not.toHaveBeenCalled();
    expect(upsertAssistant).not.toHaveBeenCalled();
  });

  it("refuses before touching the database when Vapi is not configured", async () => {
    // A restaurant whose assistant could never be created is not a
    // restaurant. Better to refuse than to leave a half-made one behind.
    currentPlatformAdmin.mockResolvedValue(STAFF);
    delete process.env.VAPI_PRIVATE_KEY;

    const result = await createRestaurantAction(draft());

    expect(result.error).toContain("VAPI_PRIVATE_KEY");
    expect(serviceRoleClientRequested).not.toHaveBeenCalled();
  });
});
