/* Building and upserting a Vapi assistant for one location -- the part
 * scripts/provision-vapi.mjs and app/onboarding/actions.ts's finish step
 * both need, and used to live only in the former. One implementation:
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
 *     to get it. The onboarding server action builds the same shape
 *     directly from lib/agent/prompt.ts against data it just saved,
 *     because at that point in signup the location is not live yet --
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
 *     onboarding action derives its base URL from the request itself
 *     (the same `origin` header app/signup/actions.ts already trusts for
 *     its confirmation link), not from something a human typed, so that
 *     defensive check has no job to do there.
 *
 * Deliberately NOT `import "server-only"`: scripts/provision-vapi.mjs
 * imports this file as a plain Node script, run with `node
 * scripts/provision-vapi.mjs`, entirely outside Next's bundler -- and
 * outside that "react-server" condition, the real server-only package
 * throws on import rather than the no-op Next swaps in. Every caller
 * inside the web app is itself a "use server" action
 * (app/onboarding/actions.ts), so this file never reaches a client
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
