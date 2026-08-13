import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import type { HoursRow } from "@/lib/agent/hours";
import type { LocationRow } from "@/lib/supabase/types";

/** The org the signed-in user belongs to. Every account has exactly one
 *  today -- create_organization
 *  (supabase/migrations/20260812001000_signup_create_organization.sql)
 *  only ever makes one per user, and there is nowhere in the product yet
 *  that joins a second. Reads through the user's own session, same as
 *  everything else here -- RLS (membership_read_own) is what makes this
 *  safe to call with no extra filter. */
export async function getOwnOrgId(): Promise<string | null> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("memberships")
    .select("org_id")
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data?.org_id ?? null;
}

export async function getOwnOrgName(): Promise<string | null> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("organizations")
    .select("name")
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data?.name ?? null;
}

/** The location this account is onboarding, or has already onboarded.
 *
 *  Ordered by created_at rather than lib/data.ts's getCurrentLocation
 *  (which orders by name, for the dashboard's "pick something to show"
 *  need): onboarding cares about "the one row this account has ever
 *  created," which is unambiguous the moment it exists, and
 *  most-recently-created is the closest a query can get to that without
 *  a second signal. RLS (location_read) already limits this to the
 *  signed-in user's own organizations. */
export async function getOnboardingLocation(): Promise<LocationRow | null> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("locations")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as LocationRow | null;
}

/** This location's weekly hours, one row per configured day. A day with
 *  no row is closed -- see lib/agent/hours.ts's own header -- so a
 *  freshly created location legitimately reads back as `[]` until the
 *  hours step saves something. */
export async function getOnboardingHours(locationId: string): Promise<HoursRow[]> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("hours")
    .select("day_of_week, open_time, close_time, is_closed")
    .eq("location_id", locationId)
    .order("day_of_week");

  if (error) throw error;
  return (data ?? []) as HoursRow[];
}
