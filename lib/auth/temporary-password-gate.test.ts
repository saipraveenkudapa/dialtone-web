import { beforeEach, describe, expect, it, vi } from "vitest";
import { MUST_CHANGE_PASSWORD_CLAIM } from "./must-change-password";

/* An account still using the password its operator generated writes
 * nothing.
 *
 * The middleware stops it loading /dashboard, and that is worth exactly
 * as much as /signup's hidden page was: a "use server" export is a live
 * HTTP endpoint from the moment it compiles, and anyone holding its
 * action id can POST to it without ever loading the screen that renders
 * its button. /signup shipped with the page hidden and the action
 * reachable. These tests drive the actions the way that POST would --
 * no page, no middleware, no button -- and require them to refuse on
 * their own. */

const getUser = vi.fn();
const tableTouched = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: { getUser },
    from: (table: string) => {
      tableTouched(table);
      return { update: () => ({ eq: async () => ({ error: null }) }) };
    },
  }),
}));

const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath }));

const { saveCallNotes } = await import("@/app/dashboard/calls/actions");
const { setMessageHandled } = await import("@/app/dashboard/messages/actions");

const FLAGGED = {
  id: "22222222-2222-2222-2222-222222222222",
  email: "owner@brandnew.test",
  app_metadata: { [MUST_CHANGE_PASSWORD_CLAIM]: true },
};

const SETTLED = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "owner@nonnarosa.test",
  app_metadata: {},
};

const A_MESSAGE = "8f0f8c6e-1111-4111-8111-111111111111";

function signedInAs(user: unknown) {
  getUser.mockResolvedValue({ data: { user }, error: null });
}

function handledForm() {
  const form = new FormData();
  form.set("id", A_MESSAGE);
  form.set("handled", "true");
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("server actions, called by an account that has not set its own password", () => {
  it("saveCallNotes refuses and writes nothing", async () => {
    signedInAs(FLAGGED);

    const result = await saveCallNotes("8f0f8c6e-0000-4000-8000-000000000000", "seen it");

    expect(result).toEqual({ error: "Set your own password before changing anything here." });
    expect(tableTouched).not.toHaveBeenCalled();
  });

  it("setMessageHandled refuses and writes nothing", async () => {
    signedInAs(FLAGGED);

    await setMessageHandled(handledForm());

    expect(tableTouched).not.toHaveBeenCalled();
    // Not even a cache repaint: nothing about the screen changed, and a
    // revalidate would suggest something had.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses when the session cannot be checked at all, rather than assuming the best", async () => {
    // Supabase unreachable mid-request. "I do not know whether this
    // handover is finished" has to read as "it is not".
    getUser.mockRejectedValue(new Error("network"));

    const result = await saveCallNotes("8f0f8c6e-0000-4000-8000-000000000000", "seen it");

    expect(result).toEqual({ error: "Set your own password before changing anything here." });
    expect(tableTouched).not.toHaveBeenCalled();
  });
});

describe("the same actions, once the password is the owner's own", () => {
  // Without these, every test above would pass against an action that
  // refuses unconditionally.
  it("saveCallNotes writes", async () => {
    signedInAs(SETTLED);

    const result = await saveCallNotes("8f0f8c6e-0000-4000-8000-000000000000", "seen it");

    expect(result).toEqual({ ok: true });
    expect(tableTouched).toHaveBeenCalledWith("calls");
  });

  it("setMessageHandled writes", async () => {
    signedInAs(SETTLED);

    await setMessageHandled(handledForm());

    expect(tableTouched).toHaveBeenCalledWith("messages");
    expect(revalidatePath).toHaveBeenCalled();
  });
});
