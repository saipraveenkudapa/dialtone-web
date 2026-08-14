import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk, agentUnauthorised } from "@/lib/agent/respond";
import { parseToolCall } from "@/lib/agent/vapi";
import { isRequestInPast } from "@/lib/agent/availability";
import { callerFieldText, hasUsableCallerName, hasUsableCallerPhone } from "@/lib/agent/caller";

/** What `public.cancel_booking` answers with. */
type CancelBookingResult = {
  cancelled: boolean;
  already_cancelled: boolean;
  booking_id: string | null;
  booking_at: string | null;
  reason: string | null;
};

/** Refusals the agent can act on. Everything else `cancel_booking` can
 *  return describes a request this route was supposed to have validated
 *  first, so seeing one means the two have drifted apart -- a fault to
 *  log and apologise for, not a sentence to read to a caller. Same shape as the
 *  order route's SPEAKABLE_REFUSALS. */
const SPEAKABLE_REFUSALS = new Set(["not_found", "ambiguous"]);

/** cancel_reservation.
 *
 *  The prompt has listed "Book, change, or cancel a table reservation"
 *  among the four things this agent can do since the first version of
 *  it, and only booking had a tool. That is worse than a missing
 *  feature: because cancelling is one of the four, the prompt's own
 *  "transfer anything outside these" rule never fired for it, so a
 *  caller ringing to cancel met an agent that believed it could help and
 *  had nothing to call.
 *
 *  Who a booking belongs to is NOT decided here. The matching rule lives
 *  in `public.cancel_booking`
 *  (supabase/migrations/20260812000800_cancel_change_reservation.sql),
 *  which requires the first name, the phone number and roughly when the
 *  table is to line up together, all within the location this request's
 *  secret resolved to -- and refuses outright rather than guessing when
 *  more than one booking could be the one meant. A phone number is not a
 *  secret, so a number alone must never be enough to empty a stranger's
 *  table; that reasoning, and the full list of what the rule refuses, is
 *  written out in the migration.
 *
 *  Nor is the future-only rule: `p_when` reaching a booking that has
 *  already happened is refused by the function's own `requested_at >
 *  now()`, not merely by the gate below. A route can be bypassed by the
 *  next caller of that function; "a past booking is not the caller's to
 *  touch" is a property of the book.
 *
 *  What remains here is what the caller has to be told: the validation
 *  that produces a sentence a person can hear, and the wording of the
 *  answer. */
export async function POST(request: Request) {
  // Parsed before the secret lookup, because the unauthorised branch now
  // needs the toolCallId too -- and `request.json()` may only be consumed
  // once, so this is the single read. `null` rather than `{}` is the
  // honest "no readable body"; parseToolCall branch A handles it.
  const call = parseToolCall(await request.json().catch(() => null));

  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentUnauthorised(call.toolCallId);

  // The model's arguments live inside the tool call, never at the top
  // level of the body -- see lib/agent/vapi.ts.
  const args = call.args as {
    booking_time?: string;
    // `unknown`, not `string`. These two arrive from a JSON.parse of a
    // model-authored arguments string, and a cast claiming `string` is
    // what stopped tsc noticing that `"customer_phone": 5105550100` --
    // the shape lib/agent/messages.ts names as the one a tool payload
    // plausibly carries unquoted -- reached `.replace` and threw a
    // framework 500 out of this handler, which Vapi discards entirely.
    customer_name?: unknown;
    customer_phone?: unknown;
  };

  // Coerced once, up front, so the strings the gate below judges are the
  // exact strings `app.caller_name_key` / `app.caller_phone_key` are
  // given. See lib/agent/caller.ts.
  const customerName = callerFieldText(args.customer_name);
  const customerPhone = callerFieldText(args.customer_phone);

  const when = args.booking_time ? new Date(args.booking_time) : null;

  if (!when || Number.isNaN(when.getTime())) {
    return agentFail("I didn't catch when the booking is for.", call.toolCallId);
  }
  // The same past-time gate, with the same clock-skew tolerance, that
  // check_availability and create_reservation apply to `requested_at`.
  // A table that has already come and gone is not the caller's to
  // cancel -- the seats were either used or lost, and rewriting the
  // night after the fact only corrupts the restaurant's own record of
  // it. Refused as something the agent says, not answered `not_found`,
  // because "that one's already past" is a different sentence from "I
  // can't find it" and the caller deserves the true one.
  if (isRequestInPast(when, new Date())) {
    return agentFail("That booking has already passed.", call.toolCallId);
  }
  // Both, always -- and each has to be something app.caller_name_key /
  // app.caller_phone_key can actually turn into a key, not merely a
  // non-empty string. The whole safety of this endpoint is that a phone
  // number on its own identifies nobody -- see the migration -- so a
  // request carrying only one of the two is the agent not having
  // finished asking, and must not reach the matcher at all.
  //
  // A name the transcript reduced to "22", or a phone number heard as
  // six digits, is the same problem wearing a different shape: both
  // normalise to NULL in SQL, and cancel_booking answers that with
  // `missing_details` -- which is not in SPEAKABLE_REFUSALS below and so
  // would otherwise fall straight into the log-and-apologise branch, telling a
  // caller "I can't get to the book right now" for something as ordinary
  // as a misheard name. Caught here instead, before the call, and
  // answered the way every other unheard field in this route is: ask
  // again. See lib/agent/caller.ts for why this check does not have to
  // reproduce the SQL normalisation exactly to do that job.
  if (!hasUsableCallerName(customerName) || !hasUsableCallerPhone(customerPhone)) {
    return agentFail("I still need the name and number the booking's under.", call.toolCallId);
  }

  // No opening-hours gate here, deliberately, unlike create_reservation
  // and change_reservation. Those two are choosing an instant the
  // restaurant has to be open at; this one is releasing an instant that
  // was already checked when the booking was taken. Refusing a
  // cancellation because the hours rows changed since -- a holiday added,
  // a weekday closed -- would trap the caller with a table at a
  // restaurant that is now shut, which is exactly the booking most worth
  // cancelling.
  const { data, error } = await supabaseAdmin()
    .rpc("cancel_booking", {
      p_location_id: location.id,
      p_customer_name: customerName,
      p_customer_phone: customerPhone,
      p_when: when.toISOString(),
    })
    .single<CancelBookingResult>();

  if (error || !data) {
    // The SQLSTATE and the location, nothing else. A PostgrestError's
    // `details` carries Postgres' "Failing row contains (...)" text,
    // which for `bookings` is the caller's own name and phone number,
    // and this call's own arguments ARE that name and number, so
    // `message` and `hint` are no safer. Same shape as every other agent
    // path.
    console.error("[agent] cancel_booking failed", {
      location_id: location.id,
      code: error?.code ?? null,
    });
    return agentFail("I can't get to the book right now.", call.toolCallId);
  }

  if (!data.cancelled) {
    if (data.reason && SPEAKABLE_REFUSALS.has(data.reason)) {
      // Two different sentences for the agent, and the difference
      // matters. `not_found` is "I can't find that one" -- ask again or
      // hand over. `ambiguous` is "more than one of these could be
      // yours", which is precisely the moment this agent is designed to
      // stop and get a person: picking one would cancel a table
      // belonging to somebody who is not on the phone.
      return agentOk({ cancelled: false, reason: data.reason }, call.toolCallId);
    }
    console.error("[agent] cancel_booking refused for a reason this route should have caught", {
      location_id: location.id,
      reason: data.reason,
    });
    return agentFail("I can't get to the book right now.", call.toolCallId);
  }

  // `data.already_cancelled` is deliberately not in the response, for
  // the same reason create_reservation withholds `duplicate`: a retried
  // tool call has to produce the SAME spoken answer as the first one.
  // The caller asked once and is owed one answer, and anything extra in
  // the body is something the model might read out ("that was already
  // cancelled") about a cancellation it made itself two seconds ago. The
  // flag's job was to let this route tell the two apart and choose to
  // say nothing.
  return agentOk({
    cancelled: true,
    booking_id: data.booking_id,
    // The booking's own time, read back so the caller can catch a
    // cancellation of the wrong evening while they are still on the
    // phone -- the same reason create_reservation speaks the date and
    // not just the weekday. Rendered in the location's timezone, like
    // every other time this system speaks: `booking_at` is a UTC
    // instant, and a table read back in the server's timezone is a
    // different night.
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
  }, call.toolCallId);
}
