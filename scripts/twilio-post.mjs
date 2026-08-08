#!/usr/bin/env node
/* Sign a request the way Twilio does, so the webhooks can be exercised
   without a phone. Reads TWILIO_AUTH_TOKEN from the environment.

   node scripts/twilio-post.mjs /api/twilio/voice '{"CallSid":"CAtest","To":"+15105550177"}'
   node scripts/twilio-post.mjs /api/twilio/voice '{...}' unsigned   # expect 403
*/
import crypto from "node:crypto";

const token = process.env.TWILIO_AUTH_TOKEN ?? process.env.TOKEN ?? "";
const path = process.argv[2];
const params = JSON.parse(process.argv[3] ?? "{}");
const sign = process.argv[4] !== "unsigned";

const base = process.env.TWILIO_WEBHOOK_BASE_URL ?? "http://localhost:3000";
const url = `${base}${path}`;
const payload = Object.keys(params).sort().reduce((a, k) => a + k + params[k], url);
const signature = crypto.createHmac("sha1", token).update(Buffer.from(payload, "utf-8")).digest("base64");

const body = new URLSearchParams(params);
const res = await fetch(`http://localhost:3000${path}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    ...(sign ? { "X-Twilio-Signature": signature } : {}),
  },
  body,
});
console.log(`HTTP ${res.status}`);
console.log((await res.text()).slice(0, 700));
