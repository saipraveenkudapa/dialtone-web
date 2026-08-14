import { beforeEach, describe, expect, it, vi } from "vitest";

/* Reading Vapi's phone numbers, and what to do with a record we cannot
 * make sense of.
 *
 * The stakes are small but sharp: a record with no E.164 string cannot
 * be dialled, shown, or written to locations.twilio_number, and one that
 * slipped through would put an empty phone number in front of an
 * operator as if it were real. A number mid-provision is exactly that
 * record, and it is not hypothetical.
 */

const vapiRequest = vi.fn();
vi.mock("@/lib/vapi/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vapi/provision")>()),
  vapiRequest: (...args: unknown[]) => vapiRequest(...args),
}));

const { bindPhoneNumber, createPhoneNumber, listPhoneNumbers, toPhoneNumber } = await import(
  "./phone-numbers"
);

const RECORD = {
  id: "62aa9658-4974-45e2-aff1-e640e0aa7e15",
  orgId: "c76ba50c-c0ed-42b7-b5c8-003776633edc",
  assistantId: "50816d6a-a8c2-44eb-90bd-1daa0f26cef2",
  number: "+15106268819",
  name: "Nonna Rosa",
  provider: "vapi",
  status: "active",
  providerResourceId: "cbd1c47a-488f-4ec2-82b8-2deaa18da5a4",
};

describe("reading one of Vapi's phone number records", () => {
  it("keeps the fields this product reasons about", () => {
    expect(toPhoneNumber(RECORD)).toEqual({
      id: RECORD.id,
      number: "+15106268819",
      name: "Nonna Rosa",
      provider: "vapi",
      assistantId: RECORD.assistantId,
      status: "active",
    });
  });

  it("reads an unbound number as bound to nobody, not as bound to an empty string", () => {
    expect(toPhoneNumber({ ...RECORD, assistantId: null })?.assistantId).toBeNull();
    expect(toPhoneNumber({ ...RECORD, assistantId: "" })?.assistantId).toBeNull();
  });

  it("drops a record with no number, which cannot be dialled or shown", () => {
    expect(toPhoneNumber({ ...RECORD, number: undefined })).toBeNull();
    expect(toPhoneNumber({ ...RECORD, id: "" })).toBeNull();
    expect(toPhoneNumber(null)).toBeNull();
  });
});

describe("the account's numbers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks for the list and drops the records it cannot use", async () => {
    vapiRequest.mockResolvedValue([RECORD, { id: "half-made", provider: "vapi" }]);

    await expect(listPhoneNumbers("key")).resolves.toHaveLength(1);
    // Five arguments: vapiRequest takes the body fourth and its options
    // fifth, so a GET with a deadline has to pass an explicit undefined
    // body to reach the slot that matters.
    expect(vapiRequest).toHaveBeenCalledWith("key", "GET", "/phone-number?limit=1000", undefined, undefined);
  });

  it("hands a deadline down to the request, so a hung Vapi cannot stall a page", async () => {
    // The caller that passes one is getGoLiveState, which renders the
    // only page carrying Take offline and the kill switch. Without a
    // deadline that page waits on undici's 300s headersTimeout.
    vapiRequest.mockResolvedValue([]);

    await listPhoneNumbers("key", { timeoutMs: 5000 });
    expect(vapiRequest).toHaveBeenCalledWith("key", "GET", "/phone-number?limit=1000", undefined, {
      timeoutMs: 5000,
    });
  });

  it("survives an account with nothing on it", async () => {
    vapiRequest.mockResolvedValue(null);
    await expect(listPhoneNumbers("key")).resolves.toEqual([]);
  });

  it("binds by PATCH, and asks for a new number by POST with the free-number provider", async () => {
    vapiRequest.mockResolvedValue(RECORD);

    await bindPhoneNumber("key", { phoneNumberId: "n1", assistantId: "a1", name: "Marty's" });
    expect(vapiRequest).toHaveBeenCalledWith("key", "PATCH", "/phone-number/n1", {
      assistantId: "a1",
      name: "Marty's",
    });

    await createPhoneNumber("key", { assistantId: "a1", name: "Marty's" });
    expect(vapiRequest).toHaveBeenCalledWith("key", "POST", "/phone-number", {
      provider: "vapi",
      assistantId: "a1",
      name: "Marty's",
    });
  });

  it("refuses to report a success it cannot describe", async () => {
    // A number may now exist and be billing. Saying "done" while
    // knowing nothing about what was created is the one answer that
    // helps nobody.
    vapiRequest.mockResolvedValue({ ok: true });
    await expect(createPhoneNumber("key", { assistantId: "a1", name: "Marty's" })).rejects.toThrow(
      /Vapi dashboard/,
    );
  });
});
