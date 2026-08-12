# Wiring a restaurant to Vapi

Inbound only. Nothing here originates a call.

This app exposes seven HTTP endpoints under `app/api/agent/`: six tools the
agent calls mid-conversation, and one config endpoint (`/assistant`) that
hands Vapi the system prompt for a call before it starts. Vapi (or whatever
holds the call) is the thing that actually talks to the caller, decides
when to call a tool, and reads the tool's answer out loud. Everything below
was checked against the routes and their tests as of this writing, not
against the product spec -- read `app/api/agent/*/route.ts` yourself before
trusting a detail that matters to you, especially anything about Vapi's own
wire format, which is outside this repo and can change under us.

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

## 3. Create the six conversational tools

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
| `get_menu` | `/api/agent/menu` | `{item?: string}` | `{categories, sold_out: string[], alternative: string \| null}`. Prices are **pre-tax** dollar strings (`"$12.00"`) -- see the tax gap below. `alternative` is filled only when `item` matches something sold out. |
| `get_hours` | `/api/agent/hours` | `{}` | `{open_now, today, next_open}`. `today` is `"5:00 PM to 10:00 PM"` or `"closed"`. Hours that cross midnight cannot be represented -- see the gap below. |
| `check_availability` | `/api/agent/availability` | `{requested_at: ISO 8601, party_size: number}` | `{available, alternatives}`, or `{available:false, reason:"large_party", alternatives:[]}` for a party over `max_party_size`. Refuses (400) a past `requested_at` (2-minute clock-skew tolerance) or an unparseable date/party size, rather than answering `available:false` for either. |
| `create_reservation` | `/api/agent/reservation` | `{requested_at, party_size, customer_name, customer_phone, provider_call_id?}` | `{booked:true, booking_id, when}` or `{booked:false, reason:"full"}`. An over-max party gets the **same** generic 400 as a garbled party size ("I didn't catch how many people") -- unlike `check_availability`, this route does not distinguish "too big" from "didn't understand." **Not idempotent** -- see the gap below. |
| `place_order` | `/api/agent/order` | `{items:[{name, quantity}], type?: "pickup"\|"delivery" (default "pickup"), customer_name, customer_phone, address?, provider_call_id?}` | See below -- this one has real edges. |
| `transfer_to_human` | `/api/agent/transfer` | `{reason?: string, provider_call_id?}` | `{number}` -- always `location.fallback_human_number`. Fails (500) if the location has no fallback number configured at all; make sure every live location has one before go-live. Logging the transfer is fire-and-forget (`after()`) so this responds even if the database is unhealthy. |

`requested_at` must be a full ISO 8601 timestamp. The system prompt is
told the current date and time as part of `system_prompt` itself (see step
2) and is expected to resolve "tomorrow at seven" against that.

Pass `provider_call_id` (Vapi's own id for the call in progress) on every
`create_reservation`, `place_order`, and `transfer_to_human` call if your
tool configuration can supply it. Two things depend on it:

- **`place_order` deduplicates on it.** A retried tool call with the same
  `provider_call_id`, type, customer, address, and items (order
  independent) returns the order that already exists instead of writing a
  second one -- this is what makes it safe for an LLM to retry a `place_order`
  call after a timeout. Without a `provider_call_id`, there is no
  fingerprint and no protection: every call, retry or not, writes a new
  order. **`create_reservation` has no equivalent.** `public.book_table`
  has no idempotency key at all, so a retried `create_reservation` call
  --  a timeout, a Vapi-side retry, anything that makes the model call the
  tool twice for the one booking -- creates two bookings for the same
  party. Test your platform's retry behavior specifically against this
  route before launch (see the checklist).
- **It's how a tool call gets linked back to the `calls` row** for that
  conversation (`lib/agent/context.ts::callIdForProvider`), which is what
  lets an order or a transfer show up attached to the right call in the
  dashboard rather than as an orphan.

### `place_order` in detail

The write is one transaction (`public.place_order`) -- pricing, the
sold-out check, and both inserts (`orders`, `order_items`) commit together
or not at all, so a failure partway through can never leave a priced order
with no food on it. Refusals fall into three shapes, and the model needs
to treat them differently:

- **Ordinary business answers**, `agentOk({placed:false, reason, item?})`,
  200: `reason` is `"unknown_item"`, `"sold_out"`, `"no_delivery"` (delivery
  asked for at a pickup-only location), or `"no_pickup"` (the reverse).
  These are things a host says out loud without anything having gone
  wrong.
- **Requests the route can't make sense of**, `agentFail`, 400:
  missing/empty `items`, missing `customer_name`/`customer_phone`, an
  unparseable `type`, delivery with no `address`, a quantity that isn't a
  positive whole number ("two" is not accepted -- only a number or a
  numeric string), more than 40 distinct line items, or more than 50 of
  one item. The last two refusals also tell the agent to offer a transfer,
  since that's a catering order, not a phone order.
- **A drift bug**, `agentFail`, 500, logged server-side: `public.place_order`
  can return other reasons (`unknown_location`, `invalid_type`,
  `missing_address`, `missing_customer`, `no_items`, `mismatched_lines`,
  `bad_quantity`, `bad_promise`) that the route's own validation is
  supposed to catch before ever calling it. Seeing one in production means
  the route and the function have drifted apart, not that the caller did
  anything wrong -- that's why it's a 500 and not a spoken sentence.

`total` in a successful response (`"$14.30"`) **includes tax** --
`place_order` computes `subtotal + round(subtotal * tax_rate_bps / 10000)`
server-side, the same as `check_availability`'s and the menu's pricing is
never sent by the client. `get_menu`'s prices do not include tax. See the
tax gap below for what that means for the prompt's read-back step.

## 4. Set the assistant up

- **System prompt:** `system_prompt` from step 2, fetched fresh every call.
- **First message:** `greeting` from the same response, as a pre-recorded
  audio file. Do not let the model generate it -- a generated greeting
  costs a second of silence at the top of every call. (`buildGreeting` in
  `lib/agent/prompt.ts` is the text of record; it falls back to a generic
  greeting if the location hasn't set `greeting_text`.)
- **Temperature:** 0.3. Boring and consistent, not creative.
- **Transfer destination:** `fallback_number` from the same response.

## 5. Point the number at it

Twilio number → Vapi phone number import → assign the assistant (or the
dynamic-assistant wiring from step 2, if that's how you set it up).

Keep our `/api/twilio/voice` webhook for numbers that are not on Vapi yet;
the two paths do not conflict -- that route still greets, optionally
records, and forwards straight to a human, unconditionally, with no AI
involved at all.

## 6. Prove it before a real caller does: `scripts/exercise-tools.mjs`

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
provisions its own three throwaway locations (one for cross-tenant
isolation, one with the kill switch on, one not live), drives every tool
through them and the demo location, and deletes them again in a
`try/finally` that runs even if a check throws partway through -- so
running it twice in a row starts from the same state both times. It
finishes by snapshotting the demo location's orders, order_items,
bookings, calls, order_status_events, and menu_items before and after and
asserting they are byte-for-byte identical, proving its own writes were
fully cleaned up.

It runs 36 checks, including: auth (missing/wrong secret, on both a read
and both write endpoints), cross-tenant isolation on both `get_menu` and
`place_order` (a second tenant's secret can see only its own menu and
cannot order off another tenant's menu), sold-out vs. unknown-item as
distinct refusals, order-size limits, an unparseable quantity refused as a
sentence rather than a menu decision, a retried `place_order` call
deduplicating to one order, tax rounding pinned against two quantities
chosen to land on opposite sides of a half cent, past-time refusals on
both `check_availability` and `create_reservation`, an oversized party
refused before booking, and the assistant endpoint failing closed on the
kill switch and on "not live" independently.

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
  genuinely open. Do not onboard a location whose hours cross midnight
  until this is fixed; if one already exists, split the hours row or
  don't rely on this for it.
- **The prompt promises changing and cancelling a reservation** ("Book,
  change, or cancel a table reservation" is in the system prompt's "What
  you can do" list) **and no tool exists for either.** The agent will
  transfer to a human when asked, which is safe, but it is not what the
  prompt told the caller it could do a moment earlier.
- **The spoken order total can differ from what's actually due.** The
  prompt has the agent read back the order total before calling
  `place_order` ("read the whole order back, with the total, and ask if
  it is right"), but the only source it has for prices before that call is
  `get_menu`, which returns **pre-tax** prices. `place_order`'s own total
  includes tax, computed server-side from `locations.tax_rate_bps`. At any
  location with a nonzero tax rate, a total the agent computes and speaks
  from menu prices alone will not match the total `place_order` actually
  records, unless the model is separately told the tax rate and reliably
  does that arithmetic in a phone conversation -- which nothing in this
  system currently gives it a tool for.
- **The prompt answers questions about parking and offers to text a
  payment link. Neither has anything behind it.** There's no parking data
  anywhere in the schema, and no payment-link tool or SMS-to-customer
  path exists (`lib/agent/notify.ts`'s only outbound message is the order
  ticket to the restaurant's own staff number, not to a caller). Both are
  the model improvising from the prompt's wording, not answering from
  real data -- exactly the kind of invented answer the rest of the prompt
  works hard to prevent everywhere else.
- **`create_reservation` is not idempotent.** Unlike `place_order`, there
  is no fingerprint on a booking. A retried tool call for the same
  reservation creates a second one. See step 3.
- **No secret rotation without a call-failure window.** Covered in step 1.
  Worth repeating here: there is no code path in this system that rotates
  a live location's secret without some number of calls failing auth in
  between.
- **Card-number redaction covers one write path.** `redactCardNumbers`
  (`lib/agent/redact.ts`) scrubs `transfer_reason` before it's written.
  Nothing else -- not order notes, not a future `calls.transcript` column
  (the schema already has a comment promising this will be redacted; no
  writer for that column exists yet) -- is scanned. If you enable Twilio
  call recording or any transcript storage for a Vapi-held call, a caller
  who reads a card number out loud during an order (not a transfer) is
  not protected by anything in this codebase today.
- **Recording retention is not enforced.** `recording_retention_days`
  exists on `locations` but nothing deletes a recording once it's past
  that many days.
- **Sizes and modifiers aren't priced.** They're in the menu schema but
  neither `get_menu` nor `place_order` exposes them. A caller who orders
  "a large" gets the base-size price. Do not onboard a menu where size or
  modifiers change the price -- most pizza and coffee menus -- until this
  ships.

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
- [ ] Run `scripts/exercise-tools.mjs` against the environment Vapi will actually hit, and confirm all 36 checks pass. Don't onboard on top of a red run.
- [ ] Confirm your Vapi wiring fetches `/api/agent/assistant` **fresh at the start of every call**, not once at setup. Leave the integration alone overnight and call it again the next morning; it must state the correct date and today's real hours, not yesterday's.
- [ ] Flip the location's kill switch on the dashboard mid-session and call again immediately. The very next call must not reach the AI -- confirm it lands on a human, not just that `/api/agent/assistant` reports `assistant_enabled:false` in isolation.
- [ ] Set the location live to `false` and confirm the same thing happens for that condition independently of the kill switch.
- [ ] Confirm `fallback_human_number` is set and correct for this location. `transfer_to_human` fails outright without one, and it's the destination for both the kill switch and every AI-initiated transfer.
- [ ] Check the location's hours don't cross midnight (e.g. open past 12am). If they do, `get_hours` and the assistant will report the location closed at every hour, forever -- see the gaps above.
- [ ] Confirm the menu at this location doesn't depend on size or modifiers for price (no "small/large", no "add bacon +$2"). If it does, don't launch until that's supported -- today it prices everything at the base rate.
- [ ] Place a real test order and confirm the SMS ticket actually lands on the staff phone (`order_sms_to`) from the right Twilio number (`twilio_number`). A missing or wrong value here fails silently -- the order still succeeds, the caller still hears it worked, and the kitchen never finds out.
- [ ] Order something at a location with a nonzero tax rate and listen for whether the spoken total (read back before you confirm) matches the total in the confirmation / on the dashboard. If they differ, decide whether that's acceptable for this restaurant before launch -- see the tax gap above.
- [ ] Ask it to change or cancel an existing reservation. Confirm it transfers cleanly rather than pretending to handle it -- the prompt claims this capability but no tool backs it.
- [ ] Ask about parking, and ask it to text you a payment link. Confirm it doesn't invent a specific, wrong answer (a lot next door that doesn't exist, a link that never arrives) -- both are unimplemented and it may improvise from the prompt's wording alone.
- [ ] If your Vapi tool configuration can retry a tool call (timeout, network blip), force one against `create_reservation` specifically and check whether it double-books. It has no idempotency protection, unlike `place_order`.
- [ ] Rotate the location's secret (`--force`) once, on purpose, during a maintenance window, so whoever runs this in production has done it before they have to do it under pressure. Confirm calls fail during the gap and recover once Vapi's headers are updated.
