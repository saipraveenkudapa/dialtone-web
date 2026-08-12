#!/usr/bin/env node
/* Generate a tool secret for one location and store only its hash.
   The plaintext is printed once, here, and never persisted by us.

   Re-running this against a location that already has a secret
   overwrites it immediately: any caller still presenting the old
   secret starts failing auth on its very next tool call, with no grace
   period. That is by design -- provisioning and rotation are the same
   operator-run action, and a leaked old secret must stop working the
   moment a new one is set. Because there is no confirmation step, this
   script requires an explicit --force flag before it will replace an
   existing secret; first-time provisioning (no secret set yet) needs no
   flag.

   node scripts/set-agent-secret.mjs <location-id> [--force]
*/
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const args = process.argv.slice(2).filter((a) => a !== "--force");
const force = process.argv.slice(2).includes("--force");
const locationId = args[0];
if (!locationId) {
  console.error("usage: node scripts/set-agent-secret.mjs <location-id> [--force]");
  process.exit(1);
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const { data: existing, error: lookupError } = await supabase
  .from("locations")
  .select("name, agent_secret_hash")
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

console.error("Location:", existing.name, `(${locationId})`);

if (existing.agent_secret_hash && !force) {
  console.error(
    "refused: location",
    locationId,
    "already has a secret configured -- overwriting it invalidates the",
    "old one immediately. If this location is live, every in-flight or",
    "subsequent tool call using the old secret starts failing auth the",
    "instant the new hash is written, with no grace period.",
    "\nIf that is really what you want, re-run with --force.",
  );
  process.exit(1);
}

if (existing.agent_secret_hash && force) {
  console.error(
    "warning: overwriting the existing secret for location",
    locationId,
    "-- the old one stops working immediately.",
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
