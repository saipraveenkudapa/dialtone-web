import "server-only";

import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { dialableNumber } from "@/lib/phone";
import { hashAgentSecret } from "@/lib/agent/auth";
import { buildGreeting, buildSystemPrompt } from "@/lib/agent/prompt";
import { type HoursRow } from "@/lib/agent/hours";
import { buildAssistantPayload, upsertAssistant } from "@/lib/vapi/provision";
import type { LocationRow } from "@/lib/supabase/types";

/** Mint this location's tool secret and create (or update) its Vapi
 *  assistant. The single implementation of "make this location's phone
 *  agent real" -- this is app/onboarding's old finish step, moved rather
 *  than rewritten, and it still rests on the same one copy of the Vapi
 *  payload/upsert logic in lib/vapi/provision.ts that
 *  scripts/provision-vapi.mjs shares.
 *
 *  Ordering matters, and it is the ordering the onboarding finish step
 *  used, for the reason it gave: the Vapi call happens BEFORE
 *  agent_secret_hash is written, never after. If Vapi fails, nothing has
 *  been persisted -- no half-set secret, no orphaned hash whose
 *  plaintext nobody holds -- and the caller can retry from a clean
 *  state. Writing the hash first and the assistant second risks the
 *  opposite: a saved hash for a secret that never reached any tool's
 *  headers, silently 401-ing every call forever until somebody notices.
 *
 *  Runs with the service role because the operator creating this
 *  restaurant is deliberately not a member of it -- no RLS policy admits
 *  them, and none should. Every caller must have already established
 *  that the caller is a platform admin; see
 *  lib/provisioning/create-restaurant.ts, which is the only one.
 *
 *  The returned secret is the ONLY copy. It is never logged and never
 *  written to a column -- only its SHA-256 hash is, exactly the digest
 *  lib/agent/auth.ts's locationForSecret matches a tool call against. */
export async function provisionAssistantForLocation({
  location,
  base,
  vapiKey,
}: {
  location: LocationRow;
  /** Not read any more, and deliberately still accepted.
   *
   *  The system prompt used to carry one day's hours as text; it now
   *  tells the agent to call `get_hours` instead, so there is nothing
   *  left here to bake in. Each of this function's three callers
   *  (create-restaurant, the operator's edit-screen rebuild, go-live)
   *  reads these rows from Postgres itself and has its own tested
   *  "could not read this restaurant's hours" branch around that read.
   *  Dropping the parameter would make those reads dead and pull four
   *  more files, plus their error paths, into a change about a stale
   *  date -- so the parameter stays and the value is ignored. */
  hours: HoursRow[];
  /** Origin of this deployment, no trailing slash. Every tool's
   *  `server.url` is built from it. */
  base: string;
  vapiKey: string;
}): Promise<{ secret: string; assistantId: string; created: boolean }> {
  /* DIALABLE, NOT MERELY PRESENT.
   *
   *  This guard tested the column for truthiness, and the payload two
   *  statements down is where `fallback_human_number` becomes the
   *  assistant's NATIVE transfer destination on Vapi -- baked in at
   *  build time and read by nothing afterwards. So a row holding "12",
   *  or a legacy "(510) 555-0199" written before setFallbackNumber
   *  normalized on the way in, walked through here and was pushed to
   *  Vapi, which either 400s the whole provisioning call ("must be a
   *  valid phone number in the E.164 format") or accepts a destination
   *  that fails at the one moment it is used. repairAssistant is the
   *  road an operator takes when something is already wrong; it must
   *  not be able to write a new wrong thing on the way past.
   *
   *  Refused rather than repaired. Normalizing here would make the
   *  number Vapi dials and the number the column holds two different
   *  strings, silently, on the screen whose whole job is to say what a
   *  restaurant will do -- and app/api/twilio/voice would still dial the
   *  column verbatim. The go-live checklist already names this exact
   *  state and the repair is one press by a human. */
  const fallback = dialableNumber(location.fallback_human_number);
  if (!fallback) {
    throw new Error(
      location.fallback_human_number
        ? `This location's fallback number, ${location.fallback_human_number}, is not in the ` +
            "shape Vapi and Twilio dial, so its assistant would be built with a transfer " +
            "destination that fails at the moment a caller needs it. Save the number again " +
            "before provisioning."
        : "This location has no fallback number, so its assistant has nowhere to transfer a " +
            "catering or allergy call. Set one before provisioning.",
    );
  }

  const secret = crypto.randomBytes(32).toString("base64url");

  const payload = buildAssistantPayload({
    locationId: location.id,
    base,
    agentSecret: secret,
    config: {
      system_prompt: buildSystemPrompt({ location }),
      greeting: buildGreeting(location),
      fallback_number: fallback,
    },
  });

  // Throws ProvisioningError on any Vapi failure. Deliberately not
  // caught here: nothing has been written yet, so the caller's own
  // rollback has strictly less to undo the earlier this escapes.
  const { assistant, created } = await upsertAssistant({ vapiKey, locationId: location.id, payload });

  const { error } = await supabaseAdmin()
    .from("locations")
    .update({ agent_secret_hash: hashAgentSecret(secret), vapi_assistant_id: assistant.id })
    .eq("id", location.id);

  if (error) {
    // The assistant now exists on Vapi carrying a secret whose hash was
    // never saved, so every one of its tool calls would 401. Surfacing
    // the assistant id lets the caller delete it as part of rolling the
    // whole restaurant back, rather than leaving it orphaned.
    console.error("[provisioning] could not save the tool secret hash", { code: error.code });
    throw new AssistantSecretWriteError(
      "The AI assistant was created, but saving its secret failed.",
      assistant.id,
      created,
    );
  }

  return { secret, assistantId: assistant.id, created };
}

/** Thrown when Vapi accepted the assistant but the hash write did not
 *  land. Carries the assistant id so the caller can clean it up.
 *
 *  `created` is what makes cleaning it up safe. upsertAssistant PATCHes
 *  an assistant Vapi already has tagged for this location and only POSTs
 *  a new one when there is none -- so a caller that deletes on this
 *  error without reading this flag can take a restaurant that is
 *  answering calls off the air to tidy up a failed write. */
export class AssistantSecretWriteError extends Error {
  constructor(
    message: string,
    readonly assistantId: string,
    readonly created: boolean = true,
  ) {
    super(message);
  }
}
