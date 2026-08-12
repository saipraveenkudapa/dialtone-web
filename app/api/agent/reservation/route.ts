import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { callIdForProvider } from "@/lib/agent/context";
import { isRequestInPast } from "@/lib/agent/availability";

/** create_reservation.
 *
 *  The capacity decision is NOT made here. This used to select the
 *  overlapping bookings, add them up in JavaScript and then insert --
 *  two round trips with nothing holding the book still between them, so
 *  two callers after the same last table both read room and both wrote
 *  it. That re-check shrank the race; it could not close it, because the
 *  only place check-then-write can be made indivisible is inside a
 *  transaction. So the check and the insert are one call to
 *  `public.book_table` (supabase/migrations/20260812000200_book_table.sql),
 *  which serialises on the location and counts occupancy under that lock.
 *  Seats, slot length and max party size come from the location row
 *  inside the function, so nothing about capacity is decided from a
 *  request body.
 *
 *  What remains here is what the caller has to be told: the validation
 *  that produces a sentence a person can hear, and the wording of the
 *  answer. */
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

  const { data, error } = await supabaseAdmin()
    .rpc("book_table", {
      p_location_id: location.id,
      p_requested_at: when.toISOString(),
      p_party_size: party,
      p_customer_name: body.customer_name,
      p_customer_phone: body.customer_phone,
      p_call_id: await callIdForProvider(location.id, body.provider_call_id),
    })
    .single<{ booked: boolean; booking_id: string | null; reason: string | null }>();

  if (error || !data) {
    console.error("[agent] book_table failed", error);
    return agentFail("I couldn't get that booking in.", 500);
  }

  // A full house is an ordinary answer, not an error: the function says
  // so in `reason` rather than raising, and the agent offers another
  // time.
  if (!data.booked) {
    return agentOk({ booked: false, reason: data.reason ?? "full" });
  }

  return agentOk({
    booked: true,
    booking_id: data.booking_id,
    when: new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      hour: "numeric",
      minute: "2-digit",
      timeZone: location.timezone,
    }).format(when),
  });
}
