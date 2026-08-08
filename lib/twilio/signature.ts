import crypto from "node:crypto";

/** Rebuild the exact URL Twilio signed.
 *
 *  Twilio signs the public URL it called, which behind a proxy or tunnel
 *  is not what the request object reports. TWILIO_WEBHOOK_BASE_URL is the
 *  source of truth; the request URL is only a fallback for local runs. */
export function webhookUrl(request: Request, path: string) {
  const base = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (base) return new URL(path, base).toString();
  const url = new URL(request.url);
  return `${url.origin}${path}`;
}

/**
 * Verify X-Twilio-Signature: base64 HMAC-SHA1, over the full URL followed
 * by every POST parameter as key+value, sorted by key.
 *
 * https://www.twilio.com/docs/usage/security#validating-requests
 */
export function verifyTwilioSignature({
  authToken,
  url,
  params,
  signature,
}: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string | null;
}) {
  if (!signature) return false;

  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);

  const expected = crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(payload, "utf-8"))
    .digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  // Length check first: timingSafeEqual throws on a length mismatch, and
  // an early return on length leaks nothing an attacker cannot measure
  // from the signature they sent.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Read a Twilio webhook body as plain key/value pairs. */
export async function twilioParams(request: Request) {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  return params;
}
