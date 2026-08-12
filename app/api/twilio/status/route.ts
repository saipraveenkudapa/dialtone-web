import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  twilioParams,
  verifyTwilioSignature,
  webhookUrl,
} from "@/lib/twilio/signature";
import { twimlResponse } from "@/lib/twilio/twiml";

const STATUS_MAP: Record<string, string> = {
  queued: "ringing",
  initiated: "ringing",
  ringing: "ringing",
  "in-progress": "in_progress",
  answered: "in_progress",
  completed: "completed",
  busy: "busy",
  "no-answer": "no_answer",
  failed: "failed",
  canceled: "failed",
};

// Once a call is finished, a late webhook must not drag it back to
// "ringing". Twilio delivers these out of order and more than once.
const TERMINAL = new Set(["completed", "busy", "no_answer", "failed"]);

export async function POST(request: Request) {
  const params = await twilioParams(request);

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return new Response("Not configured", { status: 500 });

  const valid = verifyTwilioSignature({
    authToken,
    url: webhookUrl(request, "/api/twilio/status"),
    params,
    signature: request.headers.get("x-twilio-signature"),
  });
  if (!valid) return new Response("Invalid signature", { status: 403 });

  const supabase = supabaseAdmin();
  const callSid = params.CallSid;

  const { data: call } = await supabase
    .from("calls")
    .select("id, status, answered_at")
    .eq("twilio_call_sid", callSid)
    .maybeSingle();

  if (!call) {
    console.warn("[twilio] status for unknown call", callSid);
    return twimlResponse("");
  }

  // The raw audit trail, appended before anything is derived from it.
  await supabase.from("call_events").insert({
    call_id: call.id,
    event_type: params.CallStatus ?? params.DialCallStatus ?? "status",
    payload: params,
  });

  const reported = params.DialCallStatus ?? params.CallStatus ?? "";
  const next = STATUS_MAP[reported];

  if (!next || (TERMINAL.has(call.status) && !TERMINAL.has(next))) {
    return twimlResponse("");
  }

  const duration = Number(params.DialCallDuration ?? params.CallDuration ?? 0);
  const finished = TERMINAL.has(next);

  // A forwarded call jumps straight from ringing to completed, so
  // "in_progress" may never arrive. Talk time is the proof a human
  // picked up -- without this, every answered call counts as missed,
  // which is the one number the whole product is judged on.
  const wasAnswered =
    next === "in_progress" || (finished && next === "completed" && duration > 0);

  await supabase
    .from("calls")
    .update({
      status: next,
      answered_at:
        call.answered_at ?? (wasAnswered ? new Date().toISOString() : null),
      ended_at: finished ? new Date().toISOString() : null,
      duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      // A forwarded call that a person picked up is, for now, a transfer
      // to a human -- there is no agent handling it yet.
      outcome: finished && next === "completed" ? "transferred" : null,
      transferred_to_human: finished && next === "completed",
      transfer_reason: finished && next === "completed" ? "Forwarded to the human line" : null,
    })
    .eq("id", call.id);

  return twimlResponse("");
}
