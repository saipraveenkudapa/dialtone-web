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

## Database

This repo owns the schema. The Python agent reads it and never migrates.

```bash
supabase start        # needs Docker
supabase db reset     # runs migrations, then supabase/seed.sql
supabase test db      # runs the RLS policy tests
```

| File | What it is |
|---|---|
| `supabase/migrations/*_schema.sql` | Tables, enums, indexes, triggers |
| `supabase/migrations/*_rls.sql` | Row Level Security and the agent's role |
| `supabase/tests/rls_test.sql` | Tenant-isolation tests (pgTAP) |
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

### Rules the schema enforces

- Money is integer cents. Timestamps are `timestamptz`; the UI renders
  them in the location's timezone.
- `menu_items.location_id` is derived from its category by trigger, so a
  caller cannot smuggle an item into another tenant's menu.
- No column anywhere stores a card number. Payment is an SMS link, which
  keeps this database out of PCI scope. Don't add one.
- Uploaded menus land in `menu_imports` and stay there until a human
  confirms every line. A wrong price comes out of the owner's pocket.
