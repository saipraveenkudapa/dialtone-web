import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { nearestTimes, seatsTaken } from "@/lib/agent/availability";

/** check_availability. The agent must call this before promising a time.
 *  It answers from real bookings, never from a guess. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const body = (await request.json().catch(() => ({}))) as {
    requested_at?: string;
    party_size?: number;
  };

  const when = body.requested_at ? new Date(body.requested_at) : null;
  const party = Number(body.party_size ?? 0);

  if (!when || Number.isNaN(when.getTime())) {
    return agentFail("I didn't catch the date and time for that.");
  }
  if (!Number.isInteger(party) || party < 1) {
    return agentFail("I didn't catch how many people.");
  }
  if (party > location.max_party_size) {
    return agentOk({
      available: false,
      reason: "large_party",
      alternatives: [],
    });
  }

  const slot = location.reservation_slot_minutes;
  const windowStart = new Date(when.getTime() - slot * 60_000).toISOString();
  const windowEnd = new Date(when.getTime() + slot * 60_000).toISOString();

  const { data, error } = await supabaseAdmin()
    .from("bookings")
    .select("requested_at, party_size")
    .eq("location_id", location.id)
    .in("status", ["requested", "confirmed", "seated"])
    .gte("requested_at", windowStart)
    .lte("requested_at", windowEnd);

  if (error) {
    console.error("[agent] availability read failed", error);
    return agentFail("I can't check the book right now.", 500);
  }

  const taken = seatsTaken(data ?? [], when, slot);
  const available = taken + party <= location.seats;

  return agentOk({
    available,
    alternatives: available ? [] : nearestTimes(when, location.timezone, 2),
  });
}
