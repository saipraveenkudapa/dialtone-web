import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { openState, type HolidayRow, type HoursRow } from "@/lib/agent/hours";
import { buildGreeting, buildSystemPrompt } from "@/lib/agent/prompt";

// How long a consumer may treat a response as fresh. Short on purpose:
// this config is cheap to re-fetch and the whole point of
// `assembled_at`/`expires_at` is to make staleness detectable, not to
// bless a long hold.
const CONFIG_TTL_MS = 5 * 60 * 1000;

/** The assistant's configuration for this restaurant.
 *
 *  Callers of this route MUST fetch it fresh for every call, never cache
 *  or store the response. `system_prompt` has the date and today's hours
 *  baked into its text at the instant this responds (see `assembled_at`
 *  below) -- a copy held from an earlier call recites a stale day's
 *  hours as today's and, worse, resolves words like "tomorrow" or
 *  "Friday" against the wrong date, so a reservation lands on the wrong
 *  day or gets rejected as already past. `assembled_at` and
 *  `expires_at` let a consumer detect a copy it is holding onto for too
 *  long; they cannot force a platform that caches this call to fetch it
 *  again -- that wiring is this route's caller's job, tracked
 *  separately.
 *
 *  `kill_switch_on` / `is_live` are enforced here, not just reported:
 *  when either says the assistant should not run, `assistant_enabled`
 *  is `false` and `system_prompt` / `greeting` come back `null` rather
 *  than usable text, so a caller cannot accidentally hand a live caller
 *  a working config for a location whose owner switched the agent off.
 *  `fallback_number` still rides along either way so the platform can
 *  route to a human. Whatever wires this location to the voice platform
 *  must check `assistant_enabled` before using anything else in this
 *  response, the same way `app/api/twilio/voice/route.ts` checks
 *  `kill_switch_on || !is_live` before ever dialing the assistant. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  // Fail closed. A caller must never reach the AI while the switch is on
  // or the location isn't live, so this is checked before anything else
  // is assembled -- there is no code path below this that can produce a
  // usable system_prompt for a disabled location.
  if (location.kill_switch_on || !location.is_live) {
    return agentOk({
      assistant_enabled: false,
      disabled_reason: location.kill_switch_on ? "kill_switch" : "not_live",
      system_prompt: null,
      greeting: null,
      fallback_number: location.fallback_human_number,
      kill_switch_on: location.kill_switch_on,
      is_live: location.is_live,
    });
  }

  const supabase = supabaseAdmin();
  const [hours, holidays] = await Promise.all([
    supabase.from("hours").select("*").eq("location_id", location.id),
    supabase.from("holiday_hours").select("*").eq("location_id", location.id),
  ]);

  if (hours.error || holidays.error) {
    console.error("[agent] hours read failed", {
      location_id: location.id,
      code: (hours.error ?? holidays.error)?.code ?? null,
    });
    return agentFail("I can't put the assistant together right now.", 500);
  }

  // One instant for both the open/closed calculation and the prompt's
  // own date text, so they cannot straddle a day or DST boundary and
  // disagree with each other mid-assembly.
  const now = new Date();

  const state = openState({
    now,
    timezone: location.timezone,
    hours: (hours.data ?? []) as HoursRow[],
    holidays: (holidays.data ?? []) as HolidayRow[],
  });

  const expiresAt = new Date(now.getTime() + CONFIG_TTL_MS);

  return agentOk({
    assistant_enabled: true,
    system_prompt: buildSystemPrompt({
      location,
      hoursToday: state.today,
      now,
    }),
    greeting: buildGreeting(location),
    fallback_number: location.fallback_human_number,
    kill_switch_on: location.kill_switch_on,
    is_live: location.is_live,
    assembled_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  });
}
