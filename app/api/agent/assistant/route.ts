import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { openState, type HolidayRow, type HoursRow } from "@/lib/agent/hours";
import { buildGreeting, buildSystemPrompt } from "@/lib/agent/prompt";

/** The assistant's configuration for this restaurant, assembled fresh so
 *  the date, the hours and the greeting are never stale.
 *
 *  `kill_switch_on` rides along in the response, but this route cannot
 *  itself act on it -- it only assembles config, it does not hold the
 *  call. Whatever wires this location's calls to the voice platform is
 *  responsible for treating a `true` value the same way
 *  `app/api/twilio/voice/route.ts` treats it: skip the assistant
 *  entirely and send the caller straight to `fallback_number`, no
 *  greeting, no delay. The owner flipped the switch because something
 *  is wrong; a caller must never reach the AI while it is on. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const supabase = supabaseAdmin();
  const [hours, holidays] = await Promise.all([
    supabase.from("hours").select("*").eq("location_id", location.id),
    supabase.from("holiday_hours").select("*").eq("location_id", location.id),
  ]);

  if (hours.error || holidays.error) {
    console.error("[agent] hours read failed", hours.error ?? holidays.error);
    return agentFail("I can't put the assistant together right now.", 500);
  }

  const state = openState({
    now: new Date(),
    timezone: location.timezone,
    hours: (hours.data ?? []) as HoursRow[],
    holidays: (holidays.data ?? []) as HolidayRow[],
  });

  return agentOk({
    system_prompt: buildSystemPrompt({
      location,
      hoursToday: state.today,
      now: new Date(),
    }),
    greeting: buildGreeting(location),
    fallback_number: location.fallback_human_number,
    kill_switch_on: location.kill_switch_on,
  });
}
