import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { buildGreeting, buildSystemPrompt } from "@/lib/agent/prompt";

// How long a consumer may treat a response as fresh. Short on purpose:
// this config is cheap to re-fetch and the whole point of
// `assembled_at`/`expires_at` is to make staleness detectable, not to
// bless a long hold.
const CONFIG_TTL_MS = 5 * 60 * 1000;

/** The assistant's configuration for this restaurant.
 *
 *  NOT a Vapi tool, and deliberately not on lib/agent/respond.ts. It has
 *  no entry in AGENT_TOOLS; it is fetched over plain HTTP by
 *  scripts/provision-vapi.mjs, which asserts `!res.ok || !json?.ok` and
 *  then reads `config.assistant_enabled` / `config.system_prompt`.
 *  Wrapping this in `{results:[{result:"..."}]}` would break provisioning
 *  for every new restaurant, and answering 200 on a bad secret would
 *  break that script's explicit 401 message. So the four returns below
 *  are inlined rather than shared: `respond.ts` is the Vapi tool
 *  envelope, full stop.
 *
 *  `system_prompt` no longer has the date or today's hours baked into
 *  its text. The date is a Liquid template Vapi renders at the start of
 *  every call, and the hours line points at `get_hours` -- so a copy of
 *  this response held overnight no longer recites yesterday's date or a
 *  stale day's hours, which is what used to make a reservation land on
 *  the wrong day. `assembled_at` / `expires_at` still ride along: this
 *  response also carries `greeting`, `fallback_number`, `kill_switch_on`
 *  and `is_live`, all of which an owner can change at any moment, so a
 *  consumer still needs to be able to tell how old a copy it is holding
 *  is.
 *
 *  `kill_switch_on` / `is_live` are enforced here, not just reported:
 *  when either says the assistant should not run, `assistant_enabled`
 *  is `false` and `system_prompt` / `greeting` come back `null` rather
 *  than usable text, so a caller cannot accidentally hand a live caller
 *  a working config for a location whose owner switched the agent off.
 *  `fallback_number` still rides along either way so the platform can
 *  route to a human.
 *
 *  That is a PROVISIONING guard, not the call-time one, and the two must
 *  not be confused: scripts/provision-vapi.mjs refuses to build an
 *  assistant for a disabled location because of these fields, but no
 *  caller ever reaches this route. The kill switch is enforced on the
 *  call path by app/api/vapi/webhook/route.ts, which answers Vapi's
 *  `assistant-request` with a transfer to a person instead of an
 *  assistant id. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return Response.json({ ok: false, error: "Not authorised" }, { status: 401 });

  // Fail closed. A caller must never reach the AI while the switch is on
  // or the location isn't live, so this is checked before anything else
  // is assembled -- there is no code path below this that can produce a
  // usable system_prompt for a disabled location.
  if (location.kill_switch_on || !location.is_live) {
    return Response.json({
      ok: true,
      assistant_enabled: false,
      disabled_reason: location.kill_switch_on ? "kill_switch" : "not_live",
      system_prompt: null,
      greeting: null,
      fallback_number: location.fallback_human_number,
      kill_switch_on: location.kill_switch_on,
      is_live: location.is_live,
    });
  }

  // The `hours` / `holiday_hours` read and the `openState()` call that
  // used to sit here fed exactly one thing: the day's hours, baked into
  // the prompt text. The prompt now points the agent at `get_hours`
  // instead of carrying a value that is wrong on every other weekday and
  // cannot honour a holiday override, so there is nothing left for them
  // to compute -- and this route no longer has a database read that can
  // fail between a caller ringing and an assistant existing.
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CONFIG_TTL_MS);

  return Response.json({
    ok: true,
    assistant_enabled: true,
    system_prompt: buildSystemPrompt({ location }),
    greeting: buildGreeting(location),
    fallback_number: location.fallback_human_number,
    kill_switch_on: location.kill_switch_on,
    is_live: location.is_live,
    assembled_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  });
}
