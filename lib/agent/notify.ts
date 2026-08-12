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
  lines: { quantity: number; name: string; note?: string | null }[];
  totalCents: number;
  promisedMinutes: number;
}) {
  // The change the caller asked for, on its own indented line under the
  // item it belongs to. It was not printed at all: the agent confirmed
  // "no onions" out loud, `place_order` had nowhere to put it, and the
  // ticket at the pass said `1x Margherita` -- so the caller got the
  // wrong food every time they changed anything. A cook reads this
  // column-first down the left edge, so the marker has to break that
  // column to be seen at all; appending it to the item line ("1x
  // Margherita (no onions)") hides it at the end of a line that scans as
  // already understood.
  const items = lines
    .map((l) => {
      const note = typeof l.note === "string" ? l.note.trim() : "";
      return note === "" ? `${l.quantity}x ${l.name}` : `${l.quantity}x ${l.name}\n  * ${note}`;
    })
    .join("\n");

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
    // The error's name and message, not the error. A rejected fetch in
    // Node carries a `cause` that quotes the request URL, and this URL has
    // the Twilio account SID in its path -- there is no reason for that to
    // be sitting in an application log.
    console.error("[agent] order sms request failed", {
      location_id: location.id,
      error: err instanceof Error ? `${err.name}: ${err.message}` : "unknown",
    });
    return false;
  }

  if (!res.ok) {
    // The status and Twilio's own numeric error code, never the response
    // body. Twilio quotes rejected parameters back in its error text, and
    // the parameter this request is mostly made of is `Body` -- the
    // kitchen ticket, which carries the caller's name, phone number,
    // delivery address and whatever they asked to have changed about
    // their food. Dumping that into the log on every failed send would
    // undo, in the failure path, exactly what the redaction on the way in
    // is for. The code is what a Twilio error is actually diagnosed from.
    let code: unknown = null;
    try {
      code = ((await res.json()) as { code?: unknown })?.code ?? null;
    } catch {
      code = null;
    }
    console.error("[agent] order sms failed", {
      location_id: location.id,
      status: res.status,
      twilio_code: code,
    });
    return false;
  }
  return true;
}
