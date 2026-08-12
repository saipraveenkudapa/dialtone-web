/** One envelope for every tool endpoint.
 *
 *  The agent reads these values out loud, so an error must be a sentence
 *  a person can hear, never a stack trace or a code. */
export function agentOk(data: Record<string, unknown>) {
  return Response.json({ ok: true, ...data });
}

export function agentFail(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status });
}
