import "server-only";

import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { hashAgentSecret } from "@/lib/agent/auth";
import { buildGreeting, buildSystemPrompt } from "@/lib/agent/prompt";
import { openState, type HoursRow } from "@/lib/agent/hours";
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
  hours,
  base,
  vapiKey,
  now = new Date(),
}: {
  location: LocationRow;
  hours: HoursRow[];
  /** Origin of this deployment, no trailing slash. Every tool's
   *  `server.url` is built from it. */
  base: string;
  vapiKey: string;
  now?: Date;
}): Promise<{ secret: string; assistantId: string }> {
  if (!location.fallback_human_number) {
    throw new Error(
      "This location has no fallback number, so its assistant has nowhere to transfer a " +
        "catering or allergy call. Set one before provisioning.",
    );
  }

  const state = openState({ now, timezone: location.timezone, hours, holidays: [] });

  const secret = crypto.randomBytes(32).toString("base64url");

  const payload = buildAssistantPayload({
    locationId: location.id,
    base,
    agentSecret: secret,
    config: {
      system_prompt: buildSystemPrompt({ location, hoursToday: state.today, now }),
      greeting: buildGreeting(location),
      fallback_number: location.fallback_human_number,
    },
  });

  // Throws ProvisioningError on any Vapi failure. Deliberately not
  // caught here: nothing has been written yet, so the caller's own
  // rollback has strictly less to undo the earlier this escapes.
  const { assistant } = await upsertAssistant({ vapiKey, locationId: location.id, payload });

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
    );
  }

  return { secret, assistantId: assistant.id };
}

/** Thrown when Vapi accepted the assistant but the hash write did not
 *  land. Carries the assistant id so the caller can clean it up. */
export class AssistantSecretWriteError extends Error {
  constructor(
    message: string,
    readonly assistantId: string,
  ) {
    super(message);
  }
}
