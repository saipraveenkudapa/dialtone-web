import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";

/** The call row this tool call belongs to, if we can tell.
 *
 *  Scoped by location as well as provider id: the provider id arrives in
 *  a request body, and a body value must never be able to attach a
 *  booking or an order to another restaurant's call. */
export async function callIdForProvider(
  locationId: string,
  providerCallId: string | undefined,
) {
  if (!providerCallId) return null;

  const { data, error } = await supabaseAdmin()
    .from("calls")
    .select("id")
    .eq("location_id", locationId)
    .eq("provider_call_id", providerCallId)
    .maybeSingle();

  if (error) {
    console.error("[agent] call lookup failed", error);
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}
