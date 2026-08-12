import "server-only";

import type { LocationRow } from "@/lib/supabase/types";

/** The ticket as it lands on the manager's phone. Terse on purpose: it is
 *  read at a pass during service, on a screen with flour on it. */
export function orderMessage({
  orderNumber,
  type,
  customerName,
  customerPhone,
  address,
  lines,
  totalCents,
  promisedMinutes,
}: {
  orderNumber: number;
  type: string;
  customerName: string;
  customerPhone: string;
  address?: string | null;
  lines: { quantity: number; name: string }[];
  totalCents: number;
  promisedMinutes: number;
}) {
  const items = lines.map((l) => `${l.quantity}x ${l.name}`).join("\n");

  // The address was missing entirely, so a DELIVERY ticket reached the
  // pass naming a customer, a total and a 25-minute promise with nowhere
  // to take it -- the one field that makes the order actionable. Last
  // line so it is the easiest thing to copy into a phone's map, and only
  // for delivery: a pickup ticket has no address to show, and printing a
  // stale or irrelevant one on a collection order is how a driver ends up
  // dispatched to a meal nobody ordered delivered.
  const trimmedAddress = typeof address === "string" ? address.trim() : "";
  const showAddress = type.trim().toLowerCase() === "delivery" && trimmedAddress !== "";

  return [
    `#${orderNumber} ${type.toUpperCase()} - ${promisedMinutes} min`,
    items,
    `Total $${(totalCents / 100).toFixed(2)}`,
    `${customerName} ${customerPhone}`,
    ...(showAddress ? [trimmedAddress] : []),
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

  // The order is already committed by the time this runs -- a DNS
  // failure, connection reset, or timeout here must never become an
  // uncaught rejection. This function's signature promises Promise<boolean>;
  // a caller who awaits it and gets a thrown error instead of `false` will
  // turn a successful order into a 500, and the voice agent will tell the
  // caller their order failed when it is already in the kitchen queue.
  let res: Response;
  try {
    res = await fetch(
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
  } catch (err) {
    console.error("[agent] order sms request failed", err);
    return false;
  }

  if (!res.ok) {
    let body: string;
    try {
      body = await res.text();
    } catch {
      body = "(body unreadable)";
    }
    console.error("[agent] order sms failed", res.status, body);
    return false;
  }
  return true;
}
