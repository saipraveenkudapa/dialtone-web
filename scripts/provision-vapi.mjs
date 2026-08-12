#!/usr/bin/env node
/* Make the Vapi account match what this codebase expects for one
   location: one assistant, carrying the current system prompt, greeting
   and a transfer destination, with the nine conversational tools
   registered against this deployment's real endpoints.

   This automates the by-hand steps in docs/vapi-setup.md ("Tool
   reference: request and response shapes" and "Assistant reference: what
   goes where"). Read that document first -- it is the spec for every
   tool's request/response shape and for what the assistant carries; this
   script does not invent any behaviour beyond what it describes. If the
   two ever disagree, the document wins; open an issue rather than
   trusting whichever this script happens to send.

   set -a && . ./.env.local && set +a
   AGENT_SECRET=<secret from scripts/set-agent-secret.mjs> \
     node scripts/provision-vapi.mjs <location-id> <public-https-base-url> [--dry-run]

   Reads:
     VAPI_PRIVATE_KEY   required. Vapi's own server-side API key. Never
                         printed -- only ever sent as an Authorization
                         header, straight to api.vapi.ai.
     AGENT_SECRET        required. This location's plaintext
                         x-dialtone-secret (what scripts/set-agent-secret.mjs
                         printed). Never printed, never put in a URL or a
                         request body -- only ever sent as the
                         x-dialtone-secret header, which is also what gets
                         written into each Vapi tool's own headers so Vapi
                         can call these endpoints back later. An env var,
                         not a CLI argument, so it never lands in shell
                         history or a `ps` listing.
     VAPI_MODEL_PROVIDER, VAPI_MODEL   optional, default "openai" /
                         "gpt-4o". Nothing in docs/vapi-setup.md or the
                         product spec pins a model, so this is a default,
                         not a requirement -- override it if this
                         location needs a different one.

   --dry-run prints the assistant payload this script would send to Vapi
   and does not call any of Vapi's write endpoints (POST/PATCH). Omit it
   to actually create or update the assistant. --dry-run also skips the
   localhost refusal below, so you can preview the real payload against
   `npm run dev` before you have a public URL -- see the check itself for
   why a real run does not get that exemption.

   What "the assistant for this location" means, for idempotency: the
   Vapi assistant whose `metadata.dialtone_location_id` equals the
   <location-id> argument. Not name (a restaurant's display name is not
   unique or stable -- it can be renamed, and two locations can share
   one), not a locally-cached assistant id (nothing here has a database
   to keep one in, deliberately -- this script only talks to this app's
   own HTTP API and Vapi's, the same two things a human wiring this by
   hand would use). `metadata` is the one piece of the Vapi assistant
   object meant for exactly this: an opaque, permanent foreign key back
   to the tenant it belongs to. Re-running this script for the same
   location finds that assistant and PATCHes it in place -- system
   prompt, greeting, tools and all -- rather than creating a second one. */

const VAPI_API = "https://api.vapi.ai";

class UsageError extends Error {}
class ProvisioningError extends Error {}

function usageAndExit(message) {
  console.error(message);
  console.error("");
  console.error(
    "usage: AGENT_SECRET=<secret> node scripts/provision-vapi.mjs <location-id> <public-https-base-url> [--dry-run]",
  );
  process.exit(1);
}

// ── args & env ──────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);
const dryRun = rawArgs.includes("--dry-run");
const [locationId, baseUrlArg] = rawArgs.filter((a) => a !== "--dry-run");

if (!locationId) usageAndExit("Missing <location-id>.");
if (!baseUrlArg) usageAndExit("Missing <public-https-base-url>.");

/** Vapi's servers place every one of these HTTP calls from their own
 *  infrastructure, not from whatever machine runs this script -- so a
 *  base URL that is not publicly reachable over HTTPS wires the
 *  assistant to endpoints Vapi can never actually call. The call would
 *  not error; it would just go nowhere, and every tool invocation and
 *  the assistant-request webhook itself would sit there until Vapi's own
 *  timeout gives up. That failure mode looks identical to "the tool is
 *  configured wrong" from the Vapi dashboard, which is what makes it the
 *  single most likely way to lose an hour here -- so it is refused
 *  up front instead, loudly, with the fix.
 *
 *  --dry-run is the one exception, and only for the localhost half of
 *  this check: a dry run calls no Vapi endpoint at all, so there is
 *  nothing for Vapi to fail to reach -- it exists specifically so this
 *  script can be exercised against `npm run dev` before a public URL
 *  exists. The https requirement still applies even in --dry-run for a
 *  non-localhost host, because a dry run still fetches
 *  /api/agent/assistant for real, over that URL, carrying AGENT_SECRET
 *  in a header -- plain http would put the tenant secret on the wire in
 *  clear text. */
function validateBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    usageAndExit(`"${raw}" is not a valid URL.`);
  }

  const host = url.hostname;
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0" || host.endsWith(".localhost");

  if (isLoopback) {
    if (dryRun) {
      console.error(
        `dry-run: allowing "${raw}" (a localhost URL) so you can preview against \`npm run dev\`. ` +
          "A real run refuses this -- see below.",
      );
    } else {
      usageAndExit(
        `Refusing to provision against "${raw}": it points at localhost. Vapi calls these ` +
          "endpoints from its own servers, over the public internet -- not from this machine -- so " +
          "it cannot reach a port on your laptop no matter how `npm run dev` is running, even with " +
          "the dev server up. Deploy this app somewhere with a public URL (or start a tunnel, e.g. " +
          "ngrok, for a temporary one) and pass that URL instead. Use --dry-run first if you just " +
          "want to preview the payload against your local dev server.",
      );
    }
  } else if (url.protocol !== "https:") {
    usageAndExit(
      `Refusing to provision against "${raw}": it is not https. Vapi calls these endpoints over ` +
        "the public internet, and step 1 of this script sends your tenant secret " +
        "(x-dialtone-secret) to this exact URL to fetch the assistant config -- plain http puts " +
        "that secret, and every reservation and order these tools handle afterwards, on the wire " +
        "unencrypted. Deploy behind HTTPS (Vercel and most hosts give you this for free) and pass " +
        "that URL.",
    );
  }

  return raw.replace(/\/+$/, "");
}

const base = validateBaseUrl(baseUrlArg);

const vapiKey = process.env.VAPI_PRIVATE_KEY;
const agentSecret = process.env.AGENT_SECRET;
const modelProvider = process.env.VAPI_MODEL_PROVIDER || "openai";
const modelName = process.env.VAPI_MODEL || "gpt-4o";

if (!vapiKey) {
  usageAndExit(
    "Set VAPI_PRIVATE_KEY (see .env.local) -- this is Vapi's own API key, " +
      "required to create or update anything in your Vapi account. " +
      "`set -a && . ./.env.local && set +a` before running this.",
  );
}
if (!agentSecret) {
  usageAndExit(
    "Set AGENT_SECRET to this location's x-dialtone-secret -- the value " +
      "scripts/set-agent-secret.mjs printed when the location was " +
      "provisioned. Pass it as an environment variable, not an argument: " +
      "AGENT_SECRET=<secret> node scripts/provision-vapi.mjs ...",
  );
}

// ── this app's own API ─────────────────────────────────────────────

/** Step 1: POST <base>/api/agent/assistant with this location's secret.
 *  Same call docs/vapi-setup.md step 2 describes -- see that document for
 *  why this has to be fetched fresh every call in production and cannot
 *  be treated as a value to copy once. For provisioning, one fresh fetch
 *  is exactly right: it is the same system prompt a real call would get
 *  the moment this assistant gets attached to a number. */
async function fetchAssistantConfig() {
  let res;
  try {
    res = await fetch(`${base}/api/agent/assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-dialtone-secret": agentSecret },
      body: "{}",
    });
  } catch (err) {
    throw new ProvisioningError(
      `Could not reach ${base}/api/agent/assistant: ${err.message}. Confirm the app is actually ` +
        "deployed and reachable at this base URL before wiring Vapi to it -- this is a network " +
        "failure, not an authorisation one.",
    );
  }

  const json = await res.json().catch(() => null);

  if (res.status === 401) {
    throw new ProvisioningError(
      `${base}/api/agent/assistant returned 401 (Not authorised). AGENT_SECRET does not match ` +
        "this location's x-dialtone-secret. Re-check the value you were given, or generate a " +
        `fresh one with: node scripts/set-agent-secret.mjs ${locationId} --force`,
    );
  }
  if (!res.ok || !json?.ok) {
    throw new ProvisioningError(
      `${base}/api/agent/assistant returned ${res.status}: ${json?.error ?? "no error message in the body"}`,
    );
  }
  return json;
}

// ── the nine tools ──────────────────────────────────────────────────
//
// One entry per app/api/agent/*/route.ts. `properties`/`required` are
// the JSON Schema the MODEL sees and fills in from what the caller said
// -- read against each route's own `body = await request.json()` type
// annotation, not against docs/vapi-setup.md's prose table, so a
// mismatch between the two would have been caught while writing this.
// `staticParameters`, where present, are Vapi's own mechanism for
// merging a value into the request body that the MODEL must never be
// asked to supply -- provider_call_id is Vapi's id for the call in
// progress (`{{call.id}}`, a Liquid template Vapi resolves per call),
// not something a caller ever says out loud.
const TOOLS = [
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
    // The counterweight to the narrowed transfer_to_human above. Every
    // reason a call used to be handed to a person and no longer is ends
    // here, so all three fields are required: a message the restaurant
    // cannot act on is worse than none, because the caller has already
    // been told somebody will ring them back. The route refuses (400)
    // with a sentence to read out when any one of them is missing or
    // could not be heard -- that is a question to ask the caller again,
    // not an error.
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

function buildFunctionTool(tool) {
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

/** Item 2 of the brief -- "a transfer destination of fallback_number" --
 *  is a second, distinct thing from the transfer_to_human tool above,
 *  and deliberately not the same tool wearing two hats:
 *
 *  Vapi's native `transferCall` tool type is the one thing on this list
 *  that can actually move the live phone leg to another number -- a
 *  `function` tool (transfer_to_human, above) only ever returns JSON to
 *  the model, the same as get_menu or place_order does. Checked against
 *  Vapi's own OpenAPI schema (api.vapi.ai/api-json) while building this:
 *  `CreateTransferCallToolDTO` has no `function` field at all, so a
 *  transferCall tool cannot be *named* `transfer_to_human` the way the
 *  system prompt's "call transfer_to_human" implies a function tool can
 *  be -- there is nothing to bind that name to. So the two tools below
 *  are not competing implementations of the same feature; they are
 *  complementary: transfer_to_human is what the model calls (and what
 *  gets logged, per /api/agent/transfer's own docstring), and this one
 *  is what actually carries the call to a person, with a destination
 *  that is already known -- fallback_number, fetched in step 1 above --
 *  and baked in statically rather than looked up from this app at
 *  transfer time. That matters for exactly the reason
 *  app/api/agent/transfer/route.ts gives for answering before it logs
 *  anything: transferring to a human is the escape hatch for when the
 *  rest of the system is degraded, so the one thing that actually moves
 *  the call must not itself depend on this app answering a webhook
 *  during the call. */
function nativeTransferTool(fallbackNumber) {
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

function buildAssistantPayload(config) {
  return {
    // Capped at 40 characters by Vapi; the location id is what's
    // actually used to find this assistant again (see metadata below),
    // so the name only has to be recognisable, not unique.
    name: locationId.length <= 40 ? locationId : locationId.slice(0, 40),
    metadata: { dialtone_location_id: locationId },
    firstMessage: config.greeting,
    // Not "assistant-speaks-first-with-model-generated-message": the
    // greeting is spoken exactly as fetched, never regenerated by the
    // model. docs/vapi-setup.md step 4 asks for pre-recorded audio for
    // this, which would need a separate TTS-and-hosting step this
    // script does not do; this is the "not model-generated" half of
    // that requirement, not the "pre-recorded" half.
    firstMessageMode: "assistant-speaks-first",
    model: {
      provider: modelProvider,
      model: modelName,
      // "Boring and consistent, not creative" -- docs/vapi-setup.md step 4.
      temperature: 0.3,
      messages: [{ role: "system", content: config.system_prompt }],
      tools: [...TOOLS.map(buildFunctionTool), nativeTransferTool(config.fallback_number)],
    },
  };
}

// ── Vapi's own API ──────────────────────────────────────────────────

async function vapiRequest(method, path, body) {
  let res;
  try {
    res = await fetch(`${VAPI_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${vapiKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ProvisioningError(`Could not reach Vapi (${VAPI_API}${path}): ${err.message}`);
  }

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;

  if (res.status === 401) {
    throw new ProvisioningError(
      `Vapi rejected VAPI_PRIVATE_KEY (401 on ${method} ${path}). The key is wrong, revoked, or ` +
        "this is the public key instead of the private one -- get a fresh private key from the " +
        "Vapi dashboard's API Keys page and update .env.local.",
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

/** "The assistant for this location" -- see the module header for why
 *  metadata, not name, is the key. GET /assistant has no server-side
 *  filter for metadata, so this walks pages (newest first) comparing
 *  client-side; almost every account this runs against has a handful of
 *  assistants, not thousands, so one page is the common case. */
async function findExistingAssistant() {
  let cursor;
  for (let page = 0; page < 50; page++) {
    const qs = new URLSearchParams({ limit: "1000" });
    if (cursor) qs.set("createdAtLt", cursor);
    const list = await vapiRequest("GET", `/assistant?${qs}`);
    const match = list.find((a) => a?.metadata?.dialtone_location_id === locationId);
    if (match) return match;
    if (list.length < 1000) return null;
    cursor = list[list.length - 1]?.createdAt;
    if (!cursor) return null;
  }
  throw new ProvisioningError(
    "Walked 50,000 assistants without finding a match or reaching the end of the list -- " +
      "something is wrong with pagination here. Check the Vapi dashboard by hand.",
  );
}

// ── output helpers ──────────────────────────────────────────────────

/** Never print the secret or the Vapi key -- including inside a
 *  --dry-run payload dump, which otherwise contains the real
 *  x-dialtone-secret in every tool's server.headers. */
function redactSecrets(value) {
  const clone = JSON.parse(JSON.stringify(value));
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      for (const key of Object.keys(node)) {
        if (key.toLowerCase() === "x-dialtone-secret") node[key] = "<redacted>";
        else walk(node[key]);
      }
    }
  };
  walk(clone);
  return clone;
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  console.error(`Fetching assistant config from ${base}/api/agent/assistant ...`);
  const config = await fetchAssistantConfig();

  // The kill switch, or "not live", is a deliberate decision that calls
  // to this location must not reach the AI. Provisioning an assistant
  // anyway and pointing Vapi at it would give Vapi a working assistant
  // to dial regardless of what this app's own switch says -- defeating
  // the switch, not merely leaving it unused.
  if (!config.assistant_enabled) {
    console.error("");
    console.error(`Refusing to provision: this location's assistant is not enabled.`);
    console.error(
      `disabled_reason: ${config.disabled_reason} (${
        config.disabled_reason === "kill_switch"
          ? "the kill switch is on for this location"
          : "this location is not marked live"
      })`,
    );
    console.error(
      `Its calls should already be going to the fallback number instead: ${config.fallback_number ?? "(none configured)"}.`,
    );
    console.error("Flip the switch (or mark the location live) before running this again.");
    process.exit(1);
  }

  // transfer_to_human fails outright without this (see
  // app/api/agent/transfer/route.ts), and this script cannot set a
  // transfer destination on the assistant without one either.
  if (!config.fallback_number) {
    console.error("");
    console.error(
      "Refusing to provision: this location has no fallback_human_number configured. " +
        "transfer_to_human -- the escape hatch for allergies and catering orders, the only two " +
        "things that still reach a person -- would fail outright, and this assistant's transfer " +
        "destination has nowhere to point. " +
        "Set locations.fallback_human_number for this location first.",
    );
    process.exit(1);
  }

  console.error(`Greeting: ${JSON.stringify(config.greeting)}`);
  console.error(`Fallback number: ${config.fallback_number}`);
  console.error(`System prompt: ${config.system_prompt.length} characters`);
  console.error(`Config assembled_at=${config.assembled_at} expires_at=${config.expires_at}`);

  const payload = buildAssistantPayload(config);

  if (dryRun) {
    console.log("");
    console.log("--dry-run: not calling Vapi. This is the assistant payload that would be sent:");
    console.log(JSON.stringify(redactSecrets(payload), null, 2));
    console.log("");
    console.log(
      "(--dry-run does not check Vapi for an existing assistant to update, since it makes no " +
        "Vapi calls at all -- a real run would PATCH one if metadata.dialtone_location_id " +
        `"${locationId}" already matches an assistant, or POST a new one otherwise.)`,
    );
    return;
  }

  const existing = await findExistingAssistant();
  let assistant;
  if (existing) {
    console.error(
      `Found existing assistant ${existing.id} for location ${locationId} ` +
        "(matched on metadata.dialtone_location_id) -- updating it in place.",
    );
    assistant = await vapiRequest("PATCH", `/assistant/${existing.id}`, payload);
    console.log(`Updated assistant ${assistant.id}.`);
  } else {
    console.error(`No existing assistant found for location ${locationId} -- creating one.`);
    assistant = await vapiRequest("POST", "/assistant", payload);
    console.log(`Created assistant ${assistant.id}.`);
  }

  console.log("");
  console.log("Tools registered (inline on the assistant, fully replaced on every run):");
  for (const tool of TOOLS) console.log(`  - ${tool.name} -> ${base}/api/agent/${tool.path}`);
  console.log(`  - (native transferCall, static destination) -> ${config.fallback_number}`);
  console.log("");
  console.log(`Model: ${modelProvider}/${modelName}, temperature 0.3`);
  console.log(`First message: greeting fetched above, spoken verbatim (not model-generated)`);
  console.log("");
  console.log("Put this in VAPI_ASSISTANT_ID:");
  console.log(assistant.id);
}

main().catch((err) => {
  if (err instanceof ProvisioningError || err instanceof UsageError) {
    console.error("failed:", err.message);
    process.exit(1);
  }
  throw err;
});
