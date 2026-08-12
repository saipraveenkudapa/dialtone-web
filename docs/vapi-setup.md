# Wiring a restaurant to Vapi

Inbound only. Nothing here originates a call.

This app exposes nine HTTP endpoints under `app/api/agent/`: eight tools the
agent calls mid-conversation, and one config endpoint (`/assistant`) that
hands Vapi the system prompt for a call before it starts. Vapi (or whatever
holds the call) is the thing that actually talks to the caller, decides
when to call a tool, and reads the tool's answer out loud. Everything below
was checked against the routes and their tests as of this writing, not
against the product spec -- read `app/api/agent/*/route.ts` yourself before
trusting a detail that matters to you, especially anything about Vapi's own
wire format, which is outside this repo and can change under us.

`scripts/provision-vapi.mjs` (step 3 below) does the Vapi-side wiring --
creating or updating the assistant and registering all eight tools --
against a real Vapi account, from the command line, idempotently. The
"Tool reference" and "Assistant reference" sections below still describe
every request/response shape and every value that goes on the assistant in
full, both because that is the spec the script implements and because it
is the fastest way to test one tool in isolation with `curl` or to
understand what a failure means -- read them whether or not you run the
script.

## 1. Give the location a tool secret

```bash
set -a && . ./.env.local && set +a
node scripts/set-agent-secret.mjs <location-id>
```

Prints the plaintext secret once. We store only its SHA-256 hash
(`locations.agent_secret_hash`) -- put the plaintext straight into Vapi's
tool headers and don't keep a second copy anywhere.

First run for a location needs no flag. Running it again against a
location that **already has a secret** is refused unless you pass
`--force`:

```bash
node scripts/set-agent-secret.mjs <location-id> --force
```

Read that refusal message before you reach for `--force`. Overwriting an
existing secret invalidates the old one **immediately, with no grace
period** -- the moment the new hash is written, every in-flight or
subsequent tool call still presenting the old secret starts failing auth
(401) for that location. There is no rotation path in this codebase that
avoids a window of failed calls: rotating on a live location means some
number of calls fail auth between the moment you run this and the moment
you've updated every tool's header in Vapi. Plan a maintenance window, and
update the Vapi tool headers as the very next step, not "later today."

A location whose `agent_secret_hash` is still `NULL` (nothing has ever been
provisioned) is never matched by any tool call -- `lib/agent/auth.ts`
excludes it explicitly, not just incidentally, so an unconfigured location
fails closed rather than accepting requests from nobody-in-particular.

## 2. Wire the assistant per call -- do not paste a static prompt

`POST /api/agent/assistant` (auth: `x-dialtone-secret`, empty body) returns
the system prompt, but it is not something you paste into a static
assistant configuration once and forget. The response carries
`assembled_at` and `expires_at` because the prompt has the current date,
time, and today's hours baked into its text at the instant this endpoint
runs:

```jsonc
{
  "ok": true,
  "assistant_enabled": true,
  "system_prompt": "You are answering the phone for Nonna Rosa...",
  "greeting": "Hi, thanks for calling Nonna Rosa! What can I get for you?",
  "fallback_number": "+15105550142",
  "kill_switch_on": false,
  "is_live": true,
  "assembled_at": "2026-08-12T19:03:11.482Z",
  "expires_at": "2026-08-12T19:08:11.482Z"   // assembled_at + 5 minutes
}
```

If a platform fetches this once at setup and reuses the same `system_prompt`
for every call afterward, the agent will keep telling callers today's date
is whatever day you happened to set it up, and will resolve "tomorrow" or
"Friday" against that same wrong day forever -- silently booking
reservations for the wrong date. `assembled_at` / `expires_at` let a
consumer detect that it is holding a stale copy. **They cannot make Vapi
fetch a fresh one.** That wiring is on you: configure this route as a
**per-call** assistant source, not a value copied into a field once.
Concretely, that means using whatever mechanism your voice platform offers
for building the assistant dynamically at call time (Vapi calls theirs an
`assistant-request` server webhook: your phone number has no assistant
attached, and Vapi POSTs to a server URL at the start of every inbound call
asking for one). If Vapi's current docs describe a different mechanism or a
different response envelope by the time you read this, follow those, not
this paragraph -- the load-bearing fact is "fetched fresh every call,"
not the exact webhook name.

Whatever mechanism you use, budget for it being time-constrained: Vapi
documents a hard ~7.5s end-to-end budget for answering an `assistant-request`
before the underlying telephony leg gives up. This endpoint does two
`await`ed Postgres reads (`hours`, `holidays`, run in parallel) before it
can respond -- fine under normal load, but it is one more reason a flaky
database is not a "keeps working, just slower" failure for this route.

**Fail closed, and check it.** If the location's kill switch is on, or the
location is not marked live, this returns:

```jsonc
{
  "ok": true,
  "assistant_enabled": false,
  "disabled_reason": "kill_switch",     // or "not_live"
  "system_prompt": null,
  "greeting": null,
  "fallback_number": "+15105550142",
  "kill_switch_on": true,
  "is_live": true
}
```

`assistant_enabled` is not advisory. Whatever wires this location to Vapi
**must** check it before doing anything else with the response -- there is
no code path in the route that produces a usable `system_prompt` for a
disabled location, and there must be no code path on your side that starts
an AI turn anyway because `system_prompt` happened to be truthy last time.
When it's `false`, route the call to `fallback_number` instead, the same
way `app/api/twilio/voice/route.ts` does for numbers still on the plain
Twilio path. `fallback_number` rides along in both the enabled and
disabled shapes specifically so you never have to make a second request to
find out where to send a call the AI can't take.

## 3. Provision the assistant and its tools

```bash
set -a && . ./.env.local && set +a
AGENT_SECRET=<secret from step 1> \
  node scripts/provision-vapi.mjs <location-id> <public-https-base-url>
```

This is the automated version of everything below in this section and in
"Assistant reference: what goes where" -- it fetches the config from step 2
with the secret from step 1, then creates or updates a Vapi assistant carrying the
system prompt, the greeting as `firstMessage`, temperature 0.3, and a
transfer destination, and registers all eight tools against
`<public-https-base-url>`, each with the `x-dialtone-secret` header and a
parameter schema matched against the routes themselves, not against prose.
It prints the assistant id at the end -- put that in `VAPI_ASSISTANT_ID`.

It needs `VAPI_PRIVATE_KEY` (from `.env.local`) to talk to Vapi, and
`AGENT_SECRET` -- the same plaintext step 1 printed -- as an environment
variable, never a CLI argument, so it never ends up in shell history or a
`ps` listing. Neither that secret nor `VAPI_PRIVATE_KEY` is ever printed,
by this script or into any log line, including inside `--dry-run` output.

**Idempotent.** Running it twice for the same location updates the same
Vapi assistant instead of creating a second one. "The assistant for this
location" means the one whose `metadata.dialtone_location_id` equals
`<location-id>` -- not its name, which a restaurant can rename and which
two locations could share, and not a locally-cached id, since this script
keeps no state of its own between runs. All eight tools (plus the native
transfer destination below) live inline on the assistant object itself and
are fully replaced on every run, so there is nothing separate to
deduplicate.

**Refuses a non-HTTPS or `localhost` base URL** with an explanation, unless
you pass `--dry-run`: Vapi places every one of these HTTP calls from its
own servers, not from wherever this script runs, so a `localhost` URL is
not reachable no matter how confidently `npm run dev` is running, and a
plain `http://` URL would put the tenant secret -- sent to fetch the
config in step 2 -- on the wire unencrypted. This is the single most
likely way to lose an hour here, so it is refused loudly up front instead
of failing silently the first time Vapi tries to call a tool.

**Refuses to provision a disabled location.** If step 2's response comes
back `assistant_enabled: false` (the kill switch is on, or the location
isn't live), this script stops rather than wiring Vapi to an assistant for
a location that has deliberately been told to keep calls off the AI --
pointing a working assistant at a live number would defeat that switch,
not merely leave it unused. It also refuses a location with no
`fallback_human_number` set, since `transfer_to_human` fails outright
without one and the assistant's transfer destination (below) would have
nowhere to point.

**`--dry-run`** prints the exact assistant payload it would send -- the
full system prompt, all eight tools, the transfer destination -- with the
secret redacted, and calls none of Vapi's write endpoints. It still fetches
the real config from step 2, so it is a genuine preview, not a mock; it
also still refuses a plain `http://` URL (the config fetch really happens
and really sends the secret), but it does allow `localhost`, specifically
so you can run this against `npm run dev` before a public URL exists.
Omit the flag to actually create or update the assistant; that is the
default.

**Two mechanisms move the call, not one.** `transfer_to_human` (below) is
a `function` tool like the other seven -- it hits `/api/agent/transfer`
and returns `{number}`, which is what the route's own docstring describes:
best-effort logging, with the number handed back first. A `function` tool
cannot itself move a live phone call; only Vapi's native `transferCall`
tool type can, and that type has no `function.name` to bind to
"transfer_to_human" (checked against Vapi's own OpenAPI schema while
writing this script -- `CreateTransferCallToolDTO` has no `function`
field). So this script also adds a second, unnamed `transferCall` tool
with a **static** destination -- `fallback_number` from step 2, baked in
at provisioning time rather than looked up from this app during the call.
That is deliberate, not a shortcut: the one thing this assistant does that
absolutely must still work when the rest of this app is degraded is
getting a caller to a person, so the mechanism that actually does that
must not itself depend on a webhook to this app succeeding mid-call.

## Tool reference: request and response shapes

Each is a tool with `POST` to your public base URL and the header
`x-dialtone-secret: <the secret from step 1>`. Every endpoint below speaks
plain JSON in, plain JSON out, with no envelope of our own -- whatever tool
mechanism you configure in Vapi is responsible for getting the model's
extracted arguments into that request body and the response back in front
of the model. Test each endpoint standalone with `curl` against the shapes
below before wiring it into Vapi at all; that isolates "the route is wrong"
from "the tool is configured wrong," which look identical from a failed
call.

Every successful response has `"ok": true`. Every route-level refusal
(bad input, not just a business answer like "sold out") has `"ok": false,
"error": "<sentence the agent should say>"` and a 4xx/5xx status. The
agent's system prompt never sees `ok`/`error`/status codes -- those are
between your tool wiring and this server; the prompt tells the model to
read `error` (or the relevant refusal field) as something to say, not to
parse.

| Tool | Endpoint | Body in | Notable responses |
|---|---|---|---|
| `get_menu` | `/api/agent/menu` | `{item?: string}` | `{categories, sold_out: string[], alternative: string \| null}`. Prices are **pre-tax** dollar strings (`"$12.00"`) -- see the tax gap below. `alternative` names an in-stock item from the category of whatever `item` matched -- never `item` itself -- and matching is on the words a caller says ("squid" finds Squid Ink Tonnarelli), the same matcher `place_order` builds a line with. It is filled whenever `item` matches anything at all; the prompt only reads it out when something is sold out. |
| `get_hours` | `/api/agent/hours` | `{}` | `{open_now, today, next_open}`. `today` is `"5:00 PM to 10:00 PM"` or `"closed"`. Hours that cross midnight cannot be represented -- see the gap below. |
| `check_availability` | `/api/agent/availability` | `{requested_at: ISO 8601, party_size: number}` | `{available, alternatives}`; `{available:false, reason:"large_party", alternatives:[]}` for a party over `max_party_size`; `{available:false, reason:"closed", hours_that_day, alternatives}` when the restaurant is shut at that time. Refuses (400) a past `requested_at` (2-minute clock-skew tolerance) or an unparseable date/party size, rather than answering `available:false` for either. Every string in `alternatives` has been checked -- see below. |
| `create_reservation` | `/api/agent/reservation` | `{requested_at, party_size, customer_name, customer_phone, provider_call_id?}` | `{booked:true, booking_id, when}`, `{booked:false, reason:"full"}`, `{booked:false, reason:"large_party"}` for a party over `max_party_size` -- the same reason `check_availability` gives, so the two agree about one party -- or `{booked:false, reason:"closed", hours_that_day}` for a time outside opening hours. Refuses (400) a past `requested_at` or an unparseable date/party size. Idempotent per `provider_call_id` -- see below. `when` includes the date, not just the weekday. |
| `cancel_reservation` | `/api/agent/cancel-reservation` | `{customer_name, customer_phone, booking_time: ISO 8601}` | `{cancelled:true, booking_id, when}` -- `when` is the cancelled booking's own time, with the date, in the location's timezone. `{cancelled:false, reason:"not_found"}` and `{cancelled:false, reason:"ambiguous"}` are ordinary answers the agent speaks or transfers on. Refuses (400) a `booking_time` that is already past or unparseable, or a missing name/phone. `booking_time` is *roughly* when the table is -- see the matching rule below. Retry-safe with no `provider_call_id`. |
| `change_reservation` | `/api/agent/change-reservation` | `{customer_name, customer_phone, booking_time: ISO 8601, new_requested_at: ISO 8601, new_party_size?: number}` | `{changed:true, booking_id, party_size, when}`. Ordinary refusals, booking untouched in every one: `reason` is `"not_found"`, `"ambiguous"`, `"full"`, `"large_party"`, or `"closed"` (with `hours_that_day`). Refuses (400) either timestamp being past or unparseable, a missing name/phone, or a `new_party_size` that isn't a positive whole number. Omit `new_party_size` to keep the party the booking already has. Retry-safe with no `provider_call_id`. |
| `place_order` | `/api/agent/order` | `{items:[{name, quantity, note?}], type?: "pickup"\|"delivery" (default "pickup"), customer_name, customer_phone, address?, provider_call_id?}` | See below -- this one has real edges. |
| `transfer_to_human` | `/api/agent/transfer` | `{reason?: string, provider_call_id?}` | `{number}` -- always `location.fallback_human_number`. Fails (500) if the location has no fallback number configured at all; make sure every live location has one before go-live. Logging the transfer is fire-and-forget (`after()`) so this responds even if the database is unhealthy. |
| `take_message` | `/api/agent/message` | `{caller_name, callback_number, message, provider_call_id?}` | `{taken: true}` -- the message is in the `messages` table and shows on the call's page in the dashboard. Refuses (400) with a sentence to read out when any of the three is missing or could not be heard: an unusable name, a callback number with fewer than seven digits, or nothing to pass on. `message` is redacted and truncated to 400 characters before storage. There is no business refusal on this path -- there is no such thing as a message the restaurant may not receive. |

**`take_message` is not in the provisioning script or the system prompt
yet.** The route and its table exist and are live; wiring it into the
assistant -- and narrowing `transfer_to_human` to catering and allergy
questions, which is the reason this tool exists -- is the next change.
Until then it can be exercised with `curl` against the shape above.

`requested_at` must be a full ISO 8601 timestamp. The system prompt is
told the current date and time as part of `system_prompt` itself (see step
2) and is expected to resolve "tomorrow at seven" against that.

### Alternatives, and opening hours

`check_availability`'s `alternatives` are spoken strings (`"7:30 PM"`,
`"tomorrow at 1:15 AM"` when one crosses midnight) at up to 90 minutes
either side of the requested time, nearest first. **Each one has been put
through the same three tests the requested time was**: it is not in the
past, the restaurant is open then, and there are seats for this party at
that moment (the same peak-occupancy sweep, over bookings fetched wide
enough to cover every candidate). If none survive, the list is empty --
the agent offers nothing rather than a time nobody checked. Previously
these were `requested_at ± 30 minutes` with nothing checked at all, which
at 6:45 PM offered "6:40 PM" for a 7:10 request and `create_reservation`
then refused it as already past.

Both reservation endpoints and `place_order` consult `hours` and
`holiday_hours` (holiday rows override the weekday row) in the location's
timezone:

- `create_reservation` refuses a booking for a time the restaurant is
  shut, with `reason: "closed"` and `hours_that_day` (`"5:00 PM to 10:30
  PM"`, or `"closed"` for a day it never opens) so the agent can offer the
  real hours back instead of only saying no.
- `place_order` refuses with the same shape when the kitchen is shut **at
  the moment of the call** -- an order has no requested time other than
  now. It checks after it has understood the request, so "I didn't catch
  how many" and "we're out of that" still come first.
- Both **abstain** rather than refuse when the hours cannot be read: a
  location whose hours cross midnight (see the gap below) or one with no
  `hours` rows at all. Refusing everything at a late-night kitchen because
  its 22:00–02:00 row cannot be represented would be a worse outage than
  the 3 AM order this prevents.

What this does *not* model: last seating (a booking is allowed right up to
the closing minute), and a promise time that runs past close (an order at
10:20 PM with a 25-minute promise is accepted by a kitchen closing at
10:30).

Pass `provider_call_id` (Vapi's own id for the call in progress) on every
`create_reservation`, `place_order`, and `transfer_to_human` call if your
tool configuration can supply it. Two things depend on it:

- **`place_order` and `create_reservation` both deduplicate on it.** Each
  fingerprints the call together with what makes the request distinct, and
  a retry returns what already exists rather than writing a second row.
  This is what makes it safe for an LLM to retry either tool after a
  timeout.
  - `place_order`: `provider_call_id` + type + customer + address +
    items (order independent).
  - `create_reservation`: `provider_call_id` + `requested_at` +
    `party_size` + customer name + phone. A retry gets the same
    `booking_id` and the same spoken confirmation back; two *different*
    calls asking for the same slot still get two bookings, because the
    call id is part of the key.

  Without a `provider_call_id` there is no fingerprint and no protection:
  every call, retry or not, writes a new order or holds another table. For
  reservations that is worse than a duplicate record -- a phantom booking
  holds seats for the whole slot, so the restaurant's own occupancy count
  turns away a genuine caller for a table nobody is coming to. Send the id
  on every call.
- **It's how a tool call gets linked back to the `calls` row** for that
  conversation (`lib/agent/context.ts::callIdForProvider`), which is what
  lets an order or a transfer show up attached to the right call in the
  dashboard rather than as an orphan.

### Finding the caller's booking, and what that refuses

`cancel_reservation` and `change_reservation` both identify a booking the
same way, in `public.cancel_booking` / `public.change_booking`
(`supabase/migrations/20260812000800_cancel_change_reservation.sql`). The
obvious key would be the phone number plus roughly when the table is.
**That key is not safe.** A phone number is not a secret -- it is on a
business card, in a group chat, on a delivery receipt, and in the caller ID
of everyone that person has rung -- so anyone holding one could ring up and
empty a stranger's table, silently, with the restaurant believing the guest
cancelled.

A booking is matched only when **all** of these line up:

- **the location**, taken only from the secret the tool call authenticated
  with (`lib/agent/auth.ts::locationForSecret`), never from a request body;
- **the phone number** on the booking, compared on its last ten digits, so
  `+1 (510) 555-1014` and `5105551014` are one number;
- **the first name** on the booking, case- and punctuation-insensitively --
  a caller says "it's Marcus", not "Marcus Webb";
- **roughly when it is** -- within one `reservation_slot_minutes` either
  side of `booking_time`. A person says "around seven"; the slot is the
  unit this restaurant already keeps its book in, and it is read off the
  location row, never sent by the caller;

and only among bookings that are still `requested`/`confirmed` **and still
in the future**.

What that refuses, which is the part worth knowing:

- a phone number on its own, however obtained -- without the name *and*
  roughly when, nothing matches. Same for a name on its own;
- **any booking at any other restaurant.** The location comes from the
  secret, so another tenant's booking is not merely refused, it is
  invisible -- even given a perfect name, number and time;
- **a booking that has already happened.** Enforced twice: the routes
  refuse a past `booking_time` outright (400, same 2-minute clock-skew
  tolerance as everywhere else), and the SQL will not match a past
  `requested_at` even from a future-looking hint;
- a booking already cancelled, seated, or marked no-show;
- **anything where more than one booking could be the one meant.** Nothing
  is written and the answer is `reason: "ambiguous"`, so the agent hands
  the call to a person. Guessing here cancels a table belonging to someone
  who is not on the phone.

This is not identity proof and is not sold as one. It raises the bar from
"knows a phone number" to "knows the number, the name, and the evening",
and every case it cannot settle ends with a human rather than a guess. Two
people called Marcus on one number the same evening are the *ambiguous*
case, not an authentication decision.

**Neither tool needs `provider_call_id`**, unlike `create_reservation` and
`place_order`. A retried cancel finds the cancellation it already made and
answers with it; a retried change finds the booking where it already moved
it. Both say exactly the same sentence the first call said, so no
fingerprint is needed to make an LLM retry safe here.

**Changing a booking is a capacity question, not an edit.** A move is
checked against everything a new booking is checked against -- the new time
must be in the future, inside opening hours, within `max_party_size`, and
have seats -- and the release of the old slot and the claim on the new one
are a single `UPDATE` under the same per-location advisory lock
`book_table` takes. There is no instant at which the caller has given up
their table and not yet got the new one, and a refused change leaves the
booking exactly where it was.

### `place_order` in detail

The write is one transaction (`public.place_order`) -- pricing, the
sold-out check, and both inserts (`orders`, `order_items`) commit together
or not at all, so a failure partway through can never leave a priced order
with no food on it.

**On success**, `200`:

```jsonc
{
  "ok": true,
  "placed": true,
  "order_number": 1002,
  "total": "$44.00",         // tax-inclusive, see below
  "promised_minutes": 25,    // location.pickup_promise_minutes or
                             // location.delivery_promise_minutes, by type
  "staff_notified": true     // did the ticket actually reach a human?
}
```

**`staff_notified: false` is the one success you must not treat as one.**
The order is committed and real -- that is what `placed: true` means, and
it stays true. What failed is the only path from that order to a person:
the staff SMS (`lib/agent/notify.ts`), which returns false when
`order_sms_to` or `twilio_number` is unset for the location, when Twilio
rejects the message, and when the request to Twilio never completes. There
is no second channel behind it -- `app/dashboard/orders/page.tsx` is still
a stub ("Not built yet"), so nothing else is watching. The kitchen does
not know this order exists.

**What the agent must do:** do not sign off. The order is in, so it must
not be placed again -- retrying writes nothing new anyway (the
`provider_call_id` fingerprint dedupes it) but the caller must not be
asked to reorder either. Tell them the order is in and that you want
someone there to confirm it, then call `transfer_to_human`. The system
prompt carries exactly this instruction ("If it goes through but says the
kitchen was not reached, do not sign off. Say the order is in and you want
someone to confirm it, then transfer.") -- your tool wiring only has to
put the response in front of the model.

Handing the call to a person is the only answer that is true at that
moment: the order exists, and the person who has to cook it has not been
told. Ending on "you're all set" is a promise nobody at the restaurant is
in a position to keep, and the caller finds out when they arrive for food
that was never started. Ending on "sorry, that didn't work" would be the
opposite lie -- the order is in the database and will be cooked the moment
anyone looks -- and would send the caller off to order again somewhere
else, or to place a second order that the fingerprint would then have to
untangle.

The outcome is also written to the order itself, so it outlives the call:
`orders.staff_notified` / `orders.staff_notified_at`
(`supabase/migrations/20260812000700_staff_notification.sql`). That is the
query to run when someone asks what the restaurant has missed:

```sql
select order_number, placed_at, customer_name, total_cents
  from orders
 where location_id = '<location>' and not staff_notified
 order by placed_at desc;
```

Rows written by anything other than this route (the dashboard, the Python
agent) stay `false`, because nothing tells them otherwise -- read it as
"no staff SMS was confirmed for this order", not as "this order is
broken".

`promised_minutes` is what gets spoken to the caller, written to
`orders.promised_at`, and printed on the kitchen ticket
(`#1002 PICKUP - 25 min`, `lib/agent/notify.ts`) -- the same number in all
three places, always. It comes from the location's own
`pickup_promise_minutes` / `delivery_promise_minutes` column
(`supabase/migrations/20260812000600_promise_minutes.sql`), picked by the
order's `type`, never a constant. Set both to a number this kitchen can
actually hit -- see the checklist item below.

**Per-item changes.** Each item may carry a `note`: the change the caller
asked for on that line, as they said it ("no onions", "sauce on the
side"). It is free text and it is **not priced** -- see the sizes and
modifiers gap below, which this does not close. It is stored on the line
it belongs to (`order_items.modifiers`, as a one-element JSON array) and
printed under that line on the kitchen ticket:

```
#1002 PICKUP - 25 min
1x Margherita
  * no onions
2x Bucatini Amatriciana
Total $44.00
```

Send it per item, never pooled onto the order: a note without a line is a
cook guessing which plate it meant. A note that is not a string, or is
longer than 200 characters, is refused (`agentFail`, 400) rather than
dropped -- the caller heard the agent confirm that change back, so
quietly cooking without it is the one outcome that must not happen.
Card-number-like digit runs in a note are redacted before it is stored or
texted (`lib/agent/redact.ts`).

**"Which one did you mean" is not "we don't have that".** A spoken word
that matches more than one menu item answers `reason: "ambiguous_item"`
with `options`, the full list of names it could have meant, and `item`
set to what the caller actually said:

```jsonc
{
  "ok": true,
  "placed": false,
  "reason": "ambiguous_item",
  "item": "fries",                                  // what they said
  "options": ["Hand Cut Fries", "Cheese Fries"]     // what it could mean
}
```

The agent's job here is to ask ("hand cut or cheese fries?") and re-send
the order with the name it is given -- an exact whole name always wins,
so the second attempt goes straight through. Nothing is written, and no
part of the order is kept: send the whole `items` array again.

This was `unknown_item` until this branch, and at a burger restaurant --
where "fries" is most of the calls -- that made the agent apologise for
not selling fries and hand the call to a human. The rule that produced it
has not changed: the route still refuses to pick between two items,
because a wrong item on a kitchen ticket costs more than one more
question. What changed is that it now says which question to ask.
`options` is never truncated -- an option the agent is not told about is
one the caller cannot choose -- so at a menu with eight pizzas, "pizza"
returns eight names, and the agent should narrow it rather than read the
list.

Refusals fall into three shapes, and the model needs
to treat them differently:

- **Ordinary business answers**, `agentOk({placed:false, reason, item?})`,
  200: `reason` is `"unknown_item"`, `"ambiguous_item"` (with `options`,
  above), `"sold_out"`, `"no_delivery"` (delivery
  asked for at a pickup-only location), `"no_pickup"` (the reverse), or
  `"closed"` (with `hours_that_day`) when the kitchen is shut right now.
  These are things a host says out loud without anything having gone
  wrong.
- **Requests the route can't make sense of**, `agentFail`, 400:
  missing/empty `items`, missing `customer_name`/`customer_phone`, an
  unparseable `type`, delivery with no `address`, a quantity that isn't a
  positive whole number ("two" is not accepted -- only a number or a
  numeric string), a `note` that isn't text or runs past 200 characters,
  more than 40 distinct line items, or more than 50 of one item. The last
  two refusals also tell the agent to offer a transfer, since that's a
  catering order, not a phone order.
- **A drift bug**, `agentFail`, 500, logged server-side: `public.place_order`
  can return other reasons (`unknown_location`, `invalid_type`,
  `missing_address`, `missing_customer`, `no_items`, `mismatched_lines`,
  `bad_quantity`, `bad_note`, `bad_promise`) that the route's own validation is
  supposed to catch before ever calling it. Seeing one in production means
  the route and the function have drifted apart, not that the caller did
  anything wrong -- that's why it's a 500 and not a spoken sentence.

`total` in a successful response (`"$14.30"`) **includes tax**.
`place_order` works it out server-side, in integer cents, as `subtotal +
round(subtotal * tax_rate_bps / 10000)`, from prices it reads out of
`menu_items` itself and a rate it reads off the `locations` row. Neither a
price nor a tax rate is ever sent by the client -- the function has no
argument for either, which is what "prices from the live menu, never from
what the agent believes an item costs" has to mean once the write lives in
the database. `get_menu`'s prices are **pre-tax**. See the tax gap below
for what that difference means for the prompt's read-back step.

## Assistant reference: what goes where

`scripts/provision-vapi.mjs` (step 3) sets all four of these on every run.
By hand, in the Vapi dashboard or API:

- **System prompt:** `system_prompt` from step 2, fetched fresh every call.
- **First message:** `greeting` from the same response, spoken exactly as
  fetched -- do not let the model generate it, a generated greeting costs
  a second of silence at the top of every call (`buildGreeting` in
  `lib/agent/prompt.ts` is the text of record; it falls back to a generic
  greeting if the location hasn't set `greeting_text`). The script sets
  Vapi's `firstMessageMode` to `assistant-speaks-first` to guarantee this
  half; turning the text into a **pre-recorded audio file** so it starts
  instantly rather than waiting on Vapi's own TTS is a further
  optimisation the script does not do, since it would need a separate
  TTS-and-hosting step of its own.
- **Temperature:** 0.3. Boring and consistent, not creative.
- **Transfer destination:** `fallback_number` from the same response. See
  "Two mechanisms move the call, not one" in step 3 for why this is a
  second, native Vapi tool alongside `transfer_to_human` below, not the
  same tool wired twice.

## 4. Point the number at it

Twilio number → Vapi phone number import → assign the assistant (or the
dynamic-assistant wiring from step 2, if that's how you set it up).

Keep our `/api/twilio/voice` webhook for numbers that are not on Vapi yet;
the two paths do not conflict -- that route still greets, optionally
records, and forwards straight to a human, unconditionally, with no AI
involved at all.

## 5. Prove it before a real caller does: `scripts/exercise-tools.mjs`

```bash
node scripts/set-agent-secret.mjs a10c0000-0000-0000-0000-00000000000a
AGENT_SECRET=<secret printed above> \
NEXT_PUBLIC_SUPABASE_URL=<same value your .env.local uses> \
SUPABASE_SERVICE_ROLE_KEY=<same value your .env.local uses> \
  node scripts/exercise-tools.mjs [base-url]
```

`base-url` defaults to `http://localhost:3000`; point it at a deployed URL
to exercise a real deployment instead of a local one. `AGENT_SECRET` must
be the secret for the seeded demo location
(`a10c0000-0000-0000-0000-00000000000a`) -- the script's checks read that
location's real menu, hours, and tax rate and compare the route's answers
against numbers it computes itself, independently, from the same database
rows.

This is not a smoke test against a mock. It is self-contained: it
provisions its own six throwaway locations (one for cross-tenant
isolation, one with the kill switch on, one not live, one shut every day
of the week, and two open 9 to 5 with exactly two seats), drives every
tool through them and the demo location, and deletes them again in a
`try/finally` that runs even if a check throws partway through -- so
running it twice in a row starts from the same state both times.

The last two exist because the routes read opening hours before taking a
booking or an order, and an assertion about that has to be pinned to hours
the script controls rather than to what time of day it happens to run. The
demo location's own hours are used for what they really say: its bookings
are made inside them, and the one check that must happen "now" -- placing
an order -- asserts the route agrees with those hours either way, so a run
at 3 AM proves the refusal and a run at 7 PM proves the order. It
finishes by snapshotting the demo location's orders, order_items,
bookings, calls, order_status_events, and menu_items before and after and
asserting they are byte-for-byte identical, proving its own writes were
fully cleaned up.

It runs 71 checks, including: auth (missing/wrong secret, on a read and
on all four write endpoints), cross-tenant isolation on both `get_menu` and
`place_order` (a second tenant's secret can see only its own menu and
cannot order off another tenant's menu), sold-out vs. unknown-item as
distinct refusals, order-size limits, an unparseable quantity refused as a
sentence rather than a menu decision, a retried `place_order` call
deduplicating to one order, a retried `create_reservation` call returning
the same booking (with the `bookings` table itself checked for a second
row), two different calls booking the same slot still creating two, and
the same pair of calls *without* a `provider_call_id` correctly not
deduplicating, tax rounding pinned against two quantities chosen to land
on opposite sides of a half cent, past-time refusals on both
`check_availability` and `create_reservation`, an oversized party answered
with `large_party` by both, and the assistant endpoint failing closed on
the kill switch and on "not live" independently.

It also covers, since the review that produced them: a per-item change
landing in `order_items.modifiers` on the line it belongs to and on no
other, a card number spoken into that change being redacted before it is
stored, an over-long change refused as a sentence, a corrected order not
being swallowed as a retry of the uncorrected one, `staff_notified: false`
on an order nobody could be texted about (with the row agreeing), a
booking and an order both refused at a closed restaurant with nothing
written, alternatives for a closed time being the nearest times the place
is really open, alternatives for a full slot excluding the times that are
full, the offered alternative actually being bookable, the booking
confirmation naming the date, and `get_menu` answering a spoken word
("squid") with an in-stock alternative.

And, since `cancel_reservation` and `change_reservation` shipped: a
booking cancelled from a bare first name, an unpunctuated number and a
time twenty minutes off the real one; the seats actually coming back
(`check_availability` on that slot flipping from full to open); a retried
cancel saying exactly the same sentence and writing nothing new; **the
right number with the wrong name refused, and the table still confirmed**;
**another tenant's secret refused on a booking it described perfectly**;
two bookings that could both be the caller's answered `ambiguous` with
neither touched; a booking half an hour in the past invisible to a
future-looking hint, and a past `booking_time` refused as a sentence
before any lookup; a change moving the one row rather than writing a
second; and a change into a slot with no seats refused `full` with the
booking still exactly where it was -- plus the closed-hours, past-time and
over-max-party refusals on the same endpoint, each leaving the booking
alone.

**It must pass, completely, against the environment you're about to point
Vapi at, before that environment takes a real call.** A failure here is
not "fix it later" -- it means one of the guarantees this document assumes
(tenant isolation, exact pricing, no duplicate orders) does not actually
hold in that environment.

## Known gaps

These are real, current limitations of the running code, not hypothetical
edge cases. A restaurant will hit some of these; know which ones before
you onboard one.

- **Hours that cross midnight cannot be represented.** `openState`
  (`lib/agent/hours.ts`) compares minutes-of-day: `open_now = local.minutes
  >= opens && local.minutes < closes`. A kitchen open 22:00–02:00 has
  `closes` (120) less than `opens` (1320), so that condition is false for
  every minute of every day -- `get_hours` and the assistant's baked-in
  "hours today" both report the location closed, always, even while it is
  genuinely open. The hours gate on `create_reservation` and `place_order`
  detects this case (`close <= open`) and abstains rather than refusing,
  so such a location can still take bookings and orders -- but the agent
  is still being told, and still telling callers, that it is closed. Do
  not onboard a location whose hours cross midnight until this is fixed;
  if one already exists, split the hours row or don't rely on this for it.
- **Cancelling and changing a booking depend on the caller remembering
  their own booking.** Both tools now exist, but the only way in is the
  name, the number and roughly when (above). A caller who booked under a
  different name, gave a different number, or genuinely cannot say what
  evening it was gets `not_found` and a transfer -- correctly, but the
  restaurant still ends up answering the phone for them. There is no
  booking reference to read out, because nothing in this product ever
  gives the caller one.
- **The spoken order total is pre-tax; the recorded one is not.** The
  prompt has the agent read the order back before calling `place_order`,
  and the only source it has for prices at that moment is `get_menu`,
  which returns **pre-tax** prices. `place_order`'s own total includes tax,
  computed server-side from `locations.tax_rate_bps`. Rather than plumb a
  tax rate into the menu and hope the model does the arithmetic reliably
  mid-conversation, the prompt now says the quoted total is before tax
  ("read the whole order back with the total, say that total is before
  tax"). At a location with a nonzero tax rate the caller therefore hears
  a smaller number than they will pay, described as such. That is a
  deliberate trade, not a fix: if a restaurant needs the exact due amount
  spoken, this needs a tax-aware price source before you onboard them.
- **The promised pickup/delivery time is a fixed number per location and
  order type, not a load-aware one.** `place_order` no longer hands every
  caller the same 25 minutes regardless of restaurant -- it reads
  `locations.pickup_promise_minutes` / `delivery_promise_minutes`
  (`supabase/migrations/20260812000600_promise_minutes.sql`) and picks by
  order type, so a kitchen that actually runs 45-minute tickets can say
  so. What it still does not do: change that number for how backed up the
  kitchen is *right now*, how large this particular order is, or the time
  of day. A location that is normally fast but slammed on a Friday night
  will still promise its configured Friday-morning number to a caller at
  8pm. Nothing in this system reads current order volume or measures
  actual fulfillment time to adjust the promise automatically -- an owner
  has to notice they're running behind and change the two columns by
  hand.
- **The staff SMS is still the only channel, and nothing retries it.**
  `staff_notified` (above) makes a failed ticket visible in the response,
  on the order row, and to the caller -- who gets handed to a person. What
  it does not do is deliver the order: there is no retry, no queue, no
  second notification path, and no orders dashboard to fall back on
  (`app/dashboard/orders/page.tsx` is a stub). A location whose
  `order_sms_to` is wrong will transfer every single food call to a human,
  which is safe and completely useless. Check that column before go-live,
  not after.
- **Nothing answers a parking question, and nothing texts a caller.**
  Both promises are out of the prompt: there is no parking field anywhere
  in the schema, and no path in this system sends a message to a customer
  (`lib/agent/notify.ts`'s only outbound message is the order ticket to
  the restaurant's own staff number). Removing the wording means both
  questions now fall through the prompt's "anything outside these four
  things" rule to a transfer, instead of being improvised. Parking could
  be added as a location field; **texting a caller is a different legal
  problem from the staff ticket and must not be built** on the strength of
  this line.
- **Two identical bookings inside one call collapse into one.**
  `create_reservation`'s fingerprint ("Tool reference" above) cannot distinguish a
  retried tool call from a caller genuinely asking for a second table at
  the same time, for the same party size, under the same name and number,
  in the same phone call -- the two requests are byte-identical, so the
  second is treated as a retry and returns the first booking.
  `place_order` makes exactly the same trade. In practice a party needing
  two tables at one sitting is a party big enough to want a person, and
  the agent transfers; but if a restaurant genuinely takes such bookings
  over the phone, know that this one case is deduplicated.
- **No secret rotation without a call-failure window.** Covered in step 1.
  Worth repeating here: there is no code path in this system that rotates
  a live location's secret without some number of calls failing auth in
  between.
- **Card-number redaction covers two write paths, and the SMS is not one
  of them.** `redactCardNumbers` (`lib/agent/redact.ts`) scrubs
  `transfer_reason` and each item's `note` before either is written.
  Nothing else is scanned -- and the fields that are not scanned still
  **leave this system**: `customer_name`, `customer_phone` and the
  delivery `address` go into the body of the staff SMS exactly as the
  agent sent them, which means they go to Twilio, and from there to a
  phone. A caller who reads a card number out while giving their name or
  their address ("it's 4111 1111 1111 1111 — sorry, wrong thing") has it
  stored on the order and texted out, unredacted. A future
  `calls.transcript` column is in the same position (the schema already
  has a comment promising redaction; no writer for that column exists
  yet). If you enable Twilio call recording or any transcript storage for
  a Vapi-held call, a caller who reads a card number out loud during an
  order rather than a transfer is not protected by anything here today.
- **Recording retention is not enforced.** `recording_retention_days`
  exists on `locations` but nothing deletes a recording once it's past
  that many days.
- **Sizes and modifiers aren't priced.** `place_order` now carries a
  free-text `note` per item through to `order_items.modifiers` and onto
  the kitchen ticket, so a change the caller asked for reaches the cook --
  but it is text, and nothing else. No note changes the subtotal, the tax,
  or the total; `get_menu` still exposes neither sizes nor priced
  modifiers, and the menu schema's own size/modifier structures are still
  unread by any endpoint. A caller who orders "a large" is charged the
  base-size price and the kitchen sees the word "large" on the ticket. Do
  not onboard a menu where size or modifiers change the price -- most
  pizza and coffee menus -- until pricing for them ships.

## Before you go live with a real restaurant

Work through this list. Every line is a way these break in the field.

- [ ] Call it yourself twenty times. Order weird things. Interrupt it. Mumble.
- [ ] Ask for something sold out. It must offer the nearest available item, not just say no.
- [ ] Have someone with an accent call it. This is where these break.
- [ ] Test with the kitchen loud in the background.
- [ ] Mention an allergy. It must transfer immediately without answering.
- [ ] Offer a card number. It must refuse and never repeat it back.
- [ ] Confirm the transfer works with the app stopped -- kill `npm run dev` and call.
- [ ] Toggle an item sold out mid-call on the manager screen, then call again and confirm the next call knows.
- [ ] Try to make it quote a wrong price. If you can, so can a customer.
- [ ] Ask it something outside the four things it does. It must transfer.
- [ ] Run `scripts/exercise-tools.mjs` against the environment Vapi will actually hit, and confirm all 71 checks pass. Don't onboard on top of a red run.
- [ ] Run `scripts/provision-vapi.mjs <location-id> <base-url>` (no `--dry-run`) against that same environment, put the printed assistant id in `VAPI_ASSISTANT_ID`, and attach that assistant to this location's number.
- [ ] Confirm your Vapi wiring fetches `/api/agent/assistant` **fresh at the start of every call**, not once at setup. Leave the integration alone overnight and call it again the next morning; it must state the correct date and today's real hours, not yesterday's.
- [ ] Flip the location's kill switch on the dashboard mid-session and call again immediately. The very next call must not reach the AI -- confirm it lands on a human, not just that `/api/agent/assistant` reports `assistant_enabled:false` in isolation.
- [ ] Set the location live to `false` and confirm the same thing happens for that condition independently of the kill switch.
- [ ] Confirm `fallback_human_number` is set and correct for this location. `transfer_to_human` fails outright without one, and it's the destination for both the kill switch and every AI-initiated transfer.
- [ ] Check the location's hours don't cross midnight (e.g. open past 12am). If they do, `get_hours` and the assistant will report the location closed at every hour, forever -- see the gaps above.
- [ ] **Try to book a table outside opening hours**, and try to book one on a day the restaurant is closed. Both must come back as "we're closed then" with the day's real hours offered, not as a confirmed booking. Then check the `bookings` table: a refused booking must not be in it. Do this against this location's actual `hours` rows, not the demo location's -- a wrong `hours` row is invisible until someone books against it.
- [ ] **Take an offered alternative time.** Ask for a time that is full or outside hours, listen to the alternatives the agent offers, and then book the one it named. It must go through. An alternative the agent offers and `create_reservation` then refuses is the single worst thing this endpoint can do to a caller -- it is the agent contradicting itself, out loud, about a promise it just made.
- [ ] Confirm the menu at this location doesn't depend on size or modifiers for price (no "small/large", no "add bacon +$2"). If it does, don't launch until that's supported -- today it prices everything at the base rate.
- [ ] **Order something modified, then read the ticket that comes out.** Say "no onions" (or "sauce on the side") on one item of a two-item order, let the agent confirm it back, and then look at the SMS that lands on the staff phone. The change must be on the ticket, under the item it belongs to and not under the other one. This is the one thing no automated check can prove end-to-end: whether the model actually put what it heard into that item's `note` instead of narrating it and moving on. If the ticket says `1x Margherita` and the caller was told "got it, no onions", the caller gets the wrong food and nobody finds out until they're eating it.
- [ ] Place a real test order and confirm the SMS ticket actually lands on the staff phone (`order_sms_to`) from the right Twilio number (`twilio_number`). The order itself still succeeds if this fails -- but the response now says `staff_notified: false`, `orders.staff_notified` stays false, and the agent is supposed to hand the caller to a person rather than sign off. Confirm both halves: that the text arrives when the config is right, and (unset `order_sms_to` on a throwaway location and order again) that the agent transfers instead of saying "you're all set" when it doesn't.
- [ ] Order something at a location with a nonzero tax rate and listen for whether the spoken total (read back before you confirm) matches the total in the confirmation / on the dashboard. If they differ, decide whether that's acceptable for this restaurant before launch -- see the tax gap above.
- [ ] **Book a table by phone, then ring back and cancel it.** Give the first name and the number the way a person actually says them, and say the time roughly ("around seven") rather than exactly. It must cancel it and read the booking's own date and time back. Then check the row: `status` must be `cancelled`, and `check_availability` for that slot must report the seats free again -- a cancellation that only flips a column and does not give the seats back is worse than no cancellation, because the restaurant then turns away the caller who could have had that table.
- [ ] **Cancel the same booking twice in one call.** Force a second attempt if you can. The agent must say the same thing both times and there must still be exactly one row. It must never tell a caller "I can't find that booking" seconds after cancelling it.
- [ ] **Try to cancel somebody else's table.** Ring up with a real booking's phone number and the wrong first name, and again with the right name at a time nowhere near the real one. Both must fail to find it, and the booking must still be `confirmed` afterwards. If either one succeeds, stop: anyone who has ever seen this restaurant's caller ID can empty its book.
- [ ] **Make two bookings the same evening under one name and number, then ring to cancel "the booking".** It must not pick one. It must hand you to a human with nothing cancelled.
- [ ] **Ring back about a table that has already passed.** It must not cancel or move it. A booking that has already happened is not the caller's to rewrite, and the restaurant's record of the night depends on that.
- [ ] **Change a booking to a time that is full, to a time the restaurant is shut, and to a party bigger than `max_party_size`.** All three must be refused with the booking left exactly where it was -- then check the row to be sure it did not move. A change is a capacity decision, not an edit, and a move that half-happened costs a table twice.
- [ ] **Change a booking to a genuinely open time and confirm it moved rather than duplicated.** One row, new time, and the old slot bookable again by someone else.
- [ ] Ask about parking, and ask it to text you a payment link. Both are now outside the four things it does, so it must transfer rather than answer -- there is no parking data anywhere in this system and nothing that texts a customer. If it names a car park or promises a link, the prompt has drifted back.
- [ ] Confirm your Vapi tool configuration actually sends `provider_call_id` on `create_reservation`, `place_order` and `transfer_to_human`. It is the whole of the retry protection on the first two, and how a transfer gets logged against the right call on the third: without it a retried booking holds a second table, which costs the restaurant real capacity for that slot. `scripts/provision-vapi.mjs` sends it as a static parameter (`{{call.id}}`) on all three, so this should already be true if you provisioned with the script -- confirm it anyway. If your configuration can force a retry (timeout, network blip), force one against `create_reservation` and confirm the dashboard shows one booking, not two.
- [ ] Rotate the location's secret (`--force`) once, on purpose, during a maintenance window, so whoever runs this in production has done it before they have to do it under pressure. Confirm calls fail during the gap, then re-run `node scripts/provision-vapi.mjs <location-id> <base-url>` with the new `AGENT_SECRET` to push it into every tool's header, and confirm calls recover.
- [ ] Set `locations.pickup_promise_minutes` and `locations.delivery_promise_minutes` to numbers this kitchen can actually hit -- ask whoever runs the pass, not the owner guessing from a good night. Every location starts on the defaults (25 / 45) until someone changes them; an owner who leaves the defaults is promising times they cannot keep, and the customer who believed it shows up angry at the restaurant, not at this checklist. Neither number adjusts for how backed up the kitchen is right now -- see the gap above -- so revisit both if this location's actual ticket times change.
