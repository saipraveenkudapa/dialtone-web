import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { callIdForProvider } from "@/lib/agent/context";
import { buildMessage } from "@/lib/agent/messages";

/** take_message. What happens now that a transfer is only for catering
 *  and allergy questions.
 *
 *  Every other reason a call used to be handed to a human -- an angry
 *  caller, "let me speak to a manager", a complaint about a past order,
 *  speech the agent still cannot make out after asking twice -- now ends
 *  here instead. That makes this route the difference between a caller
 *  who was heard and a caller who was merely apologised to: if nothing
 *  is written, the restaurant never learns the call happened, and the
 *  person on the phone hangs up believing somebody will ring them back.
 *
 *  So the only thing this route is strict about is whether the message
 *  is one somebody could actually act on -- a name, a number to ring,
 *  and something to pass on. All three are `agentFail`, the same answer
 *  every other unheard field gets, because "I didn't catch that" is a
 *  question the caller can answer. There is no business refusal on this
 *  path at all: there is no such thing as a message the restaurant is
 *  not allowed to receive.
 *
 *  Unlike an order or a booking there is nothing to serialise here --
 *  one row, five plain facts, no seats and no money -- so there is no
 *  Postgres function behind it (see
 *  supabase/migrations/20260812000900_messages.sql for why, including
 *  why a retried tool call is allowed to leave two copies). */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const body = (await request.json().catch(() => ({}))) as {
    caller_name?: unknown;
    callback_number?: unknown;
    message?: unknown;
    provider_call_id?: string;
  };

  // Redaction, length bounds and "is this enough to ring somebody back"
  // all live in lib/agent/messages.ts, so they can be tested without a
  // database and so the caller's words are scrubbed before they are
  // anywhere near a column or a log line.
  const built = buildMessage(body);
  if (!built.ok) {
    if (built.reason === "no_name") {
      return agentFail("I didn't catch your name.");
    }
    if (built.reason === "no_callback") {
      return agentFail("I didn't catch the best number to call you back on.");
    }
    return agentFail("I didn't catch what you'd like me to pass on.");
  }

  const { error } = await supabaseAdmin()
    .from("messages")
    .insert({
      // The location the secret resolved to, never a body value. This
      // route runs under the service role and bypasses RLS, so this
      // assignment is the entire tenant boundary for the write.
      location_id: location.id,
      // Scoped by location as well as provider id (see
      // lib/agent/context.ts), so a `provider_call_id` from a request
      // body cannot hang this message off another restaurant's call.
      // Null when no webhook has created a call row yet -- a message
      // with nobody's call attached is still a person waiting for a
      // callback, so that is never a reason to refuse.
      call_id: await callIdForProvider(location.id, body.provider_call_id),
      caller_name: built.message.caller_name,
      callback_phone: built.message.callback_phone,
      body: built.message.body,
    });

  if (error) {
    // The location and the SQLSTATE, nothing else -- the same rule as
    // every other agent path, and load-bearing here: a PostgrestError's
    // `details` carries Postgres' "Failing row contains (...)" text,
    // which for this table is the caller's name, their phone number and
    // the words they just said. `message` and `hint` are no safer in
    // principle.
    console.error("[agent] message insert failed", {
      location_id: location.id,
      code: error.code,
    });
    // 500, not a refusal: the caller did nothing wrong and asking them to
    // repeat themselves would not help. The agent apologises and offers
    // the one thing still available to it -- the number a person answers.
    return agentFail("I couldn't get that message down.", 500);
  }

  // Deliberately nothing about the message in the response. The agent
  // already knows what it just said and what the caller told it; echoing
  // a stored, normalised copy back only gives the model something to read
  // out that is not quite what was said -- `[redacted]` most of all.
  return agentOk({ taken: true });
}
