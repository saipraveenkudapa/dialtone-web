/** Minimal TwiML builders. No SDK: these are three fixed documents, and
 *  hand-rolling them keeps the response path dependency-free. */

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export function twimlResponse(body: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

export function say(text: string) {
  return `<Say voice="Polly.Joanna">${escapeXml(text)}</Say>`;
}

export function dial({
  to,
  callerId,
  record,
  recordingStatusCallback,
  actionUrl,
  timeoutSeconds = 25,
}: {
  to: string;
  callerId?: string | null;
  record: boolean;
  recordingStatusCallback?: string;
  actionUrl?: string;
  timeoutSeconds?: number;
}) {
  const attrs = [
    `timeout="${timeoutSeconds}"`,
    callerId ? `callerId="${escapeXml(callerId)}"` : "",
    // Dual channel keeps caller and callee on separate tracks, which is
    // what makes a transcript worth reading later.
    record ? 'record="record-from-answer-dual"' : "",
    record && recordingStatusCallback
      ? `recordingStatusCallback="${escapeXml(recordingStatusCallback)}" recordingStatusCallbackEvent="completed"`
      : "",
    actionUrl ? `action="${escapeXml(actionUrl)}"` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return `<Dial ${attrs}>${escapeXml(to)}</Dial>`;
}

export const hangup = () => "<Hangup/>";
