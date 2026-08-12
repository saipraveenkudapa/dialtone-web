import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { openState, type HolidayRow, type HoursRow } from "@/lib/agent/hours";

/** get_hours. Asked whenever there is any question about being open. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const supabase = supabaseAdmin();
  const [hours, holidays] = await Promise.all([
    supabase.from("hours").select("*").eq("location_id", location.id),
    supabase.from("holiday_hours").select("*").eq("location_id", location.id),
  ]);

  if (hours.error || holidays.error) {
    // Location and SQLSTATE only, the shape every agent path uses. This
    // particular query filters on nothing a caller supplied, so there is
    // no caller text for a PostgrestError to echo -- but one log shape
    // across every route is what keeps that true as routes change, rather
    // than something each one has to be re-audited for.
    console.error("[agent] hours read failed", {
      location_id: location.id,
      code: (hours.error ?? holidays.error)?.code ?? null,
    });
    return agentFail("I can't check the hours right now.", 500);
  }

  return agentOk(
    openState({
      now: new Date(),
      timezone: location.timezone,
      hours: (hours.data ?? []) as HoursRow[],
      holidays: (holidays.data ?? []) as HolidayRow[],
    }),
  );
}
