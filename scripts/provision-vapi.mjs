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

   The payload this script builds and the Vapi API calls it makes both
   live in lib/vapi/provision.ts now, shared with the operator's own
   "Create a new restaurant" action -- see that file's own header for why. This script keeps
   everything that is specific to being run by hand from a terminal: CLI
   argument parsing, the public-URL sanity check, and fetching the
   assistant config over HTTP from a deployed app/api/agent/assistant
   rather than assembling it in-process.

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

import {
  AGENT_TOOLS,
  ProvisioningError,
  buildAssistantPayload,
  upsertAssistant,
} from "../lib/vapi/provision.ts";

class UsageError extends Error {}

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
 *  This check is specific to this script being driven by a human typing
 *  a CLI argument -- see lib/vapi/provision.ts's header for why the
 *  operator's server action, which derives its base URL from the request
 *  itself rather than from something typed, does not repeat it.
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

  const payload = buildAssistantPayload({
    locationId,
    base,
    agentSecret,
    config: {
      system_prompt: config.system_prompt,
      greeting: config.greeting,
      fallback_number: config.fallback_number,
    },
    modelProvider,
    modelName,
  });

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

  const { assistant, created } = await upsertAssistant({ vapiKey, locationId, payload });
  if (created) {
    console.error(`No existing assistant found for location ${locationId} -- created one.`);
    console.log(`Created assistant ${assistant.id}.`);
  } else {
    console.error(
      `Found existing assistant ${assistant.id} for location ${locationId} ` +
        "(matched on metadata.dialtone_location_id) -- updated it in place.",
    );
    console.log(`Updated assistant ${assistant.id}.`);
  }

  console.log("");
  console.log("Tools registered (inline on the assistant, fully replaced on every run):");
  for (const tool of AGENT_TOOLS) console.log(`  - ${tool.name} -> ${base}/api/agent/${tool.path}`);
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
