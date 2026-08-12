# Dialtone — web app

The restaurant-facing app for an AI phone agent service. Owners sign up,
upload a menu, set up call forwarding, and watch every call the agent
answers. Managers flag items sold out mid-service from a phone.

The voice agent itself is a separate Python service. It shares this
database and nothing else.

## Design

`design/Dialtone.html` is the approved mockup and `app/industry.css` is
its design system, extracted verbatim. Build screens to match it. Rules
for extending it are in [AGENTS.md](./AGENTS.md).

## Local setup

```bash
npm install
cp .env.example .env.local   # fill in Supabase, Twilio, Stripe
npm run dev
```

## Auth

Supabase Auth, email + password or magic link. `middleware.ts` refreshes
the session on every request and redirects anonymous visitors away from
`/dashboard`. It calls `getUser()`, not `getSession()` — the latter only
reads a cookie the client could forge.

Every query in the app runs with the anon key through RLS. The
service-role key is not used in the read path at all.

## Twilio webhooks

Inbound only. This service never originates a call.

| Route | Twilio setting |
|---|---|
| `POST /api/twilio/voice` | the number's "A call comes in" webhook |
| `POST /api/twilio/status` | set automatically as the `<Dial action>` |
| `POST /api/twilio/recording` | set automatically as the recording callback |

Every route verifies `X-Twilio-Signature` before doing anything, and
returns 403 otherwise. Without that check, anyone who found the URL could
invent calls or make us dial a number of their choosing. Twilio signs the
**public** URL it called, so `TWILIO_WEBHOOK_BASE_URL` must match the
tunnel or domain exactly -- a mismatch shows up as every request 403ing.

What a call does today, before the voice agent exists: greet the caller,
announce recording if it is enabled, log the call, and forward to the
human line. Kill switch on (or the location not live) skips all of it and
forwards immediately. That is already the promise -- the call is answered
and shows up in the dashboard instead of being missed.

Phone number formats: `twilio_number` and `fallback_human_number` are
E.164 (`+15105550142`) because Twilio matches and dials them.
`business_phone` is display text only.

Recordings are downloaded from Twilio into the private `call-recordings`
bucket, keyed `<location_id>/<call_id>.mp3`, and played back through
short-lived signed URLs. Twilio's own recording URL needs account
credentials to fetch, so keeping audio there would mean shipping those to
the browser.

Local testing without a phone: `scripts/twilio-post.mjs` signs a request
the way Twilio does.

```bash
node scripts/twilio-post.mjs /api/twilio/voice '{"CallSid":"CAtest","From":"+15105550119","To":"+15105550177"}'
```

## Voice agent

Vapi holds the call and calls our tool endpoints. See
[docs/vapi-setup.md](docs/vapi-setup.md) for wiring a restaurant, and
`lib/agent/prompt.ts` for the system prompt of record.

Tools authenticate with a per-location secret in `x-dialtone-secret`,
stored as a SHA-256 hash. A tool call can only ever touch the location
its secret belongs to — a `location_id` in a request body is never
trusted.

`POST /api/agent/assistant` assembles that prompt fresh per call and fails
closed: a location with its kill switch on, or not marked live, gets
`assistant_enabled: false` and a null prompt back, never a stale or
disabled one served from a cache. Whatever holds the call must check that
field before using anything else in the response — see
[docs/vapi-setup.md](docs/vapi-setup.md) for what that means in practice.

## Database

This repo owns the schema. The Python agent reads it and never migrates.

```bash
supabase start        # needs Docker
supabase db reset     # runs migrations, then supabase/seed.sql
psql "$DATABASE_URL" -f supabase/tests/rls_test.sql   # every row must say PASS
```

The hosted project is `tkecwvxwzpblwajfpron` (region us-west-1). Its
migrations, seed and policy tests have all been applied and run there.
Demo login: `owner@nonnarosa.test`. The password is in the seed file and
is development-only -- change or delete that user before any real data
lands in the project.

| File | What it is |
|---|---|
| `supabase/migrations/*_schema.sql` | Tables, enums, indexes, triggers |
| `supabase/migrations/*_rls.sql` | Row Level Security and the agent's role |
| `supabase/tests/rls_test.sql` | Tenant-isolation tests (plain SQL) |
| `supabase/seed.sql` | The Nonna Rosa demo from the mockup |

### Who can reach what

- **authenticated** — a signed-in owner or manager. Sees only rows for
  organizations they belong to.
- **agent_service** — the voice agent. Each call gets a short-lived token
  carrying `location_id`; every agent policy is scoped to that claim, so a
  token minted for one restaurant cannot read another's menu or write a
  call against it. It has no `SELECT` on `calls`, so a leaked agent token
  cannot pull call history back out.
- **service_role** — bypasses RLS. Server-side only, in this app. Never
  goes to the agent, never reaches the browser.

### Realtime

`menu_items`, `locations` and `calls` are in the `supabase_realtime`
publication; a table outside it broadcasts nothing while the channel
still reports SUBSCRIBED. Realtime applies the subscriber's RLS to every
change, so the client must hand the socket the user's token before
subscribing (`lib/supabase/realtime.ts`) or it authenticates as `anon`
and receives nothing.

### Rules the schema enforces

- Money is integer cents. Timestamps are `timestamptz`; the UI renders
  them in the location's timezone.
- `menu_items.location_id` is derived from its category by trigger, so a
  caller cannot smuggle an item into another tenant's menu.
- No column anywhere stores a card number. Payment is an SMS link, which
  keeps this database out of PCI scope. Don't add one.
- Uploaded menus land in `menu_imports` and stay there until a human
  confirms every line. A wrong price comes out of the owner's pocket.
