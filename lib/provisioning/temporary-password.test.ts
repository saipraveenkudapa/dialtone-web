import { beforeEach, describe, expect, it, vi } from "vitest";
import { MUST_CHANGE_PASSWORD_CLAIM } from "@/lib/auth/must-change-password";
import { OWNER_PASSWORD_LENGTH } from "./password";
import type { RestaurantDraft } from "./draft";

/* The password the operator reads off the screen is temporary, and the
 * thing that makes it temporary is set in the same call that creates the
 * account.
 *
 * Not a follow-up update, on purpose: an account that exists for even a
 * few hundred milliseconds with an operator-known password and no gate in
 * front of it is exactly the state this whole change exists to remove,
 * and a failed second call would leave one permanently. */

const currentPlatformAdmin = vi.fn();
vi.mock("@/lib/admin/auth", () => ({
  currentPlatformAdmin: () => currentPlatformAdmin(),
}));

const createUser = vi.fn();
const deleteUser = vi.fn(async () => ({ error: null }));
const rowsDeleted = vi.fn(async () => ({ error: null }));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    auth: { admin: { createUser: (attrs: unknown) => createUser(attrs), deleteUser } },
    // Whatever the next write is, refuse it. This test is about the auth
    // user and only the auth user; stopping here means the rollback runs
    // and nothing else has to be faked.
    from: () => ({
      insert: () => ({
        select: () => ({ single: async () => ({ data: null, error: { code: "57014" } }) }),
      }),
      delete: () => ({ eq: rowsDeleted }),
    }),
  }),
}));

vi.mock("@/lib/vapi/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vapi/provision")>()),
  upsertAssistant: vi.fn(),
  deleteAssistant: vi.fn(),
}));

const { createRestaurant } = await import("./create-restaurant");

const STAFF = { userId: "99999999-9999-9999-9999-999999999999", email: "admin@dialtone.test", note: "operator" };

function draft(): RestaurantDraft {
  return {
    name: "A Brand New Restaurant",
    address: "1 Somewhere St",
    timezone: "America/Los_Angeles",
    businessPhone: "",
    fallbackNumber: "(510) 555-0100",
    ownerEmail: "owner@brandnew.test",
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VAPI_PRIVATE_KEY = "test-key";
  currentPlatformAdmin.mockResolvedValue(STAFF);
  createUser.mockResolvedValue({ data: { user: { id: "new-owner" } }, error: null });
});

describe("the owner's account, as it is created", () => {
  it("is flagged must_change_password in the same call that mints it", async () => {
    await createRestaurant(draft(), { base: "https://dialtone.example.com" });

    expect(createUser).toHaveBeenCalledTimes(1);
    const attrs = createUser.mock.calls[0][0] as {
      app_metadata?: Record<string, unknown>;
      user_metadata?: Record<string, unknown>;
      password?: string;
    };

    expect(attrs.app_metadata).toEqual({ [MUST_CHANGE_PASSWORD_CLAIM]: true });
  });

  it("does not put the flag in user_metadata, which the owner could clear themselves", async () => {
    await createRestaurant(draft(), { base: "https://dialtone.example.com" });

    const attrs = createUser.mock.calls[0][0] as { user_metadata?: Record<string, unknown> };
    expect(attrs.user_metadata?.[MUST_CHANGE_PASSWORD_CLAIM]).toBeUndefined();
  });

  it("still gets a generated password, which is what the flag makes temporary", async () => {
    await createRestaurant(draft(), { base: "https://dialtone.example.com" });

    const attrs = createUser.mock.calls[0][0] as { password?: string };
    // Length only. The value is a secret and is never asserted on,
    // printed, or written anywhere by this test.
    expect(attrs.password).toHaveLength(OWNER_PASSWORD_LENGTH + 3);
  });

  it("is deleted again, flag and all, when the rest of the restaurant cannot be created", async () => {
    const result = await createRestaurant(draft(), { base: "https://dialtone.example.com" });

    expect(result.ok).toBe(false);
    expect(deleteUser).toHaveBeenCalledWith("new-owner");
  });
});
