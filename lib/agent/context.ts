import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";

/** The call row this tool call belongs to, if we can tell.
 *
 *  Scoped by location as well as provider id: the provider id arrives in
 *  a request body, and a body value must never be able to attach a
 *  booking or an order to another restaurant's call. */
export async function callIdForProvider(
  locationId: string,
  // `string | null` since the id now comes from `message.call.id` via
  // parseToolCall, which reports "could not tell" as null. The body
  // already opened with `if (!providerCallId) return null`, so this was
  // correct at runtime all along; only the annotation was wrong.
  providerCallId: string | null | undefined,
) {
  if (!providerCallId) return null;

  const { data, error } = await supabaseAdmin()
    .from("calls")
    .select("id")
    .eq("location_id", locationId)
    .eq("provider_call_id", providerCallId)
    .maybeSingle();

  if (error) {
    // `provider_call_id` is a request-body value, so it is part of this
    // query's filter and can come back inside a PostgrestError's message
    // or details. Only the location and the SQLSTATE are written down,
    // the same as every other agent path.
    console.error("[agent] call lookup failed", {
      location_id: locationId,
      code: error.code,
    });
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}
