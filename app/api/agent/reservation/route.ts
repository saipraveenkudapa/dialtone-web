import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { callIdForProvider } from "@/lib/agent/context";
import { isRequestInPast } from "@/lib/agent/availability";
import { openAt, type HolidayRow, type HoursRow } from "@/lib/agent/hours";

/** What `public.book_table` answers with. */
type BookTableResult = {
  booked: boolean;
  duplicate: boolean;
  booking_id: string | null;
  reason: string | null;
};

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
 *  Neither is the retry decision. A 500 or a timeout is exactly what
 *  makes an LLM call a tool twice, and a second booking is not a harmless
 *  duplicate row -- it holds seats for the whole slot, so the phantom is
 *  counted against the next genuine caller and the restaurant turns away
 *  a booking it could have taken. book_table fingerprints the call and
 *  what makes the booking distinct
 *  (supabase/migrations/20260812000500_book_table_idempotency.sql) and
 *  answers a retry with the booking that already exists, flagged
 *  `duplicate`. This route says the same sentence either way -- see
 *  below.
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
  // A party size that could not be understood at all.
  if (!Number.isInteger(party) || party < 1) {
    return agentFail("I didn't catch how many people.");
  }
  // A party size that was understood perfectly and is simply too big.
  // These used to be the same answer: a caller asking for a table for
  // twelve was told "I didn't catch how many people", so the agent asked
  // again, heard twelve again, and refused again -- while
  // check_availability, asked the same question a moment earlier, had
  // already answered `large_party`. Two endpoints disagreeing about one
  // party is a loop the caller cannot get out of. Same shape as
  // app/api/agent/availability/route.ts: an ordinary answer with a reason
  // the agent can speak ("that's a big party, let me put you through"),
  // not a failure to hear.
  if (party > location.max_party_size) {
    return agentOk({ booked: false, reason: "large_party" });
  }
  if (!body.customer_name || !body.customer_phone) {
    return agentFail("I still need a name and a number for the booking.");
  }

  // Nothing on this path read the opening hours. `book_table` does not,
  // this route did not, and `check_availability` did not either -- so a
  // table for 3 AM was counted against the seats, written, and read back
  // to the caller as confirmed, with a line of prose in the system prompt
  // as the only thing standing in the way. A booking is a promise about a
  // specific instant, so this is the one place that instant can be
  // checked against the hours the restaurant actually keeps.
  //
  // Before book_table, not inside it: hours live in two tables with a
  // holiday override and a timezone, and `lib/agent/hours.ts` is where
  // that reasoning already exists, tested. A second implementation in SQL
  // would be a third copy of the same rules to keep in step, and the
  // first time they disagreed the agent and the database would refuse
  // different bookings.
  const supabase = supabaseAdmin();
  const [hours, holidays] = await Promise.all([
    supabase.from("hours").select("*").eq("location_id", location.id),
    supabase.from("holiday_hours").select("*").eq("location_id", location.id),
  ]);

  if (hours.error || holidays.error) {
    console.error("[agent] hours read failed during reservation", {
      location_id: location.id,
      code: (hours.error ?? holidays.error)?.code ?? null,
    });
    return agentFail("I can't check the book right now.", 500);
  }

  const verdict = openAt({
    at: when,
    timezone: location.timezone,
    hours: (hours.data ?? []) as HoursRow[],
    holidays: (holidays.data ?? []) as HolidayRow[],
  });
  // An ordinary answer with a reason and the day's real hours, the same
  // shape a full house gets: the agent says "we're closed then, but we're
  // open five to ten thirty" and asks for another time. `unknown` is
  // deliberately not refused -- see openAt for why an unrepresentable set
  // of hours must not become a restaurant that can never take a booking.
  if (verdict.state === "closed") {
    return agentOk({
      booked: false,
      reason: "closed",
      hours_that_day: verdict.hoursThatDay,
    });
  }

  const { data, error } = await supabase
    .rpc("book_table", {
      p_location_id: location.id,
      p_requested_at: when.toISOString(),
      p_party_size: party,
      p_customer_name: body.customer_name,
      p_customer_phone: body.customer_phone,
      p_call_id: await callIdForProvider(location.id, body.provider_call_id),
      // Not the same thing as p_call_id: that is the calls row this
      // booking hangs off and is null whenever no webhook has created one
      // yet, while this is the provider's own id for the call in progress
      // and is what makes a retried tool call recognisable as a retry.
      // Absent, book_table has no fingerprint to build and every retry
      // books another table.
      p_provider_call_id: body.provider_call_id ?? null,
    })
    .single<BookTableResult>();

  if (error || !data) {
    // The SQLSTATE and the location, nothing else. A PostgrestError's
    // `details` carries Postgres' "Failing row contains (...)" text, which
    // for `bookings` is the caller's own name and phone number -- logging
    // the raw error put both into the application log on every failed
    // booking, which is the one place a caller's details have no business
    // being. `message` and `hint` are no safer in principle. The code is
    // enough to tell a constraint violation from a connection failure,
    // and the booking id does not exist on this path by definition. Same
    // shape as the order and transfer paths, which were hardened first.
    console.error("[agent] book_table failed", {
      location_id: location.id,
      code: error?.code ?? null,
    });
    return agentFail("I couldn't get that booking in.", 500);
  }

  // A full house is an ordinary answer, not an error: the function says
  // so in `reason` rather than raising, and the agent offers another
  // time.
  if (!data.booked) {
    return agentOk({ booked: false, reason: data.reason ?? "full" });
  }

  // `data.duplicate` is deliberately not in the response. A retry has to
  // produce the SAME spoken confirmation as the first call -- the caller
  // asked once and is owed one answer -- and anything extra in the body
  // is something the model might read out ("you already have a booking")
  // about a booking it made itself two seconds ago. The flag's job was to
  // let this route tell the two apart and choose to say nothing.
  return agentOk({
    booked: true,
    booking_id: data.booking_id,
    // The date, not just the weekday. This read back "Friday at 7:00 PM",
    // which is the same sentence for this Friday and for a Friday
    // seventeen days out -- so a caller who said "Friday" meaning
    // tomorrow, and an agent that resolved it against a stale prompt date
    // (or simply picked the wrong week), both hear a confirmation that
    // sounds exactly right. The month and day are the only thing in that
    // sentence a caller can catch the mistake in, and they cost about a
    // second of speech.
    //
    // Still rendered in the location's timezone, like every other time
    // this system speaks: `when` is a UTC instant, and a booking read back
    // in the server's timezone is a different evening.
    when: new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: location.timezone,
    }).format(when),
  });
}
