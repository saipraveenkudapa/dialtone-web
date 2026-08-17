import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocationRow } from "@/lib/supabase/types";

/** The guard on `provisionAssistantForLocation`, and only that.
 *
 *  This is the function that turns a restaurant's fallback number into
 *  the assistant's NATIVE transfer destination on Vapi -- baked into the
 *  payload at build time and read by nothing afterwards. It refused a
 *  MISSING number and accepted anything else, which meant every road
 *  that rebuilds an assistant (create-restaurant, the operator's edit
 *  screen, go-live's repair) could push "12" or a legacy
 *  "(510) 555-0199" to Vapi, where it either 400s the whole provisioning
 *  call or is accepted as a destination that fails the one time it is
 *  used. repairAssistant is what an operator reaches for when something
 *  is ALREADY wrong; it must not be able to write a new wrong thing on
 *  the way past.
 *
 *  Everything the function touches after the guard is mocked, because
 *  the property under test is that nothing is touched at all. */

/** The row write that saves the tool-secret hash. Only ever asserted
 *  NOT to have happened, which is the point: the guard runs before it. */
const writeSecretHash = vi.fn(async () => ({ error: null }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: () => ({ update: () => ({ eq: () => writeSecretHash() }) }),
  }),
}));

/** The one Vapi call this function makes. Typed by its argument, because
 *  the payload it is handed is what the assertion below reads: this is
 *  the exact object that becomes an assistant's transfer destination. */
type UpsertArg = {
  vapiKey: string;
  locationId: string;
  payload: {
    model: { tools: Array<{ type: string; destinations?: Array<{ number?: string }> }> };
  };
};
const upserted: UpsertArg[] = [];
const upsertAssistant = vi.fn((arg: UpsertArg) => {
  upserted.push(arg);
  return Promise.resolve({ assistant: { id: "asst-1" }, created: true });
});
vi.mock("@/lib/vapi/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vapi/provision")>()),
  upsertAssistant: (arg: UpsertArg) => upsertAssistant(arg),
}));

vi.mock("@/lib/agent/prompt", () => ({
  buildSystemPrompt: () => "You are answering the phone.",
  buildGreeting: () => "Hi, thanks for calling!",
}));

const { provisionAssistantForLocation } = await import("./assistant");

const BASE = "https://dialtone.example.com";

function location(fallback: string | null): LocationRow {
  return {
    id: "a10c0000-0000-0000-0000-00000000000a",
    name: "Nonna Rosa",
    fallback_human_number: fallback,
  } as unknown as LocationRow;
}

function provision(fallback: string | null) {
  return provisionAssistantForLocation({
    location: location(fallback),
    hours: [],
    base: BASE,
    vapiKey: "vapi-test-key",
  });
}

describe("provisionAssistantForLocation's fallback-number guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upserted.length = 0;
  });

  it("still refuses a location with no fallback number at all", async () => {
    await expect(provision(null)).rejects.toThrow(/no fallback number/);
    expect(upsertAssistant).not.toHaveBeenCalled();
    expect(writeSecretHash).not.toHaveBeenCalled();
  });

  it("refuses a number that is set but is not a number, before it spends anything", async () => {
    await expect(provision("12")).rejects.toThrow(/not in the shape Vapi and Twilio dial/);
    // Not "there is no fallback number": there is one, and the operator
    // reading this is looking at it.
    await expect(provision("12")).rejects.toThrow(/12/);
    expect(upsertAssistant).not.toHaveBeenCalled();
    expect(writeSecretHash).not.toHaveBeenCalled();
  });

  it("refuses a real number stored in a shape Vapi will not accept", async () => {
    // The legacy row: written before setFallbackNumber normalized on the
    // way in. It is dialled exactly as stored, and a bare
    // "(510) 555-0199" 400s with "must be a valid phone number in the
    // E.164 format".
    await expect(provision("(510) 555-0199")).rejects.toThrow(
      /not in the shape Vapi and Twilio dial/,
    );
    expect(upsertAssistant).not.toHaveBeenCalled();
  });

  it("builds the assistant when the number is stored exactly as it will be dialled", async () => {
    const result = await provision("+15105550199");

    expect(result).toMatchObject({ assistantId: "asst-1", created: true });
    expect(upsertAssistant).toHaveBeenCalledTimes(1);

    const arg = upserted[0];
    const transfer = arg.payload.model.tools.find((t) => t.type === "transferCall");
    // Handed through UNCHANGED. Normalizing here would make the number
    // Vapi dials and the number the column holds two different strings,
    // silently, on the screen whose job is to say what a restaurant does.
    expect(transfer?.destinations?.[0]?.number).toBe("+15105550199");
  });
});
