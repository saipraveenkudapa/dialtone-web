import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import {
  isRequestInPast,
  nearestOpenTimes,
  seatsTaken,
  MAX_ALTERNATIVE_OFFSET_MINUTES,
} from "@/lib/agent/availability";
import { openAt, type HolidayRow, type HoursRow } from "@/lib/agent/hours";

/** check_availability. The agent must call this before promising a time.
 *  It answers from real bookings and the location's real hours, never
 *  from a guess -- and that now includes the alternatives it offers.
 *
 *  The alternatives used to be arithmetic: the requested time plus and
 *  minus thirty minutes, with nothing checked about either. The prompt
 *  calls them "the nearest open times", so the agent read them out as
 *  such, and a caller at 6:45 PM asking about 7:10 was offered 6:40 PM --
 *  which create_reservation then refused as already past. The same
 *  arithmetic would happily offer a time the restaurant is closed at, or
 *  one with no seats left. Every candidate now goes through the same
 *  three tests the requested time does, using the same peak-occupancy
 *  sweep (`seatsTaken`) and the same hours logic (`openAt`) rather than a
 *  second opinion about either. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const body = (await request.json().catch(() => ({}))) as {
    requested_at?: string;
    party_size?: number;
  };

  const when = body.requested_at ? new Date(body.requested_at) : null;
  const party = Number(body.party_size ?? 0);
  const now = new Date();

  if (!when || Number.isNaN(when.getTime())) {
    return agentFail("I didn't catch the date and time for that.");
  }
  if (isRequestInPast(when, now)) {
    return agentFail("That time has already passed.");
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

  // Wide enough to cover every candidate alternative, not just the
  // requested slot: an alternative 90 minutes out competes with bookings
  // a further slot beyond that, and a booking this query never returned
  // is a booking the occupancy sweep silently treats as absent -- which
  // would offer a time that is actually full.
  const reach = (slot + MAX_ALTERNATIVE_OFFSET_MINUTES) * 60_000;
  const windowStart = new Date(when.getTime() - reach).toISOString();
  const windowEnd = new Date(when.getTime() + reach).toISOString();

  const supabase = supabaseAdmin();
  const [bookings, hours, holidays] = await Promise.all([
    supabase
      .from("bookings")
      .select("requested_at, party_size")
      .eq("location_id", location.id)
      .in("status", ["requested", "confirmed", "seated"])
      .gte("requested_at", windowStart)
      .lte("requested_at", windowEnd),
    supabase.from("hours").select("*").eq("location_id", location.id),
    supabase.from("holiday_hours").select("*").eq("location_id", location.id),
  ]);

  if (bookings.error || hours.error || holidays.error) {
    // The SQLSTATE and the location, nothing else: `requested_at` comes
    // from the request body, so a PostgrestError raised over this query
    // can carry a caller-supplied value in its message or details.
    console.error("[agent] availability read failed", {
      location_id: location.id,
      code: (bookings.error ?? hours.error ?? holidays.error)?.code ?? null,
    });
    return agentFail("I can't check the book right now.", 500);
  }

  const booked = bookings.data ?? [];
  const hoursRows = (hours.data ?? []) as HoursRow[];
  const holidayRows = (holidays.data ?? []) as HolidayRow[];

  const fits = (at: Date) => seatsTaken(booked, at, slot) + party <= location.seats;
  const verdictFor = (at: Date) =>
    openAt({ at, timezone: location.timezone, hours: hoursRows, holidays: holidayRows });

  // Everything an alternative has to survive before it can be spoken: it
  // has to be a real moment in the future, at a time this restaurant is
  // open, with seats for this party. An `unknown` hours verdict (hours
  // that cross midnight, or none configured at all -- see openAt) is let
  // through rather than treated as closed, for the reason that function
  // documents: refusing everything because the hours cannot be
  // represented is a worse failure than the one this check prevents.
  const isOffered = (candidate: Date) =>
    !isRequestInPast(candidate, now) &&
    verdictFor(candidate).state !== "closed" &&
    fits(candidate);

  const alternatives = () =>
    nearestOpenTimes({ slotStart: when, timezone: location.timezone, isOffered, count: 2 });

  const requestedVerdict = verdictFor(when);
  if (requestedVerdict.state === "closed") {
    return agentOk({
      available: false,
      reason: "closed",
      hours_that_day: requestedVerdict.hoursThatDay,
      // Still offered: "we're closed at four, but we could do five" is a
      // saved booking, and every candidate has been through the same
      // hours check that just refused this one.
      alternatives: alternatives(),
    });
  }

  const available = fits(when);

  return agentOk({
    available,
    alternatives: available ? [] : alternatives(),
  });
}
