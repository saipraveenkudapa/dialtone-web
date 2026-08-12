import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { callIdForProvider } from "@/lib/agent/context";
import { isRequestInPast, seatsTaken } from "@/lib/agent/availability";

/** create_reservation. Re-checks capacity at write time: the caller has
 *  been talking for a minute or two since check_availability, and two
 *  callers can be booking the same table at once. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const body = (await request.json().catch(() => ({}))) as {
    requested_at?: string;
    party_size?: number;
    customer_name?: string;
    customer_phone?: string;
    provider_call_id?: string;
  };

  const when = body.requested_at ? new Date(body.requested_at) : null;
  const party = Number(body.party_size ?? 0);

  if (!when || Number.isNaN(when.getTime())) {
    return agentFail("I didn't catch the date and time.");
  }
  if (isRequestInPast(when, new Date())) {
    return agentFail("That time has already passed.");
  }
  if (!Number.isInteger(party) || party < 1 || party > location.max_party_size) {
    return agentFail("I didn't catch how many people.");
  }
  if (!body.customer_name || !body.customer_phone) {
    return agentFail("I still need a name and a number for the booking.");
  }

  const supabase = supabaseAdmin();
  const slot = location.reservation_slot_minutes;

  const { data: existing, error: readError } = await supabase
    .from("bookings")
    .select("requested_at, party_size")
    .eq("location_id", location.id)
    .in("status", ["requested", "confirmed", "seated"])
    .gte("requested_at", new Date(when.getTime() - slot * 60_000).toISOString())
    .lte("requested_at", new Date(when.getTime() + slot * 60_000).toISOString());

  if (readError) {
    console.error("[agent] reservation capacity check failed", readError);
    return agentFail("I can't get into the book right now.", 500);
  }

  if (seatsTaken(existing ?? [], when, slot) + party > location.seats) {
    return agentOk({ booked: false, reason: "full" });
  }

  const { data, error } = await supabase
    .from("bookings")
    .insert({
      location_id: location.id,
      call_id: await callIdForProvider(location.id, body.provider_call_id),
      customer_name: body.customer_name,
      customer_phone: body.customer_phone,
      party_size: party,
      requested_at: when.toISOString(),
      status: "confirmed",
    })
    .select("id")
    .single();

  if (error) {
    console.error("[agent] reservation insert failed", error);
    return agentFail("I couldn't get that booking in.", 500);
  }

  return agentOk({
    booked: true,
    booking_id: data.id,
    when: new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      timeZone: location.timezone,
    }).format(when),
  });
}
