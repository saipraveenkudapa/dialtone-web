import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, buildAssistantPayload } from "./provision";

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
