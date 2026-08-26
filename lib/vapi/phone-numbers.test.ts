import { beforeEach, describe, expect, it, vi } from "vitest";

/* Reading Vapi's phone numbers, asking for one, and what to do with a
 * record we cannot make sense of.
 *
 * The stakes are small but sharp: a record with no E.164 string cannot
 * be dialled, shown, or written to locations.twilio_number, and one that
 * slipped through would put an empty phone number in front of an
 * operator as if it were real. A number mid-provision is exactly that
 * record, and it is not hypothetical.
 *
 * The area code is the other half of this file, and its stakes are
 * larger. Vapi refuses a POST that carries no numberDesiredAreaCode, so
 * without one nothing works at all; and with the WRONG one it works
 * perfectly and issues a real, billed, unreturnable number in the wrong
 * city. So every refusal below asserts that no request was made, not
 * merely that an error came back -- "it threw" and "it spent nothing"
 * are different claims, and only the second one is worth anything after
 * a number exists.
 */

const vapiRequest = vi.fn();
vi.mock("@/lib/vapi/provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/vapi/provision")>()),
  vapiRequest: (...args: unknown[]) => vapiRequest(...args),
}));

const {
  NoNumberInAreaCodeError,
  NumberOutcomeUnknownError,
  areaCodeOf,
  bindPhoneNumber,
  createPhoneNumber,
  isAreaCode,
  listPhoneNumbers,
  toPhoneNumber,
} = await import("./phone-numbers");

/* The real one, not a stand-in. vapiRequest raises exactly this and
   carries the HTTP status on it, and the status is now what tells "Vapi
   refused the request" apart from "the request may have allocated a
   number and nobody read the answer" -- a distinction a bare Error
   cannot express, and one a test that fakes the error type cannot
   exercise. */
const { ProvisioningError } = await import("@/lib/vapi/provision");

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

    // The exact body, asserted whole rather than by property: the live
    // API answers a POST without numberDesiredAreaCode with "At least
    // one of numberDesiredAreaCode, sipUri must be provided" and issues
    // nothing, which is the defect this field exists to close.
    await createPhoneNumber("key", { assistantId: "a1", name: "Marty's", areaCode: "510" });
    expect(vapiRequest).toHaveBeenCalledWith("key", "POST", "/phone-number", {
      provider: "vapi",
      assistantId: "a1",
      name: "Marty's",
      numberDesiredAreaCode: "510",
    });
  });

  it("refuses to report a success it cannot describe", async () => {
    // A number may now exist and be billing. Saying "done" while
    // knowing nothing about what was created is the one answer that
    // helps nobody.
    vapiRequest.mockResolvedValue({ ok: true });
    await expect(
      createPhoneNumber("key", { assistantId: "a1", name: "Marty's", areaCode: "510" }),
    ).rejects.toThrow(/Vapi dashboard/);
  });
});

/* ── the area code ─────────────────────────────────────────────────── */

describe("what counts as an area code", () => {
  it("takes three digits that could be a NANP code", () => {
    expect(isAreaCode("510")).toBe(true);
    expect(isAreaCode("212")).toBe(true);
    expect(isAreaCode("878")).toBe(true);
    expect(isAreaCode(" 925 ")).toBe(true);
  });

  it("refuses everything that is not one", () => {
    // 0 reaches an operator and 1 opens a long-distance dial string, so
    // neither has ever begun an area code.
    expect(isAreaCode("015")).toBe(false);
    expect(isAreaCode("115")).toBe(false);
    expect(isAreaCode("51")).toBe(false);
    expect(isAreaCode("5105")).toBe(false);
    expect(isAreaCode("51a")).toBe(false);
    expect(isAreaCode("")).toBe(false);
    // A hand-rolled POST to the server action can carry anything at all.
    expect(isAreaCode(undefined)).toBe(false);
    expect(isAreaCode(510)).toBe(false);
    expect(isAreaCode(null)).toBe(false);
  });
});

describe("reading an area code out of a number already on file", () => {
  it("reads whatever format an owner typed the number in", () => {
    expect(areaCodeOf("+15105550142")).toBe("510");
    expect(areaCodeOf("(510) 555-0142")).toBe("510");
    expect(areaCodeOf("510-555-0142")).toBe("510");
    expect(areaCodeOf("5105550142")).toBe("510");
    expect(areaCodeOf("1-510-555-0142")).toBe("510");
    expect(areaCodeOf("+1 (878) 778-7878")).toBe("878");
  });

  it("reads the + before stripping it, so a foreign number yields no NANP code", () => {
    /* The regression. "+49 30 123456" is a Berlin landline and is ten
       digits, so a parse that throws the + away first hands back "493" --
       a real, dialable American area code, in a state the restaurant's
       customers are not in. The + is the one unambiguous thing in the
       string: it announces a country code, and the only country code
       this plan has is 1. */
    expect(areaCodeOf("+4930123456")).toBeNull();
    expect(areaCodeOf("+49 30 123456")).toBeNull();
    expect(areaCodeOf("+61212345678")).toBeNull();
    // And it must not cost the numbers that ARE E.164 NANP.
    expect(areaCodeOf("+15105550142")).toBe("510");
    expect(areaCodeOf("+1 (878) 778-7878")).toBe("878");
  });

  it("offers nothing rather than a guess for a number it cannot read", () => {
    // "442" is not an area code, it is the first three digits of a
    // London number -- and asking Vapi for one there would spend a real
    // number on a place that does not exist in the plan.
    expect(areaCodeOf("+442071838750")).toBeNull();
    expect(areaCodeOf("+33123456789")).toBeNull();
    expect(areaCodeOf("555-0142")).toBeNull();
    expect(areaCodeOf("0155550142")).toBeNull();
    expect(areaCodeOf("")).toBeNull();
    expect(areaCodeOf(null)).toBeNull();
    expect(areaCodeOf(undefined)).toBeNull();
  });
});

describe("asking Vapi for a number in an area code", () => {
  beforeEach(() => vi.clearAllMocks());

  const refused: [string, string][] = [
    ["begins with 0", "015"],
    ["begins with 1", "115"],
    ["is two digits", "51"],
    ["is four digits", "5105"],
    ["is not numeric", "bay"],
    ["is empty", ""],
  ];

  it.each(refused)("refuses an area code that %s, before anything is spent", async (_why, value) => {
    // The assertion that matters is the second one. A rejected promise
    // proves nothing on its own: the failure this guards against is a
    // real number issued in the wrong place, and the only evidence that
    // it did not happen is that no request left this process.
    await expect(
      createPhoneNumber("key", { assistantId: "a1", name: "Marty's", areaCode: value }),
    ).rejects.toThrow(/not an area code/);
    expect(vapiRequest).not.toHaveBeenCalled();
  });

  it("says so distinctly when Vapi has nothing left in that area code", async () => {
    // Vapi carries this in prose on the same 400 it uses for a bad body,
    // so it is read out of the message. It has to arrive as its own
    // thing: "try 925 instead" and "something in this deployment is
    // broken" send an operator to two different places.
    vapiRequest.mockRejectedValue(
      new ProvisioningError(
        "Vapi returned 400 on POST /phone-number: No phone numbers are available in area code 510.",
        400,
      ),
    );

    const failed = createPhoneNumber("key", {
      assistantId: "a1",
      name: "Marty's",
      areaCode: "510",
    });

    await expect(failed).rejects.toBeInstanceOf(NoNumberInAreaCodeError);
    await expect(failed).rejects.toThrow(/area code 510/);
    await expect(failed).rejects.toThrow(/nothing was spent/);
    // Never a loop: Vapi's pool does not refill between two requests a
    // second apart, and retrying spends the deadline of a page somebody
    // is watching to learn nothing.
    expect(vapiRequest).toHaveBeenCalledTimes(1);
  });

  it("never reads a gateway 5xx as an empty area code, however its prose reads", async () => {
    /* The regression, and it is a real body: a proxy in front of Vapi
       answers "The service is not available", which satisfies both
       halves of the prose test -- a negation and the word available.
       Read as an empty area code it becomes "nothing was issued and
       nothing was spent, try a neighbouring one", which is the exact
       shape of one ambiguous failure turning into two billed numbers.
       A 5xx on a POST that allocates is the case where a number may
       well exist. */
    vapiRequest.mockRejectedValue(
      new ProvisioningError("Vapi returned 504 on POST /phone-number: The service is not available", 504),
    );

    const failed = createPhoneNumber("key", { assistantId: "a1", name: "Marty's", areaCode: "510" });

    await expect(failed).rejects.not.toBeInstanceOf(NoNumberInAreaCodeError);
    await expect(failed).rejects.toBeInstanceOf(NumberOutcomeUnknownError);
    await expect(failed).rejects.toThrow(/cannot tell whether a number was issued/);
    // The two sentences that must never be said about this one.
    await expect(failed).rejects.not.toThrow(/nothing was spent/);
    await expect(failed).rejects.not.toThrow(/neighbouring area code/);
  });

  it("says a number may exist whenever the POST's own outcome went unread", async () => {
    /* Three roads to the same fact, and the only honest answer on all
       three is "check the dashboard". A deadline: the request left this
       process and Vapi's own message about it is written for reads. */
    for (const thrown of [
      new ProvisioningError(
        "Vapi did not answer within 20s (POST /phone-number). It is reachable but not " +
          "responding, so nothing was read and nothing was changed.",
      ),
      new ProvisioningError("Could not reach Vapi (https://api.vapi.ai/phone-number): socket hang up"),
      new SyntaxError("Unexpected end of JSON input"),
    ]) {
      vi.clearAllMocks();
      vapiRequest.mockRejectedValue(thrown);
      await expect(
        createPhoneNumber("key", { assistantId: "a1", name: "Marty's", areaCode: "510" }),
      ).rejects.toBeInstanceOf(NumberOutcomeUnknownError);
    }

    // And the 201 whose body could not be read is the same fact reached
    // from the other side: Vapi said yes and we cannot say to what.
    vi.clearAllMocks();
    vapiRequest.mockResolvedValue({ ok: true });
    await expect(
      createPhoneNumber("key", { assistantId: "a1", name: "Marty's", areaCode: "510" }),
    ).rejects.toBeInstanceOf(NumberOutcomeUnknownError);
  });

  it("leaves a refusal Vapi actually made exactly as it was", async () => {
    // A 4xx never reached the pool -- Vapi is saying it declined the
    // request -- so it is passed on untouched, with no claim added in
    // either direction.
    const refusal = new ProvisioningError("Vapi returned 402 on POST /phone-number: Quota", 402);
    vapiRequest.mockRejectedValue(refusal);

    const failed = createPhoneNumber("key", { assistantId: "a1", name: "Marty's", areaCode: "510" });
    await expect(failed).rejects.toBe(refusal);
  });

  it("leaves every other Vapi failure exactly as it was", async () => {
    // The narrow read matters in both directions. A 503 carries the word
    // "unavailable" and is not an empty area code, and reporting it as
    // one would send an operator round a loop of area codes while the
    // API is down.
    vapiRequest.mockRejectedValue(
      new Error("Vapi returned 503 on POST /phone-number: Service Unavailable"),
    );

    const failed = createPhoneNumber("key", {
      assistantId: "a1",
      name: "Marty's",
      areaCode: "510",
    });
    await expect(failed).rejects.toThrow(/503/);
    await expect(failed).rejects.not.toBeInstanceOf(NoNumberInAreaCodeError);
  });
});
