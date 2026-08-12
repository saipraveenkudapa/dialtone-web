import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { callIdForProvider } from "@/lib/agent/context";

/** transfer_to_human. This is the escape hatch for allergies, complaints,
 *  money and anything the agent cannot do, so it must work when the rest
 *  of the system does not: the number is returned first and the logging
 *  is best effort afterwards. */
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
    const callId = await callIdForProvider(location.id, body.provider_call_id);
    if (callId) {
      await supabaseAdmin()
        .from("calls")
        .update({
          transferred_to_human: true,
          transfer_reason: (body.reason ?? "Agent handed off").slice(0, 200),
          outcome: "transferred",
        })
        .eq("id", callId);
    }
  } catch (err) {
    console.error("[agent] could not log transfer", err);
  }

  return agentOk({ number });
}
