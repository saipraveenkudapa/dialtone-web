import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  twilioParams,
  verifyTwilioSignature,
  webhookUrl,
} from "@/lib/twilio/signature";

/** Recording finished. Pull the audio out of Twilio and into our own
 *  private bucket, then keep only the storage path.
 *
 *  Twilio's RecordingUrl needs account credentials to fetch, so leaving
 *  recordings there would mean either shipping those credentials to the
 *  browser or proxying every playback. Our own bucket is private and
 *  served through short-lived signed URLs, which is also what makes the
 *  retention setting mean anything. */
export async function POST(request: Request) {
  const params = await twilioParams(request);

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  if (!authToken || !accountSid) {
    return new Response("Not configured", { status: 500 });
  }

  const valid = verifyTwilioSignature({
    authToken,
    url: webhookUrl(request, "/api/twilio/recording"),
    params,
    signature: request.headers.get("x-twilio-signature"),
  });
  if (!valid) return new Response("Invalid signature", { status: 403 });

  const supabase = supabaseAdmin();
  const callSid = params.CallSid;

  const { data: call } = await supabase
    .from("calls")
    .select("id, location_id")
    .eq("twilio_call_sid", callSid)
    .maybeSingle();

  if (!call) {
    console.warn("[twilio] recording for unknown call", callSid);
    return new Response("", { status: 204 });
  }

  const recordingUrl = params.RecordingUrl;
  if (!recordingUrl) return new Response("", { status: 204 });

  try {
    const audio = await fetch(`${recordingUrl}.mp3`, {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${accountSid}:${authToken}`).toString("base64"),
      },
    });

    if (!audio.ok) throw new Error(`Twilio returned ${audio.status}`);

    const path = `${call.location_id}/${call.id}.mp3`;
    const { error: uploadError } = await supabase.storage
      .from("call-recordings")
      .upload(path, await audio.arrayBuffer(), {
        contentType: "audio/mpeg",
        upsert: true,
      });

    if (uploadError) throw uploadError;

    await supabase
      .from("calls")
      .update({
        recording_path: path,
        transcript_status: "pending",
      })
      .eq("id", call.id);
  } catch (err) {
    // Losing a recording must never take the call record with it.
    console.error("[twilio] could not store recording", err);
    return new Response("", { status: 204 });
  }

  return new Response("", { status: 204 });
}
