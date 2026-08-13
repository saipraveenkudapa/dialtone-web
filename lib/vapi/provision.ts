/* Building and upserting a Vapi assistant for one location -- the part
 * scripts/provision-vapi.mjs and lib/provisioning/assistant.ts -- the
 * operator's "Create a new restaurant" action -- both need, and which
 * used to live only in the former. One implementation:
 * the nine tool definitions, the assistant payload they and the system
 * prompt assemble into, and the create-or-update call against Vapi's own
 * API. Read scripts/provision-vapi.mjs's own header first -- it is still
 * the spec for the idempotency contract this rests on
 * (metadata.dialtone_location_id is what "the assistant for this
 * location" means, not name or a locally-cached id) and for what
 * docs/vapi-setup.md says every tool's request/response shape must be.
 *
 * What stays OUT of this file, on purpose:
 *   - fetching the assistant config (system prompt / greeting / fallback
 *     number) for a location. The CLI script fetches it over HTTP from a
 *     deployed app/api/agent/assistant, because that is the one honest
 *     way for an operator wiring a real, live, already-deployed location
 *     to get it. lib/provisioning/assistant.ts builds the same shape
 *     directly from lib/agent/prompt.ts against data it just saved,
 *     because at that point the location is not live yet --
 *     POST /api/agent/assistant would refuse it (assistant_enabled:
 *     false), and going over HTTP to itself would be a pointless round
 *     trip for a server action that already has a database connection.
 *     Both produce the same AssistantConfig shape below; this module
 *     doesn't care which caller produced it.
 *   - validating that the base URL is a real, public, https origin Vapi
 *     can actually reach. That check exists for one reason: a human
 *     operator typing a CLI argument can fat-finger `localhost` or
 *     `http://`. scripts/provision-vapi.mjs keeps it, with the long
 *     explanation of exactly what silently breaks if it's skipped. The
 *     operator's server action derives its base URL from the request
 *     itself (the same `origin` header the magic-link redirect already
 *     trusts), not from something a human typed, so that
 *     defensive check has no job to do there.
 *
 * Deliberately NOT `import "server-only"`: scripts/provision-vapi.mjs
 * imports this file as a plain Node script, run with `node
 * scripts/provision-vapi.mjs`, entirely outside Next's bundler -- and
 * outside that "react-server" condition, the real server-only package
 * throws on import rather than the no-op Next swaps in. Every caller
 * inside the web app is reached only from a "use server" action
 * (app/admin/new/actions.ts), so this file never reaches a client
 * bundle regardless of the missing guard. */

export const VAPI_API = "https://api.vapi.ai";

export class ProvisioningError extends Error {}

/** What an assistant needs to say and do for one call. The same three
 *  fields POST /api/agent/assistant returns alongside assembled_at /
 *  expires_at / assistant_enabled -- this module only ever receives a
 *  config a caller has already decided is fit to provision with. */
export type AssistantConfig = {
  system_prompt: string;
  greeting: string;
  fallback_number: string;
};

type ToolDefinition = {
  name: string;
  path: string;
  description: string;
  properties: Record<string, unknown>;
  required: string[];
  staticParameters?: { key: string; value: string }[];
};

// One entry per app/api/agent/*/route.ts. `properties`/`required` are the
// JSON Schema the MODEL sees and fills in from what the caller said --
// read against each route's own `body = await request.json()` type
// annotation, not against docs/vapi-setup.md's prose table, so a
// mismatch between the two would have been caught while writing this.
// `staticParameters`, where present, are Vapi's own mechanism for
// merging a value into the request body that the MODEL must never be
// asked to supply -- provider_call_id is Vapi's id for the call in
// progress (`{{call.id}}`, a Liquid template Vapi resolves per call),
// not something a caller ever says out loud.
export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "get_menu",
    path: "menu",
    description:
      "Look up this restaurant's current menu: categories, items, pre-tax prices, and which items " +
      "are sold out right now. Call this every single time the caller mentions food -- never answer " +
      "a menu question from memory or from earlier in this same call, since prices and sold-out " +
      "status can change mid-call.",
    properties: {
      item: {
        type: "string",
        description:
          'The specific item the caller asked about, in their own words (e.g. "the squid ink ' +
          'pasta", "wings"). Leave this out to just fetch the whole menu.',
      },
    },
    required: [],
  },
  {
    name: "get_hours",
    path: "hours",
    description:
      "Check whether the restaurant is open right now, what today's hours are, and when it opens " +
      "next if it's closed.",
    properties: {},
    required: [],
  },
  {
    name: "check_availability",
    path: "availability",
    description:
      "Check whether a table is free for a given date, time and party size. Always call this " +
      "before promising a time to the caller -- never say a time is open until this says so.",
    properties: {
      requested_at: {
        type: "string",
        description:
          "The requested date and time as a full ISO 8601 timestamp (e.g. " +
          '"2026-08-14T19:00:00-07:00"), resolved from what the caller said against the current ' +
          "date and time given in your instructions.",
      },
      party_size: { type: "integer", description: "How many people are in the party." },
    },
    required: ["requested_at", "party_size"],
  },
  {
    name: "create_reservation",
    path: "reservation",
    description:
      "Book a table. Call check_availability first, and read the booking back to the caller before " +
      "calling this.",
    properties: {
      requested_at: {
        type: "string",
        description: "The reservation date and time as a full ISO 8601 timestamp.",
      },
      party_size: { type: "integer", description: "How many people are in the party." },
      customer_name: { type: "string", description: "The caller's first name, for the reservation." },
      customer_phone: { type: "string", description: "A callback phone number for the reservation." },
    },
    required: ["requested_at", "party_size", "customer_name", "customer_phone"],
    staticParameters: [{ key: "provider_call_id", value: "{{call.id}}" }],
  },
  {
    name: "cancel_reservation",
    path: "cancel-reservation",
    description:
      "Cancel an existing table reservation. Needs the first name it's under, the phone number, " +
      "and roughly when the table is -- all three together, or nothing is found.",
    properties: {
      customer_name: { type: "string", description: "The first name the reservation is under." },
      customer_phone: { type: "string", description: "The phone number the reservation is under." },
      booking_time: {
        type: "string",
        description:
          "Roughly when the table is, as a full ISO 8601 timestamp -- it does not need to be " +
          'exact to the minute (e.g. "around seven" is fine).',
      },
    },
    required: ["customer_name", "customer_phone", "booking_time"],
  },
  {
    name: "change_reservation",
    path: "change-reservation",
    description:
      "Move an existing reservation to a new time and/or party size. Needs the first name, phone " +
      "number and roughly when the CURRENT booking is, plus the new time.",
    properties: {
      customer_name: { type: "string", description: "The first name the existing reservation is under." },
      customer_phone: { type: "string", description: "The phone number the existing reservation is under." },
      booking_time: {
        type: "string",
        description: "Roughly when the EXISTING table is, as a full ISO 8601 timestamp.",
      },
      new_requested_at: {
        type: "string",
        description: "The NEW date and time being requested, as a full ISO 8601 timestamp.",
      },
      new_party_size: {
        type: "integer",
        description: "The new party size, if it's changing. Leave out to keep the party size the booking already has.",
      },
    },
    required: ["customer_name", "customer_phone", "booking_time", "new_requested_at"],
  },
  {
    name: "place_order",
    path: "order",
    description:
      "Place a takeout or delivery order. Read the whole order back with the total -- and say the " +
      "total is before tax -- before calling this.",
    properties: {
      items: {
        type: "array",
        description: "Every item on the order.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The menu item's name, as it appears in what get_menu returned.",
            },
            quantity: { type: "integer", description: "How many of this item." },
            note: {
              type: "string",
              description:
                "Any change the caller asked for on this specific item, in their own words (e.g. " +
                '"no onions", "sauce on the side"). Leave out if there is no change on this item.',
            },
          },
          required: ["name", "quantity"],
        },
      },
      type: {
        type: "string",
        enum: ["pickup", "delivery"],
        description: "Pickup or delivery. Defaults to pickup if the caller didn't say.",
      },
      customer_name: { type: "string", description: "The caller's first name." },
      customer_phone: { type: "string", description: "A callback phone number." },
      address: {
        type: "string",
        description: "The delivery address. Required when type is delivery, otherwise leave out.",
      },
    },
    required: ["items", "customer_name", "customer_phone"],
    staticParameters: [{ key: "provider_call_id", value: "{{call.id}}" }],
  },
  {
    name: "transfer_to_human",
    path: "transfer",
    description:
      "Transfer the call to a person at the restaurant. Only two things reach a person: a catering " +
      "or large order, and anything to do with an allergy, an intolerance, celiac, or what is in a " +
      "dish for a health reason. Everything else you cannot handle -- an upset caller, a complaint, " +
      "a request for a manager, anything about payment or money owed, anything outside what you " +
      "can do, anything you've failed twice to understand -- is take_message, not this.",
    properties: {
      reason: {
        type: "string",
        description:
          'A short internal note on why you are transferring (e.g. "allergy question", "catering ' +
          'order"). This is not spoken to the caller.',
      },
    },
    required: [],
    staticParameters: [{ key: "provider_call_id", value: "{{call.id}}" }],
  },
  {
    name: "take_message",
    path: "message",
    description:
      "Take a message for the restaurant to call back about. Use this for anything you cannot " +
      "handle yourself except a catering order or an allergy question: an upset caller, a " +
      "complaint about a past order, a request for a manager or a person, anything about payment, " +
      "refunds or money owed, anything outside what you can do, and anything you still cannot make " +
      "out after two tries. Apologise, take all three details, then call this and tell them " +
      "someone will call them back.",
    properties: {
      caller_name: { type: "string", description: "The caller's name." },
      callback_number: {
        type: "string",
        description: "The best number to call them back on, as they said it.",
      },
      message: {
        type: "string",
        description:
          "What the message is about, in the caller's own words -- what to pass on to the " +
          "restaurant. Never a card number.",
      },
    },
    required: ["caller_name", "callback_number", "message"],
    staticParameters: [{ key: "provider_call_id", value: "{{call.id}}" }],
  },
];

function buildFunctionTool(tool: ToolDefinition, base: string, agentSecret: string) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: { type: "object", properties: tool.properties, required: tool.required },
    },
    server: {
      url: `${base}/api/agent/${tool.path}`,
      headers: { "x-dialtone-secret": agentSecret },
    },
    ...(tool.staticParameters ? { parameters: tool.staticParameters } : {}),
  };
}

/** The other, distinct half of "a transfer destination" -- see
 *  scripts/provision-vapi.mjs's original module header (preserved there)
 *  for the full reasoning: transfer_to_human above is a `function` tool
 *  that only ever returns JSON to the model, while Vapi's native
 *  `transferCall` tool type is the one thing that can actually move the
 *  live phone leg, with a destination baked in statically rather than
 *  looked up mid-call. */
function nativeTransferTool(fallbackNumber: string) {
  return {
    type: "transferCall",
    destinations: [
      {
        type: "number",
        number: fallbackNumber,
        message: "Let me get someone for you, one moment.",
      },
    ],
  };
}

/* Language: how the assistant hears and speaks whatever language a caller
 * uses, so a call can be answered in it without anyone picking that
 * language in advance. Every provider/model/language string below was
 * checked directly against Vapi's own generated SDK types
 * (github.com/VapiAI/server-sdk-typescript/tree/main/src/api/types --
 * `DeepgramTranscriberModel`, `DeepgramTranscriberLanguage`,
 * `ElevenLabsVoiceModel`, `ElevenLabsVoiceIdEnum`,
 * `CreateAssistantDtoTranscriber`/`CreateAssistantDtoVoice` for the
 * `provider` discriminators themselves), not assumed from memory or
 * prose docs -- a wrong string here doesn't error, it silently falls
 * back to a worse default or single-language behaviour, and that only
 * shows up the moment a caller who doesn't speak English rings in.
 *
 * TRANSCRIBER: Deepgram, model nova-3, language "multi". This is the
 * pairing Vapi's own multilingual guide
 * (docs.vapi.ai/customization/multilingual) recommends for automatic
 * per-call language detection with no fixed language list configured up
 * front -- the owner's explicit ask. nova-3 over nova-2 specifically:
 * Deepgram's nova-2 "multi" mode only code-switches between Spanish and
 * English, while nova-3 "multi" covers ten (English, Spanish, French,
 * German, Hindi, Russian, Portuguese, Japanese, Italian, Dutch) with
 * materially better accuracy in Deepgram's own comparison
 * (developers.deepgram.com/docs/models-languages-overview). That is a
 * real, current limit worth being honest about: a caller in, say,
 * Arabic, Korean, or Mandarin still gets transcribed -- Deepgram still
 * auto-detects a single language per utterance outside that list -- but
 * not through the same real-time code-switching path this was tuned
 * and measured for. Ten languages is the ceiling Vapi exposes today for
 * "detect it automatically, per call, with nothing chosen in advance,"
 * not a promise that covers every language a caller might speak.
 *
 * VOICE: ElevenLabs (`11labs`), model eleven_flash_v2_5, voice "sarah"
 * (one of Vapi's own curated `ElevenLabsVoiceIdEnum` presets, so it's a
 * real voice in every account, not an id that has to exist in someone's
 * personal Voice Library). eleven_flash_v2_5 over eleven_multilingual_v2:
 * per ElevenLabs' own model docs (elevenlabs.io/docs/models),
 * eleven_flash_v2_5 covers 32 languages -- all of
 * eleven_multilingual_v2's 29 plus Hungarian, Norwegian and Vietnamese --
 * at roughly 75ms generation latency, against eleven_multilingual_v2's
 * markedly slower, "most lifelike" tuning. A restaurant phone call is a
 * real-time back-and-forth (see `START_SPEAKING_PLAN` /
 * `STOP_SPEAKING_PLAN` below, tuned for exactly this reason), and
 * ElevenLabs' own guidance is to prefer Flash for that over Multilingual
 * v2 or Turbo. No `language` is set on the voice: Vapi's own field
 * comment says only Turbo v2.5 honours it, and it would have to be
 * fixed before the call anyway -- the entire point of the transcriber
 * above is that nothing here picks the language in advance. Flash
 * infers pronunciation from the text itself, which the model already
 * wrote in whatever language it decided to answer in.
 *
 * The real ceiling, stated plainly rather than oversold: a Vapi
 * assistant has exactly one `voice`. "Sarah" is one recorded voice
 * identity, and while eleven_flash_v2_5 can make that identity speak
 * correct, fluent French, Hindi, or Portuguese, it does not swap in a
 * different native French, Hindi, or Portuguese voice actor to do it --
 * so vocabulary and grammar land natively (a native ear should not
 * catch a wrong word or a translated-sounding sentence) while the
 * accent itself carries some trace of the voice's own training accent
 * in languages further from it. Going further than that -- a
 * genuinely native accent in every language, not just correct words --
 * needs either a per-language voice selected from the transcribed
 * language (a Vapi squad routing to a different assistant/voice per
 * detected language, or a runtime voice override keyed off the
 * transcript) or a differently-trained voice model entirely. Neither is
 * this change: this is the best a single assistant, single voice, one
 * phone number can do today, and it should not be described as more
 * than that.
 */
const TRANSCRIBER = { provider: "deepgram", model: "nova-3", language: "multi" };

const VOICE = { provider: "11labs", voiceId: "sarah", model: "eleven_flash_v2_5" };

/** How long the assistant waits before it starts speaking, and how it
 *  decides the caller is actually done talking rather than mid-thought. */
const START_SPEAKING_PLAN = {
  // Vapi's own default is 0.4s, tuned for short back-and-forth app
  // turns. A phone order runs longer utterances -- multi-item lists,
  // spelled names, addresses -- with more mid-sentence hesitation than
  // that default assumes, and getting cut off while re-ordering a
  // sentence is a worse experience than a few hundred extra ms of
  // silence. 0.6s buys headroom for that without reading as a hung line.
  waitSeconds: 0.6,
  // Text-based (transcript) endpointing, not `smartEndpointingPlan`.
  // Smart endpointing requires picking a provider (LiveKit, Vapi,
  // Krisp, ...), and Vapi's own docs say LiveKit is for English only --
  // exactly the kind of language-coupled choice the future
  // multi-language work should make, not this change. Transcript-based
  // punctuation timing has no such coupling.
  transcriptionEndpointingPlan: {
    // Default (0.1s). A transcript that already ends with terminal
    // punctuation is a strong, reliable "they're done" signal -- there's
    // nothing here worth slowing down for.
    onPunctuationSeconds: 0.1,
    // Default is 1.5s. Bumped to 1.8s: a caller listing an order
    // ("a large pepperoni... a coke... and, uh...") very often trails
    // off without the transcriber ever emitting terminal punctuation,
    // and that's precisely the shape of pause this field exists to
    // survive. The extra 300ms is the difference between catching
    // "...and also a salad" and talking over it.
    onNoPunctuationSeconds: 1.8,
    // Default is 0.5s. Doubled to 1.0s. Vapi's own docs give the reason
    // this field exists at all: transcribers often punctuate mid-number
    // when a caller reads a long number in chunks. This assistant reads
    // phone numbers back digit by digit and constantly asks for phone
    // numbers, addresses, and party sizes -- a transcript ending on a
    // digit here is disproportionately likely to be mid-number, not the
    // end of the turn, so this is the single highest-value number to
    // move off the platform default.
    onNumberSeconds: 1.0,
  },
};

/** How the assistant behaves when the caller talks over it, and how it
 *  recovers afterward. */
const STOP_SPEAKING_PLAN = {
  // Vapi's default (0) stops the assistant on raw voice-activity
  // detection alone -- fastest to react, but on a phone line (kitchen
  // noise, a bad connection) that also means stopping mid-sentence for
  // a cough or a stray sound that was never a word. Requiring 1
  // transcribed word switches to transcript-based interruption
  // (slower, ~200-500ms vs ~50-100ms, per Vapi's own numbers) in
  // exchange for only stopping on something the caller actually said --
  // worth it here, since being talked over by noise is a worse failure
  // than a few hundred extra ms of latency on a real interruption.
  numWords: 1,
  // Short backchannel words ("okay", "yeah", "mm-hmm", "got it") are
  // exactly what a caller says while the assistant reads back a long
  // order or a booking -- without this list, each one would meet the
  // 1-word threshold above and cut the read-back off mid-sentence.
  acknowledgementPhrases: [
    "okay",
    "ok",
    "yeah",
    "yep",
    "right",
    "mm-hmm",
    "uh-huh",
    "got it",
    "sure",
  ],
  // The flip side of acknowledgementPhrases: words that mean the caller
  // wants in *right now* -- correcting an order mid-read-back, or
  // stopping the assistant before it finishes a sentence -- bypass the
  // numWords threshold entirely rather than waiting for a second word.
  interruptionPhrases: ["stop", "wait", "hold on", "no", "actually"],
  // Vapi's default (1s) is already the middle of its own documented
  // range (0.5s quick / 1s natural / 2s formal) and there's no reason
  // specific to a restaurant counter to move off it: long enough that
  // the assistant doesn't immediately talk back over a caller who is
  // still correcting themselves, short enough that a false-alarm
  // interruption (filtered noise, a word not in either list above)
  // doesn't leave a dead few seconds of silence on the line.
  backoffSeconds: 1,
};

export type BuildAssistantPayloadArgs = {
  locationId: string;
  /** No trailing slash. Every tool's `server.url` is built from this. */
  base: string;
  /** This location's plaintext x-dialtone-secret. Never logged, never
   *  put anywhere but a tool's own request header. */
  agentSecret: string;
  config: AssistantConfig;
  modelProvider?: string;
  modelName?: string;
};

/** The full Vapi assistant payload for one location: pure and
 *  synchronous, no I/O -- callers still decide whether and how to send
 *  it (create, update, or -- scripts/provision-vapi.mjs's --dry-run --
 *  just print it with the secret redacted). */
export function buildAssistantPayload({
  locationId,
  base,
  agentSecret,
  config,
  modelProvider = "openai",
  modelName = "gpt-4o",
}: BuildAssistantPayloadArgs) {
  return {
    // Capped at 40 characters by Vapi; the location id is what's
    // actually used to find this assistant again (see metadata below),
    // so the name only has to be recognisable, not unique.
    name: locationId.length <= 40 ? locationId : locationId.slice(0, 40),
    metadata: { dialtone_location_id: locationId },
    firstMessage: config.greeting,
    // Not "assistant-speaks-first-with-model-generated-message": the
    // greeting is spoken exactly as fetched, never regenerated by the
    // model.
    firstMessageMode: "assistant-speaks-first",
    // Top-level on the assistant, not under `model` -- these are Vapi's
    // own pacing knobs (see the constants' own comments for what each
    // number does and why).
    startSpeakingPlan: START_SPEAKING_PLAN,
    stopSpeakingPlan: STOP_SPEAKING_PLAN,
    // Also top-level, not under `model`: Vapi's transcriber (speech-to-text)
    // and voice (text-to-speech) are assistant-level, same as the pacing
    // plans above. See the comment on TRANSCRIBER/VOICE above for why
    // these two, specifically, and what they can and can't do.
    transcriber: TRANSCRIBER,
    voice: VOICE,
    model: {
      provider: modelProvider,
      model: modelName,
      // "Boring and consistent, not creative" -- docs/vapi-setup.md step 4.
      temperature: 0.3,
      messages: [{ role: "system", content: config.system_prompt }],
      tools: [
        ...AGENT_TOOLS.map((tool) => buildFunctionTool(tool, base, agentSecret)),
        nativeTransferTool(config.fallback_number),
      ],
    },
  };
}

export type VapiAssistant = { id: string; [key: string]: unknown };

/** A raw call against Vapi's own API. Shared so both callers report the
 *  same failure the same way -- an operator reading a terminal and an
 *  owner reading a web page both need to know a 401 here means the key
 *  is wrong, not that anything about the location is. */
export async function vapiRequest(
  vapiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${VAPI_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${vapiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ProvisioningError(
      `Could not reach Vapi (${VAPI_API}${path}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;

  if (res.status === 401) {
    throw new ProvisioningError(
      `Vapi rejected VAPI_PRIVATE_KEY (401 on ${method} ${path}). The key is wrong, revoked, or ` +
        "this is the public key instead of the private one -- get a fresh private key from the " +
        "Vapi dashboard's API Keys page.",
    );
  }
  if (!res.ok) {
    const detail = json?.message ?? json?.error ?? text.slice(0, 500) ?? "(empty body)";
    throw new ProvisioningError(
      `Vapi returned ${res.status} on ${method} ${path}: ${Array.isArray(detail) ? detail.join("; ") : detail}`,
    );
  }
  return json;
}

/** "The assistant for this location" -- metadata, not name or a locally
 *  cached id, is the key (see this module's own header). GET /assistant
 *  has no server-side filter for metadata, so this walks pages (newest
 *  first) comparing client-side; almost every account this runs against
 *  has a handful of assistants, not thousands, so one page is the common
 *  case. */
export async function findAssistantForLocation(
  vapiKey: string,
  locationId: string,
): Promise<VapiAssistant | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ limit: "1000" });
    if (cursor) qs.set("createdAtLt", cursor);
    const list = (await vapiRequest(vapiKey, "GET", `/assistant?${qs}`)) as VapiAssistant[];
    const match = list.find((a) => a?.metadata && (a.metadata as Record<string, unknown>).dialtone_location_id === locationId);
    if (match) return match;
    if (list.length < 1000) return null;
    cursor = list[list.length - 1]?.createdAt as string | undefined;
    if (!cursor) return null;
  }
  throw new ProvisioningError(
    "Walked 50,000 assistants without finding a match or reaching the end of the list -- " +
      "something is wrong with pagination here. Check the Vapi dashboard by hand.",
  );
}

/** Delete one assistant by id.
 *
 *  Exists for exactly one job: undoing a half-made restaurant. The
 *  operator's "Create a new restaurant" action creates the assistant
 *  before its last database writes, so a failure after that point would
 *  otherwise leave an assistant on Vapi answering for a location that no
 *  longer exists (see lib/provisioning/create-restaurant.ts's rollback).
 *  Nothing in the normal lifecycle of a live restaurant calls this --
 *  updating an assistant is upsertAssistant's PATCH, never a
 *  delete-and-recreate, which would hand the location a new assistant id
 *  and break any phone number pointed at the old one. */
export async function deleteAssistant(vapiKey: string, assistantId: string): Promise<void> {
  await vapiRequest(vapiKey, "DELETE", `/assistant/${assistantId}`);
}

/** Create-or-update, idempotent on metadata.dialtone_location_id: finds
 *  the existing assistant for this location (if any) and PATCHes it in
 *  place -- system prompt, greeting, tools and all -- rather than ever
 *  creating a second one for the same location. */
export async function upsertAssistant({
  vapiKey,
  locationId,
  payload,
}: {
  vapiKey: string;
  locationId: string;
  payload: unknown;
}): Promise<{ assistant: VapiAssistant; created: boolean }> {
  const existing = await findAssistantForLocation(vapiKey, locationId);
  if (existing) {
    const assistant = (await vapiRequest(vapiKey, "PATCH", `/assistant/${existing.id}`, payload)) as VapiAssistant;
    return { assistant, created: false };
  }
  const assistant = (await vapiRequest(vapiKey, "POST", "/assistant", payload)) as VapiAssistant;
  return { assistant, created: true };
}
