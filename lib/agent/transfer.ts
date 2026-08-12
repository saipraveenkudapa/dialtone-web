import { supabaseAdmin } from "@/lib/supabase/admin";
import { callIdForProvider } from "@/lib/agent/context";
import { redactCardNumbers } from "@/lib/agent/redact";

const DEFAULT_REASON = "Agent handed off";
const MAX_REASON_LENGTH = 200;

/** What gets written to `calls` when a transfer happens.
 *
 *  Redaction runs before truncation, not after: cutting to 200 characters
 *  first can slice a card number in half at that boundary, leaving a
 *  partial run too short for `redactCardNumbers` to recognise -- scrub
 *  the whole reason while it is still whole, and there is nothing left
 *  to leak by the time it is cut down to size. */
export function buildTransferLogUpdate(reason: string | undefined) {
  return {
    transferred_to_human: true as const,
    transfer_reason: redactCardNumbers(reason ?? DEFAULT_REASON).slice(0, MAX_REASON_LENGTH),
    outcome: "transferred" as const,
  };
}

/** Writes the transfer outcome to `calls`, entirely best effort.
 *
 *  Meant to be called from `after()` in the route, once the transfer
 *  number has already gone back to the caller -- by that point nothing
 *  here may ever throw or reject, on pain of an unhandled rejection in a
 *  background task. A missing call id, a lookup failure, a constraint
 *  violation and a dropped connection all end the same way: a logged
 *  line, not a crash.
 *
 *  Only the SQLSTATE is logged on a Postgrest error, never the update
 *  payload or the raw error object -- a PostgrestError's `details` can
 *  carry Postgres' "Failing row contains (...)" text, which for this
 *  table means the caller's own words in `transfer_reason`. A log line
 *  is not the place for those any more than an unredacted column would
 *  be. */
export async function logTransferOutcome(
  locationId: string,
  providerCallId: string | undefined,
  reason: string | undefined,
) {
  try {
    const callId = await callIdForProvider(locationId, providerCallId);
    if (!callId) return;

    const { error } = await supabaseAdmin()
      .from("calls")
      .update(buildTransferLogUpdate(reason))
      .eq("id", callId);

    if (error) {
      console.error("[agent] transfer log update failed", {
        location_id: locationId,
        call_id: callId,
        code: error.code,
      });
    }
  } catch (err) {
    // A thrown error here is a network/connection-level failure (a
    // rejected fetch, a timeout), not a Postgrest response echoing row
    // data back -- unlike the `error.code`-only branch above, there is no
    // caller text to protect against logging this one directly.
    console.error("[agent] transfer log update threw", {
      location_id: locationId,
      err,
    });
  }
}
