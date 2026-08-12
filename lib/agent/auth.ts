import "server-only";

import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { LocationRow } from "@/lib/supabase/types";

const HEADER = "x-dialtone-secret";

/** Stored as a hash so a database dump does not yield working keys. */
export function hashAgentSecret(secret: string) {
  return crypto.createHash("sha256").update(secret, "utf-8").digest("hex");
}

export function agentSecretFromRequest(request: Request) {
  return request.headers.get(HEADER);
}

/** The location this secret belongs to, or null.
 *
 *  The secret is the ONLY thing that decides which restaurant a tool call
 *  can touch. A location_id in the request body is never trusted: the
 *  agent is one shared process serving every restaurant, so a body value
 *  would let a confused or hostile call reach another tenant's menu.
 *
 *  A location that has never configured a secret has agent_secret_hash =
 *  NULL -- every location does today, since that column shipped with no
 *  backfill (Task 2). Such a location must never be matched. `.eq()`
 *  alone already excludes it -- SQL equality against NULL is never true,
 *  so `.eq("agent_secret_hash", hashAgentSecret(secret))` never selects a
 *  NULL row -- but that guarantee is easy to lose by accident: PostgREST
 *  reads a literal `null` comparison value as `column IS NULL`, so a
 *  future refactor that lets `null` reach `.eq()` (e.g. the `if (!secret)`
 *  guard below being removed or reordered) would silently start matching
 *  every unconfigured location instead of none. `.not(..., "is", null)`
 *  makes the exclusion explicit and independent of that guard. */
export async function locationForSecret(secret: string | null) {
  if (!secret) return null;

  const { data, error } = await supabaseAdmin()
    .from("locations")
    .select("*")
    .not("agent_secret_hash", "is", null)
    .eq("agent_secret_hash", hashAgentSecret(secret))
    .maybeSingle();

  if (error) {
    // The SQLSTATE only. This query's filter value is the SHA-256 of a
    // live tool secret: an error that echoes the failing condition back
    // would write that hash into the application log, and there is no
    // reason for it to be there. There is no location to name yet --
    // resolving one is what just failed.
    console.error("[agent] secret lookup failed", { code: error.code });
    return null;
  }
  return (data as LocationRow) ?? null;
}
