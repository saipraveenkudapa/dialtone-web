import { after } from "next/server";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
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
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

  const number = location.fallback_human_number;
  if (!number) {
    console.error("[agent] no fallback number for location", location.id);
    return agentFail("No transfer number is set up.", 500);
  }

  const body = (await request.json().catch(() => ({}))) as {
    reason?: string;
    provider_call_id?: string;
  };

  try {
    after(() => logTransferOutcome(location.id, body.provider_call_id, body.reason));
  } catch (err) {
    console.error("[agent] could not schedule transfer logging", err);
  }

  return agentOk({ number });
}
