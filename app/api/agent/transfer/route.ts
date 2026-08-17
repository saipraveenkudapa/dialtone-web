import { after } from "next/server";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { dialableNumber } from "@/lib/phone";
import { agentFail, agentOk, agentUnauthorised } from "@/lib/agent/respond";
import { parseToolCall } from "@/lib/agent/vapi";
import { logTransferOutcome } from "@/lib/agent/transfer";

/** transfer_to_human. This is the escape hatch for allergies, complaints,
 *  money and anything the agent cannot do, so it must work when the rest
 *  of the system does not: the number is returned first, and the
 *  logging -- looking up the call row, writing `transferred_to_human`
 *  and `transfer_reason` -- is best effort afterwards.
 *
 *  "Afterwards" is not a comment here, it is `after()`: nothing about
 *  logging the transfer is `await`ed on the response path, so a
 *  degraded database (the exact partial outage this route exists to
 *  survive) cannot make a caller hold through an allergy question or a
 *  complaint while a write hangs. `logTransferOutcome` still never
 *  throws on its own, so this is defence in depth, not a reason to be
 *  careless about that -- see its own docstring in lib/agent/transfer.ts.
 *
 *  `after()`'s own guarantee is only as strong as its host: it relies on
 *  the deployment platform providing `waitUntil` to keep the invocation
 *  alive past the response (Vercel and a self-hosted Next.js Node server
 *  both do). Without one it throws synchronously the moment it is
 *  called, which the try/catch below turns into "this deploy can't do
 *  best-effort logging, so there is nothing to schedule" instead of a
 *  500 -- weaker than the normal best-effort-and-usually-succeeds
 *  guarantee elsewhere, but still never the caller's problem. */
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
  const args = call.args as { reason?: string };

  /* DIALABLE, NOT MERELY PRESENT. This number is handed to Vapi and
     dialled verbatim -- nothing between here and the PSTN re-formats
     it -- so a row holding "12" or a legacy "(510) 555-0199" used to
     pass this gate and then fail inside the transfer, which the caller
     experiences as dead air part-way through being helped. The same
     refusal for both states, because they are the same state to the
     person on the phone: there is nowhere to send them. Saying so
     returns a sentence the agent can speak instead of a silence.

     The number is never logged, only the location id -- the house rule
     about what goes in a log does not bend for a diagnostic. */
  const number = dialableNumber(location.fallback_human_number);
  if (!number) {
    console.error(
      location.fallback_human_number
        ? "[agent] fallback number for location cannot be dialled"
        : "[agent] no fallback number for location",
      location.id,
    );
    return agentFail("No transfer number is set up.", call.toolCallId);
  }

  try {
    after(() => logTransferOutcome(location.id, call.providerCallId, args.reason));
  } catch (err) {
    console.error("[agent] could not schedule transfer logging", err);
  }

  return agentOk({ number }, call.toolCallId);
}
