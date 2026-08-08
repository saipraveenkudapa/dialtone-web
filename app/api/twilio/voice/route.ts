import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  twilioParams,
  verifyTwilioSignature,
  webhookUrl,
} from "@/lib/twilio/signature";
import { dial, hangup, say, twimlResponse } from "@/lib/twilio/twiml";

/** Inbound call.
 *
 *  The restaurant's carrier forwards busy / no-answer / after-hours calls
 *  to our number, so `To` is our number and `ForwardedFrom` (when the
 *  carrier sends it) is the restaurant's. We match on either.
 *
 *  Until the voice agent exists, this greets the caller, announces
 *  recording, logs the call and forwards to the human line. That is
 *  already the product's promise: the call gets answered and shows up in
 *  the dashboard instead of being missed. */
export async function POST(request: Request) {
  const params = await twilioParams(request);

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error("[twilio] TWILIO_AUTH_TOKEN is not set; refusing the call");
    return new Response("Not configured", { status: 500 });
  }

  const valid = verifyTwilioSignature({
    authToken,
    url: webhookUrl(request, "/api/twilio/voice"),
    params,
    signature: request.headers.get("x-twilio-signature"),
  });

  // Anyone can POST to this URL. Without this check they could invent
  // calls, and -- worse -- make us dial a number of their choosing.
  if (!valid) return new Response("Invalid signature", { status: 403 });

  const callSid = params.CallSid;
  const dialled = params.ForwardedFrom || params.To;
  const supabase = supabaseAdmin();

  // Match on our own number, which Twilio sends as `To` in E.164 and we
  // store the same way. Matching the restaurant's own number is not
  // useful here: business_phone is stored as a human typed it, so it
  // would never equal an E.164 string anyway. ForwardedFrom is still
  // recorded on the call for reference.
  //
  // The value is interpolated into a PostgREST filter, which is a string
  // grammar -- a comma or paren would change the filter's meaning rather
  // than be compared as data. A valid signature says the value came from
  // Twilio, not that it is shaped the way we assume.
  if (!/^\+?[0-9]{1,20}$/.test(params.To ?? "")) {
    console.warn("[twilio] unexpected To value", params.To);
    return twimlResponse(say("Sorry, this number is not in service.") + hangup());
  }

  const { data: location, error } = await supabase
    .from("locations")
    .select("*")
    .eq("twilio_number", params.To)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[twilio] location lookup failed", error);
    // Never leave a caller with dead air.
    return twimlResponse(
      say("Sorry, we can't take your call right now. Please try again shortly.") +
        hangup(),
    );
  }

  if (!location) {
    console.warn("[twilio] no location for", { to: params.To, dialled });
    return twimlResponse(
      say("Sorry, this number is not in service.") + hangup(),
    );
  }

  const fallback = location.fallback_human_number;

  // Log first, so the call exists in the dashboard even if what follows
  // fails. Upsert because Twilio retries webhooks.
  const { error: writeError } = await supabase.from("calls").upsert(
    {
      location_id: location.id,
      twilio_call_sid: callSid,
      from_number: params.From ?? null,
      from_city: params.FromCity ?? null,
      from_state: params.FromState ?? null,
      dialed_number: dialled ?? null,
      status: "in_progress",
      started_at: new Date().toISOString(),
    },
    { onConflict: "twilio_call_sid" },
  );

  if (writeError) console.error("[twilio] could not log call", writeError);

  // Kill switch: everything goes straight to a person, no greeting, no
  // recording, no delay. The owner flipped this because something is
  // wrong; do the simplest possible thing.
  if (location.kill_switch_on || !location.is_live) {
    if (!fallback) {
      return twimlResponse(
        say("Sorry, we can't take your call right now.") + hangup(),
      );
    }
    return twimlResponse(dial({ to: fallback, record: false }));
  }

  if (!fallback) {
    console.error("[twilio] no fallback number for location", location.id);
    return twimlResponse(
      say("Sorry, we can't take your call right now.") + hangup(),
    );
  }

  const record = location.recording_enabled === true;

  return twimlResponse(
    say(location.greeting_text || `Thanks for calling ${location.name}.`) +
      // Announced before recording starts. New Jersey is one-party
      // consent but callers can be in two-party states.
      (record ? say("This call may be recorded for quality.") : "") +
      dial({
        to: fallback,
        record,
        recordingStatusCallback: webhookUrl(request, "/api/twilio/recording"),
        actionUrl: webhookUrl(request, "/api/twilio/status"),
      }),
  );
}
