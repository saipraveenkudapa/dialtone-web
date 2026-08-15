import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  outcomeFromArtifacts,
  parseServerMessage,
  type AuditEvent,
  type CallArtifacts,
  type CallIdentity,
  type EndOfCallReport,
} from "@/lib/vapi/server-message";
import type { CallStatus, LocationRow } from "@/lib/supabase/types";

/** Everything Vapi sends about a phone number, on one URL.
 *
 *  Registered as `phoneNumber.server.url` with the location's own
 *  `x-dialtone-secret` in `server.headers`, which is why this route
 *  needs no new credential and no new environment variable:
 *  `locationForSecret` resolves the restaurant exactly the way the nine
 *  tool routes do, and one secret per location means one URL can serve
 *  every location without ever reading a location id out of a body.
 *
 *  The phone number is the right place to register it rather than the
 *  assistant, for one decisive reason: `assistant-request` fires when
 *  there is no assistant yet, so only `phoneNumber.server` (or the org,
 *  which is account-wide and whose API 401s with the key this deployment
 *  holds) can receive it. Registering it there also means the assistant
 *  object is never written to, so nothing here can rotate the tool
 *  secret -- rotation happens only in provisionAssistantForLocation,
 *  which rebuilds the whole assistant payload.
 *
 *  THIS IS NOT A TOOL ENDPOINT. `agentOk` / `agentFail` and their
 *  `{results:[...]}` envelope are Vapi's *tool* contract and must not
 *  appear here: `assistant-request` is answered with a top-level,
 *  unwrapped object, and the informational messages are answered with a
 *  bare 200. Mixing the two would break both.
 *
 *  Fail closed. An unresolvable secret gets 401 and writes nothing. For
 *  `assistant-request` that counts as the request failing, which routes
 *  the caller to the phone number's `fallbackDestination` -- a person.
 *  The degenerate case of a wrong guess is "callers reach a human",
 *  which is this product's promise anyway. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));

  if (!location) {
    // Nothing caller-supplied in this line -- not the header, not the
    // secret, nothing derived from its hash. Same discipline as
    // lib/agent/respond.ts's agentUnauthorised. There is no location to
    // name: resolving one is what just failed.
    console.error("[vapi] webhook secret rejected");
    return Response.json({ error: "Not authorised" }, { status: 401 });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const message = parseServerMessage(body);

  switch (message.type) {
    case "assistant-request":
      return assistantRequest(location);

    case "status-update":
      await recordStatusUpdate(location, message.identity, message.status, message.audit);
      return Response.json({});

    case "end-of-call-report":
      await recordEndOfCall(location, message.report, message.audit);
      return Response.json({});

    default:
      // conversation-update, speech-update, hang, and whatever Vapi adds
      // next. Answered, and nothing else: the type alone, so an
      // unexpected flood is visible without writing a body to a log.
      return Response.json({});
  }
}

/** Who answers this call -- the kill switch, finally on the call path.
 *
 *  Until now `kill_switch_on` and `is_live` were enforced in exactly two
 *  places, and neither was reachable: /api/agent/assistant (which the
 *  phone number never called, because it carried an assistantId
 *  directly) and /api/twilio/voice (which no live call reaches, because
 *  the Twilio account has no phone numbers). An owner flipping the
 *  switch mid-service changed nothing about who answered the phone.
 *
 *  The response is TOP LEVEL and unwrapped -- Vapi accepts exactly
 *  `{assistant}`, `{assistantId}`, `{destination}` or `{error}` here --
 *  and it has a hard 7.5 second end-to-end budget, which is why the only
 *  work on this path is the single `locations` read that authentication
 *  already had to do.
 *
 *  The veto is evaluated ONCE, at answer time. A caller already talking
 *  to the agent when the switch is flipped stays with the agent until
 *  they hang up: the kill switch governs the next call, not the one in
 *  progress. Worst-case exposure is one call's length. */
function assistantRequest(location: LocationRow) {
  const enabled =
    !location.kill_switch_on && location.is_live && location.vapi_assistant_id;

  if (enabled) return Response.json({ assistantId: location.vapi_assistant_id });

  // Switched off, not live, or no assistant to point at -- all three
  // mean the same thing to the person on the phone, and the answer to
  // all three is a human. `message` is spoken before the transfer; Vapi's
  // default line is "Transferring the call now", which is wrong coming
  // from a restaurant.
  if (location.fallback_human_number) {
    return Response.json({
      destination: {
        type: "number",
        number: location.fallback_human_number,
        message: "One moment, I'm connecting you.",
      },
    });
  }

  // No fallback configured. `error` is spoken to the caller, so it is a
  // sentence rather than a code -- and it must exist, because answering
  // nothing here is dead air.
  console.error("[vapi] no fallback number for a disabled location", {
    location_id: location.id,
  });
  return Response.json({ error: "Sorry, we can't take your call right now." });
}

/** The calls row for this provider call id, creating it if this is the
 *  first message about the call. Returns null if it could not be had.
 *
 *  Scoped by location on every statement, and deliberately NOT an
 *  `.upsert()`. `location_id` comes from the authenticated secret while
 *  `provider_call_id` comes from the request body, so an upsert's
 *  conflict target would be body-supplied: the unique index on
 *  provider_call_id is global, so a report authenticated for restaurant
 *  B would match restaurant A's row and rewrite it -- moving A's call,
 *  transcript, recording and costs into B's dashboard. supabaseAdmin()
 *  bypasses RLS entirely, so the choice of statement is the only tenant
 *  boundary on this write.
 *
 *  Select-then-insert makes that boundary explicit at both levels. A row
 *  belonging to another location is invisible to the select, and the
 *  insert that follows is refused by the global unique index rather than
 *  stealing it. */
async function callRowId(
  location: LocationRow,
  identity: CallIdentity,
): Promise<string | null> {
  if (!identity.providerCallId) return null;

  const supabase = supabaseAdmin();

  const existing = await supabase
    .from("calls")
    .select("id")
    .eq("location_id", location.id)
    .eq("provider_call_id", identity.providerCallId)
    .maybeSingle();

  if (existing.error) {
    // `provider_call_id` is a request-body value and is part of this
    // filter, so a PostgrestError's message or details can echo it back.
    // The location and the SQLSTATE only, the same as every other agent
    // path.
    console.error("[vapi] call lookup failed", {
      location_id: location.id,
      code: existing.error.code,
    });
    return null;
  }

  if (existing.data) return (existing.data as { id: string }).id;

  const created = await supabase
    .from("calls")
    .insert({
      location_id: location.id,
      provider_call_id: identity.providerCallId,
      // Null, always. A Vapi call has no Twilio SID, and writing Vapi's
      // id here would duplicate provider_call_id and poison the key
      // app/api/twilio/voice upserts on.
      twilio_call_sid: null,
      from_number: identity.fromNumber,
      // Vapi does not report the caller's city or state. They stay null
      // rather than being invented from the number.
      dialed_number: identity.dialedNumber,
      started_at: identity.startedAt ?? new Date().toISOString(),
      status: "ringing" as CallStatus,
    })
    .select("id")
    .single();

  if (created.error) {
    // 23505 here means another location already owns this call id --
    // the cross-tenant case the global unique index exists to refuse.
    console.error("[vapi] could not create the call row", {
      location_id: location.id,
      code: created.error.code,
    });
    return null;
  }

  return (created.data as { id: string }).id;
}

async function appendEvent(location: LocationRow, callId: string, audit: AuditEvent) {
  const { error } = await supabaseAdmin().from("call_events").insert({
    call_id: callId,
    event_type: audit.eventType,
    payload: audit.payload,
  });

  if (error) {
    console.error("[vapi] could not append the call event", {
      location_id: location.id,
      code: error.code,
    });
  }
}

/** The call is happening. Create the row now, not at the end.
 *
 *  This is the whole reason status-update is handled at all. Tool calls
 *  land DURING a call and lib/agent/context.ts's callIdForProvider()
 *  looks the call up by provider_call_id -- so if the row only appeared
 *  in the end-of-call-report, every agent-taken order and booking would
 *  still be stored with a null call link, which is the symptom this is
 *  meant to fix. */
async function recordStatusUpdate(
  location: LocationRow,
  identity: CallIdentity,
  status: CallStatus | null,
  audit: AuditEvent,
) {
  const callId = await callRowId(location, identity);
  if (!callId) return;

  if (status) {
    // Never drag a finished call backwards. end-of-call-report and a
    // late status-update can arrive in either order.
    const { error } = await supabaseAdmin()
      .from("calls")
      .update({ status })
      .eq("id", callId)
      .eq("location_id", location.id)
      .in("status", ["ringing", "in_progress"]);

    if (error) {
      console.error("[vapi] could not update the call status", {
        location_id: location.id,
        code: error.code,
      });
    }
  }

  await appendEvent(location, callId, audit);
}

/** What this call actually produced, read back out of our own tables.
 *
 *  `place_order`, `book_table` and `take_message` all run DURING the
 *  call and insert carrying its id -- lib/agent/context.ts resolves that
 *  id from provider_call_id, which is why the status-update handler has
 *  to create the calls row before any of them fire. So by the time the
 *  end-of-call-report lands, "this call produced an order" is already a
 *  fact sitting in `orders`, and nothing has to be guessed from the
 *  transcript. calls.outcome is derived from these three answers in
 *  outcomeFromArtifacts.
 *
 *  Every select is scoped by location_id as well as call_id, exactly
 *  like every other statement on this route: supabaseAdmin() bypasses
 *  RLS, so the tenant predicate in the statement is the only boundary
 *  there is. Neither value is caller-supplied -- `callId` is our own
 *  primary key and `location.id` came from the authenticated secret --
 *  so no id out of the request body reaches these filters.
 *
 *  A failed lookup answers "no". That loses a label and can never
 *  invent one, which is the same direction of failure as the rest of
 *  this file, and the same reason the error line carries the location
 *  and the SQLSTATE and nothing else. */
async function callArtifacts(
  location: LocationRow,
  callId: string,
): Promise<Omit<CallArtifacts, "transferred">> {
  const supabase = supabaseAdmin();

  const exists = async (table: "orders" | "bookings" | "messages") => {
    try {
      const { data, error } = await supabase
        .from(table)
        .select("id")
        .eq("location_id", location.id)
        .eq("call_id", callId)
        .limit(1);

      if (error) {
        console.error("[vapi] could not read what the call produced", {
          location_id: location.id,
          // A literal from this file, never anything out of the body.
          table,
          code: error.code,
        });
        return false;
      }

      return (data?.length ?? 0) > 0;
    } catch (err) {
      // Same posture as storeRecording: the label is the least valuable
      // thing in this write and must never be what costs us the
      // transcript. The error's name only -- a thrown transport error
      // can carry the request, and the request carries the service-role
      // key.
      console.error("[vapi] could not read what the call produced", {
        location_id: location.id,
        table,
        reason: err instanceof Error ? err.name : "unknown",
      });
      return false;
    }
  };

  const [hasOrder, hasBooking, hasMessage] = await Promise.all([
    exists("orders"),
    exists("bookings"),
    exists("messages"),
  ]);

  return { hasOrder, hasBooking, hasMessage };
}

/** The call is over: close the row, and store what it produced. */
async function recordEndOfCall(
  location: LocationRow,
  report: EndOfCallReport,
  audit: AuditEvent,
) {
  const callId = await callRowId(location, report.identity);
  if (!callId) return;

  const outcome = outcomeFromArtifacts({
    transferred: report.transferred,
    ...(await callArtifacts(location, callId)),
  });

  const patch: Record<string, unknown> = {
    status: report.status,
    answered_at: report.answeredAt,
    ended_at: report.endedAt,
    duration_seconds: report.durationSeconds,
    transcript: report.transcript,
    transcript_status: "ready",
    transferred_to_human: report.transferred,
    telephony_cost_cents: report.telephonyCostCents,
    llm_cost_cents: report.llmCostCents,
  };

  // Set, never cleared. A null derivation means nothing in our own
  // tables distinguishes this call, and every dashboard already renders
  // that as a neutral "completed" chip -- which is true, where a guess
  // would not be. Writing the null would also wipe an outcome a manager
  // had set by hand, and staff may update `calls` (20260807000200_rls).
  if (outcome) patch.outcome = outcome;

  const { error } = await supabaseAdmin()
    .from("calls")
    .update(patch)
    .eq("id", callId)
    .eq("location_id", location.id);

  if (error) {
    console.error("[vapi] could not close the call row", {
      location_id: location.id,
      code: error.code,
    });
  }

  await storeRecording(location, callId, report.recordingUrl);
  await appendEvent(location, callId, audit);
}

/** Pull the audio into our own private bucket and keep only the path.
 *
 *  The same destination the Twilio path used -- private
 *  `call-recordings` bucket, `<location_id>/<call_id>`,
 *  `calls.recording_path`, and lib/data.ts's 300-second signed URL for
 *  playback -- with three differences that are Vapi's, not ours:
 *
 *   - the source is `artifact.presignedMonoUrl` and it is fetched with
 *     NO Authorization header. Sending Twilio's credentials (or any
 *     other) to a third-party storage host would be a credential leak,
 *     and the presigned URL does not want one.
 *   - the audio is WAV, not MP3, so the extension and content type say
 *     so. `<audio>` plays WAV natively; nothing is transcoded.
 *   - it happens here, in the end-of-call handler. Vapi has no separate
 *     recording-completed callback; the report is the callback, and the
 *     presigned URL in it is good for about thirty minutes.
 *
 *  Failure posture is kept verbatim from the Twilio path: losing a
 *  recording must never take the call record with it. */
async function storeRecording(
  location: LocationRow,
  callId: string,
  recordingUrl: string | null,
) {
  if (!recordingUrl) return;

  // `locations.recording_enabled` is what the Twilio path gated
  // recording on, and this write path honours it too. It cannot stop
  // Vapi from recording -- that is `assistant.artifactPlan`, which
  // defaults to on and is not this change's to set -- but a location
  // that has switched recording off must not find its calls in our
  // bucket.
  if (!location.recording_enabled) return;

  try {
    const audio = await fetch(recordingUrl);
    if (!audio.ok) throw new Error(`recording fetch returned ${audio.status}`);

    const path = `${location.id}/${callId}.wav`;
    const supabase = supabaseAdmin();

    // Buffered whole, exactly as the Twilio path did: about 2 MB per
    // minute of call, so a ten-minute call is ~20 MB in a serverless
    // function. Fine at this size; worth knowing before it is not.
    const { error: uploadError } = await supabase.storage
      .from("call-recordings")
      .upload(path, await audio.arrayBuffer(), {
        contentType: "audio/wav",
        upsert: true,
      });

    if (uploadError) throw uploadError;

    const { error } = await supabase
      .from("calls")
      .update({ recording_path: path })
      .eq("id", callId)
      .eq("location_id", location.id);

    if (error) {
      console.error("[vapi] could not save the recording path", {
        location_id: location.id,
        code: error.code,
      });
    }
  } catch (err) {
    // The message only, never the object: a presigned URL carries its
    // own signature, and an error that echoed the request back would
    // write a fetchable link to the recording into the log.
    console.error("[vapi] could not store recording", {
      location_id: location.id,
      reason: err instanceof Error ? err.name : "unknown",
    });
  }
}
