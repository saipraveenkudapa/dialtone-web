#!/usr/bin/env node
/* Generate a tool secret for one location and store only its hash.
   The plaintext is printed once, here, and never persisted by us.

   Re-running this against a location that already has a secret
   overwrites it immediately: any caller still presenting the old
   secret starts failing auth on its very next tool call, with no grace
   period. That is by design -- provisioning and rotation are the same
   operator-run action, and a leaked old secret must stop working the
   moment a new one is set. This script warns before overwriting, but
   does not block it, so the same command works unattended for both
   first-time setup and rotation.

   node scripts/set-agent-secret.mjs <location-id>
*/
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const locationId = process.argv[2];
if (!locationId) {
  console.error("usage: node scripts/set-agent-secret.mjs <location-id>");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data: existing, error: lookupError } = await supabase
  .from("locations")
  .select("agent_secret_hash")
  .eq("id", locationId)
  .maybeSingle();

if (lookupError) {
  console.error("failed:", lookupError.message);
  process.exit(1);
}

if (!existing) {
  console.error("failed: no location with id", locationId);
  process.exit(1);
}

if (existing.agent_secret_hash) {
  console.error(
    "warning: location",
    locationId,
    "already has a secret configured -- overwriting it invalidates the",
    "old one immediately. Any live caller still using it will start",
    "failing auth on its next tool call.",
  );
}

const secret = crypto.randomBytes(32).toString("base64url");
const hash = crypto.createHash("sha256").update(secret, "utf-8").digest("hex");

const { error } = await supabase
  .from("locations")
  .update({ agent_secret_hash: hash })
  .eq("id", locationId);

if (error) {
  console.error("failed:", error.message);
  process.exit(1);
}

console.log("Secret for location", locationId);
console.log(secret);
console.log("\nPut this in the Vapi tool headers as x-dialtone-secret.");
console.log("It is not stored anywhere else. Losing it means generating a new one.");
