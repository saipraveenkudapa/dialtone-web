import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { isRequestInPast } from "@/lib/agent/availability";
import { openAt, type HolidayRow, type HoursRow } from "@/lib/agent/hours";

/** What `public.change_booking` answers with. */
type ChangeBookingResult = {
  changed: boolean;
  already_changed: boolean;
  booking_id: string | null;
  booking_at: string | null;
  booking_party_size: number | null;
  reason: string | null;
};

/** Refusals the agent can say out loud. Anything else the function can
 *  return describes a request this route has already validated, so
 *  seeing one means the route and the function have drifted apart --
 *  logged and 500, not spoken. Same shape as the order route. */
const SPEAKABLE_REFUSALS = new Set(["not_found", "ambiguous", "full", "large_party"]);

/** change_reservation.
 *
 *  Moving a booking is a capacity question, not an edit. A naive update
 *  -- write the new time onto the row -- would let a caller move a table
 *  for six into a slot with two seats left, at three in the morning, on a
 *  day the restaurant is shut, and the book would simply accept it: none
 *  of the checks `create_reservation` makes live on the row.
 *
 *  So this endpoint asks exactly what create_reservation asks, in the
 *  same order and using the same code, and then hands the write to
 *  `public.change_booking`
 *  (supabase/migrations/20260812000800_cancel_change_reservation.sql):
 *
 *   - is the new time in the past?          isRequestInPast, here
 *   - is the party too big?                 location.max_party_size, here
 *                                           and again inside the function
 *   - is the restaurant open then?          openAt, here
 *   - are there seats?                      app.peak_occupancy, in the
 *                                           function, under the lock
 *
 *  Hours are checked here rather than in SQL for the same reason
 *  create_reservation checks them here: they live in two tables with a
 *  holiday override and a timezone, and lib/agent/hours.ts is where that
 *  reasoning already exists, tested. A second implementation in SQL
 *  would be a third copy of the same rules, and the first time they
 *  disagreed the agent and the database would refuse different moves.
 *
 *  Capacity is decided in SQL for the mirror-image reason: freeing the
 *  old slot and taking the new one has to be indivisible. The function
 *  serialises on the location -- the same advisory lock `book_table`
 *  takes, so a move cannot interleave with a booking -- counts occupancy
 *  at the new time with this booking excluded (otherwise a table would
 *  compete with itself for the seats it already holds), and releases and
 *  claims in one UPDATE. There is no instant, even inside that
 *  transaction, at which the caller has given up their table and not yet
 *  got the new one. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const body = (await request.json().catch(() => ({}))) as {
    booking_time?: string;
    new_requested_at?: string;
    new_party_size?: number;
    customer_name?: string;
    customer_phone?: string;
  };

  const when = body.booking_time ? new Date(body.booking_time) : null;
  const newWhen = body.new_requested_at ? new Date(body.new_requested_at) : null;
  const now = new Date();

  if (!when || Number.isNaN(when.getTime())) {
    return agentFail("I didn't catch when the booking is for now.");
  }
  if (!newWhen || Number.isNaN(newWhen.getTime())) {
    return agentFail("I didn't catch the new date and time.");
  }
  // Both ends have to be in the future, and they fail differently. A
  // past `booking_time` means the table they are asking about is already
  // gone; a past `new_requested_at` means the time they want to move it
  // to is. Two sentences, because a caller who hears the wrong one asks
  // the wrong follow-up question.
  if (isRequestInPast(when, now)) {
    return agentFail("That booking has already passed.");
  }
  if (isRequestInPast(newWhen, now)) {
    return agentFail("That time has already passed.");
  }
  if (!body.customer_name || !body.customer_phone) {
    return agentFail("I still need the name and number the booking's under.");
  }

  // Absent means "keep the party they already have": a caller moving
  // seven o'clock to eight should not have to say "two" again, and an
  // agent that re-asks for something the book already knows sounds like
  // it has forgotten the conversation. `change_booking` coalesces a null
  // to the booking's current size.
  const party =
    body.new_party_size === undefined || body.new_party_size === null
      ? null
      : Number(body.new_party_size);

  if (party !== null && (!Number.isInteger(party) || party < 1)) {
    return agentFail("I didn't catch how many people.");
  }
  // An ordinary answer with a reason the agent can speak, not a failure
  // to hear -- the same distinction create_reservation and
  // check_availability draw, and for the same reason: a caller who says
  // "twelve" and is asked again will say "twelve" again, and the loop
  // has no exit.
  if (party !== null && party > location.max_party_size) {
    return agentOk({ changed: false, reason: "large_party" });
  }

  const supabase = supabaseAdmin();
  const [hours, holidays] = await Promise.all([
    supabase.from("hours").select("*").eq("location_id", location.id),
    supabase.from("holiday_hours").select("*").eq("location_id", location.id),
  ]);

  if (hours.error || holidays.error) {
    console.error("[agent] hours read failed during change", {
      location_id: location.id,
      code: (hours.error ?? holidays.error)?.code ?? null,
    });
    return agentFail("I can't get to the book right now.", 500);
  }

  // The NEW time, not the old one: the old one was checked when the
  // booking was taken, and re-checking it here would refuse a move away
  // from a time the restaurant has since decided to close -- which is
  // the move most worth allowing.
  const verdict = openAt({
    at: newWhen,
    timezone: location.timezone,
    hours: (hours.data ?? []) as HoursRow[],
    holidays: (holidays.data ?? []) as HolidayRow[],
  });
  // An ordinary answer with the day's real hours, the same shape
  // create_reservation gives: the agent says "we're closed then, but
  // we're open five to ten thirty" and asks for another time, with the
  // caller's existing booking untouched. `unknown` is deliberately not
  // refused -- see openAt for why an unrepresentable set of hours must
  // not become a restaurant that can never change a booking.
  if (verdict.state === "closed") {
    return agentOk({
      changed: false,
      reason: "closed",
      hours_that_day: verdict.hoursThatDay,
    });
  }

  const { data, error } = await supabase
    .rpc("change_booking", {
      p_location_id: location.id,
      p_customer_name: body.customer_name,
      p_customer_phone: body.customer_phone,
      p_when: when.toISOString(),
      p_new_requested_at: newWhen.toISOString(),
      p_new_party_size: party,
    })
    .single<ChangeBookingResult>();

  if (error || !data) {
    // The SQLSTATE and the location, nothing else -- this call's
    // arguments are the caller's own name and phone number, so a
    // PostgrestError's message, details and hint all have to stay out of
    // the log. Same shape as every other agent path.
    console.error("[agent] change_booking failed", {
      location_id: location.id,
      code: error?.code ?? null,
    });
    return agentFail("I can't get to the book right now.", 500);
  }

  if (!data.changed) {
    if (data.reason && SPEAKABLE_REFUSALS.has(data.reason)) {
      // Four sentences the agent can say, and the booking is untouched
      // in all four: "I can't find that one", "more than one of these
      // could be yours -- let me get someone", "that time's full, want
      // to keep the one you have", "that's a big party, let me put you
      // through".
      return agentOk({ changed: false, reason: data.reason });
    }
    console.error("[agent] change_booking refused for a reason this route should have caught", {
      location_id: location.id,
      reason: data.reason,
    });
    return agentFail("I can't get to the book right now.", 500);
  }

  // `data.already_changed` is deliberately not in the response, exactly
  // as create_reservation withholds `duplicate` and cancel_reservation
  // withholds `already_cancelled`: a retried tool call owes the caller
  // the same spoken sentence as the first one, and a flag in the body is
  // something the model may read out about a change it made itself two
  // seconds ago.
  return agentOk({
    changed: true,
    booking_id: data.booking_id,
    party_size: data.booking_party_size,
    // The date, not just the weekday, in the location's timezone -- the
    // same read-back create_reservation gives, and for the same reason:
    // "Friday at 7:00 PM" is the same sentence for this Friday and one
    // seventeen days out, and the month and day are the only thing in it
    // a caller can catch a mistake in.
    when: data.booking_at
      ? new Intl.DateTimeFormat("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone: location.timezone,
        }).format(new Date(data.booking_at))
      : null,
  });
}
