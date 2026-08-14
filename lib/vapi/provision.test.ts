import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_TOOLS,
  ProvisioningError,
  buildAssistantPayload,
  getAssistant,
  tagAssistantForLocation,
  vapiRequest,
} from "./provision";

const config = {
  system_prompt: "You are answering the phone for Nonna Rosa.",
  greeting: "Hi, thanks for calling Nonna Rosa!",
  fallback_number: "+15105550142",
};

describe("buildAssistantPayload", () => {
  const payload = buildAssistantPayload({
    locationId: "a10c0000-0000-0000-0000-00000000000a",
    base: "https://dialtone.example.com",
    agentSecret: "swordfish",
    config,
  });

  it("keys the assistant to this location by metadata, not name", () => {
    expect(payload.metadata).toEqual({
      dialtone_location_id: "a10c0000-0000-0000-0000-00000000000a",
    });
  });

  it("speaks the greeting verbatim, not model-generated", () => {
    expect(payload.firstMessage).toBe(config.greeting);
    expect(payload.firstMessageMode).toBe("assistant-speaks-first");
  });

  it("carries the current system prompt", () => {
    expect(payload.model.messages).toEqual([
      { role: "system", content: config.system_prompt },
    ]);
  });

  it("registers every conversational tool plus one native transfer", () => {
    expect(payload.model.tools).toHaveLength(AGENT_TOOLS.length + 1);
    const transfer = payload.model.tools.at(-1) as { type: string; destinations: { number: string }[] };
    expect(transfer.type).toBe("transferCall");
    expect(transfer.destinations[0].number).toBe(config.fallback_number);
  });

  it("points every function tool's server at this base URL, carrying the secret", () => {
    type FunctionTool = {
      type: "function";
      function: { name: string };
      server: { url: string; headers: Record<string, string> };
    };
    const functionTools = (payload.model.tools as unknown as FunctionTool[]).filter(
      (t) => t.type === "function",
    );
    expect(functionTools).toHaveLength(AGENT_TOOLS.length);
    for (const tool of functionTools) {
      const spec = AGENT_TOOLS.find((t) => t.name === tool.function.name)!;
      expect(tool.server.url).toBe(`https://dialtone.example.com/api/agent/${spec.path}`);
      expect(tool.server.headers["x-dialtone-secret"]).toBe("swordfish");
    }
  });

  it("truncates a name over 40 characters, but keys metadata on the full id", () => {
    const longId = "a".repeat(50);
    const p = buildAssistantPayload({
      locationId: longId,
      base: "https://dialtone.example.com",
      agentSecret: "swordfish",
      config,
    });
    expect(p.name).toHaveLength(40);
    expect(p.metadata).toEqual({ dialtone_location_id: longId });
  });

  it("defaults to openai/gpt-4o at temperature 0.3, boring on purpose", () => {
    expect(payload.model.provider).toBe("openai");
    expect(payload.model.model).toBe("gpt-4o");
    expect(payload.model.temperature).toBe(0.3);
  });

  it("sets pacing so the assistant doesn't talk over callers or leave gaps", () => {
    expect(payload.startSpeakingPlan.waitSeconds).toBe(0.6);
    expect(payload.startSpeakingPlan.transcriptionEndpointingPlan).toEqual({
      onPunctuationSeconds: 0.1,
      onNoPunctuationSeconds: 1.8,
      onNumberSeconds: 1.0,
    });
  });

  it("sets pacing so a real interruption cuts in fast but noise and backchannel don't", () => {
    expect(payload.stopSpeakingPlan.numWords).toBe(1);
    expect(payload.stopSpeakingPlan.backoffSeconds).toBe(1);
    expect(payload.stopSpeakingPlan.acknowledgementPhrases).toEqual(
      expect.arrayContaining(["okay", "yeah", "mm-hmm", "got it"]),
    );
    expect(payload.stopSpeakingPlan.interruptionPhrases).toEqual(
      expect.arrayContaining(["stop", "wait"]),
    );
  });

  // Multilingual, per-call, with nothing chosen in advance: nova-3's
  // "multi" mode is Deepgram's broadest real-time code-switching option
  // (verified against Vapi's own DeepgramTranscriberModel/Language SDK
  // enums, not assumed), so a caller is heard correctly without anyone
  // picking a language up front.
  it("sets a multilingual, auto-detecting transcriber", () => {
    expect(payload.transcriber).toEqual({
      provider: "deepgram",
      model: "nova-3",
      language: "multi",
    });
  });

  // eleven_flash_v2_5 over eleven_multilingual_v2: verified against Vapi's
  // own ElevenLabsVoiceModel SDK enum, it's the widest-language
  // (32-language) ElevenLabs model at real-time latency, which is what a
  // live phone call needs. One assistant still has exactly one voice,
  // so this buys correct vocabulary and grammar in every language it
  // covers, not a native accent in each -- see the comment on VOICE in
  // provision.ts for the honest ceiling.
  it("sets a multilingual voice", () => {
    expect(payload.voice).toEqual({
      provider: "11labs",
      voiceId: "sarah",
      model: "eleven_flash_v2_5",
    });
  });

  it("honours an explicit model override", () => {
    const p = buildAssistantPayload({
      locationId: "loc-1",
      base: "https://dialtone.example.com",
      agentSecret: "swordfish",
      config,
      modelProvider: "anthropic",
      modelName: "claude",
    });
    expect(p.model.provider).toBe("anthropic");
    expect(p.model.model).toBe("claude");
  });
});

/* ── talking to Vapi ───────────────────────────────────────────────── */

/* The failure shapes that actually happen to this product, and how each
 * one has to read to the caller.
 *
 * The sharp one is the hang. A load balancer with no healthy backend
 * accepts the connection and never answers, and `fetch` with no signal
 * waits on undici's 300s headersTimeout -- which, on the operator's
 * go-live page, means the only screen carrying "Take offline" and the
 * kill switch does not paint for five minutes because a third party
 * stopped responding. Every other Vapi failure in this file is already
 * handled; a hang was the one that was not.
 */
describe("one request against Vapi", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function respond(status: number, body: unknown) {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
    ) as typeof fetch;
  }

  it("gives every request a deadline, and never an unbounded one", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await vapiRequest("key", "GET", "/assistant");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("turns a hang into a sentence, rather than waiting five minutes on undici", async () => {
    // The abort a deadline produces, named exactly as the platform names
    // it. Reported as its own fact: Vapi answered nothing, which is not
    // the same as refusing.
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;

    await expect(vapiRequest("key", "GET", "/phone-number", undefined, { timeoutMs: 5000 })).rejects.toThrow(
      /did not answer within 5s/,
    );
  });

  it("carries the HTTP status, so 'that assistant is gone' is not guessed from a string", async () => {
    respond(404, { message: "Not Found" });

    const err = await vapiRequest("key", "GET", "/assistant/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as ProvisioningError).status).toBe(404);
  });

  it("still names the key, and only the variable, on a 401", async () => {
    respond(401, { message: "Unauthorized" });

    const err = await vapiRequest("super-secret-key", "GET", "/assistant").catch((e: unknown) => e);
    expect((err as ProvisioningError).status).toBe(401);
    expect((err as Error).message).toMatch(/VAPI_PRIVATE_KEY/);
    expect((err as Error).message).not.toMatch(/super-secret-key/);
  });
});

describe("the assistant a record names", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("reads null only when Vapi says there is no such assistant", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(getAssistant("key", "a1")).resolves.toBeNull();
  });

  it("throws on anything else, because 'could not ask' is not 'not there'", async () => {
    // The caller above turns null into "build a replacement", which
    // forks a live assistant and rotates its tool secret. A 500 must
    // never take that path.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(getAssistant("key", "a1")).rejects.toThrow(ProvisioningError);
  });

  it("re-labels in place, keeping metadata another tool wrote", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "a1" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await tagAssistantForLocation(
      "key",
      { id: "a1", metadata: { someone_elses: "keep me" } },
      "loc-1",
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.vapi.ai/assistant/a1");
    expect(init.method).toBe("PATCH");
    // Only metadata, and the existing keys survive: this is a repair on
    // an assistant that may be on a live call, not a rebuild.
    expect(JSON.parse(init.body as string)).toEqual({
      metadata: { someone_elses: "keep me", dialtone_location_id: "loc-1" },
    });
  });
});
