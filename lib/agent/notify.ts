import "server-only";

import type { LocationRow } from "@/lib/supabase/types";

/** The ticket as it lands on the manager's phone. Terse on purpose: it is
 *  read at a pass during service, on a screen with flour on it. */
export function orderMessage({
  orderNumber,
  type,
  customerName,
  customerPhone,
  lines,
  totalCents,
  promisedMinutes,
}: {
  orderNumber: number;
  type: string;
  customerName: string;
  customerPhone: string;
  lines: { quantity: number; name: string }[];
  totalCents: number;
  promisedMinutes: number;
}) {
  const items = lines.map((l) => `${l.quantity}x ${l.name}`).join("\n");
  return [
    `#${orderNumber} ${type.toUpperCase()} - ${promisedMinutes} min`,
    items,
    `Total $${(totalCents / 100).toFixed(2)}`,
    `${customerName} ${customerPhone}`,
  ].join("\n");
}

/** Send the ticket to the restaurant's own staff number.
 *
 *  This is the only outbound message in the product, and it goes to the
 *  business that asked for it -- never to a customer. Texting callers
 *  would be a different legal problem entirely. */
export async function sendOrderSms(location: LocationRow, message: string) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const to = location.order_sms_to;
  const from = location.twilio_number;

  if (!sid || !token || !to || !from) {
    console.error("[agent] cannot send order sms: missing config");
    return false;
  }

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: message }),
    },
  );

  if (!res.ok) {
    console.error("[agent] order sms failed", res.status, await res.text());
    return false;
  }
  return true;
}
