-- Dialtone core schema.
--
-- This schema is the contract between two services:
--   * the Next.js web app (this repo), which owns these migrations
--   * the Python voice agent, which only reads menu/location rows and
--     inserts calls, orders and bookings. It never migrates.
--
-- Conventions:
--   * money is integer cents, never float
--   * timestamps are timestamptz (UTC); the UI renders them in the
--     location's timezone
--   * nothing here stores a card number. Payment is an SMS link, which
--     keeps this database out of PCI scope. Do not add such a column.

create extension if not exists "pgcrypto";

-- Helper functions live in their own schema so they cannot collide with
-- table names and are not exposed through PostgREST.
create schema if not exists app;

-- ── tenancy ──────────────────────────────────────────────────────────

create table organizations (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  stripe_customer_id text unique,
  plan               text not null default 'trial'
                       check (plan in ('trial', 'starter', 'growth')),
  created_at         timestamptz not null default now()
);

create type membership_role as enum ('owner', 'manager');

create table memberships (
  user_id    uuid not null references auth.users (id) on delete cascade,
  org_id     uuid not null references organizations (id) on delete cascade,
  role       membership_role not null default 'manager',
  created_at timestamptz not null default now(),
  primary key (user_id, org_id)
);

create index memberships_org_idx on memberships (org_id);

-- ── locations ────────────────────────────────────────────────────────

create table locations (
  id       uuid primary key default gen_random_uuid(),
  org_id   uuid not null references organizations (id) on delete cascade,
  name     text not null,
  timezone text not null default 'America/Los_Angeles',
  address  text,

  -- The restaurant's own number. We never port it; the carrier forwards
  -- busy / no-answer / after-hours calls to twilio_number.
  business_phone        text,
  twilio_number         text unique,
  twilio_number_sid     text unique,
  -- Where the agent hands off: transfers, allergen questions, crashes,
  -- and every call while the kill switch is on.
  fallback_human_number text,

  -- One editable line, deliberately not code. An AI-disclosure rule is
  -- expected within a couple of years; when it lands this is a text edit,
  -- not a rebuild.
  greeting_text       text not null default '',
  -- Pre-recorded so playback starts instantly, with no synthesis wait.
  greeting_audio_path text,

  -- Recording is announced when on. Callers may sit in two-party-consent
  -- states even though New Jersey is one-party.
  recording_enabled        boolean not null default true,
  recording_retention_days integer not null default 30
                             check (recording_retention_days between 1 and 365),

  is_live         boolean not null default false,
  kill_switch_on  boolean not null default false,

  order_delivery  text not null default 'sms'
                    check (order_delivery in ('sms', 'email', 'both')),
  order_sms_to    text,
  order_email_to  text,

  carrier_name         text,
  forwarding_verified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index locations_org_idx on locations (org_id);

create table hours (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations (id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  open_time   time,
  close_time  time,
  is_closed   boolean not null default false,
  unique (location_id, day_of_week),
  -- An open day needs both ends of the range.
  check (is_closed or (open_time is not null and close_time is not null))
);

create table holiday_hours (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations (id) on delete cascade,
  date        date not null,
  is_closed   boolean not null default true,
  open_time   time,
  close_time  time,
  unique (location_id, date)
);

-- ── menu ─────────────────────────────────────────────────────────────

create table menu_categories (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations (id) on delete cascade,
  name        text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index menu_categories_location_idx on menu_categories (location_id, sort_order);

-- "reopen" = back when the kitchen restocks; "close" = gone for the rest
-- of tonight's service. Null means available.
create type sold_out_until as enum ('reopen', 'close');

create table menu_items (
  id             uuid primary key default gen_random_uuid(),
  category_id    uuid not null references menu_categories (id) on delete cascade,
  -- Denormalised from the category so the agent's menu tool and every RLS
  -- policy can filter by location without a join. Kept honest by trigger.
  location_id    uuid not null references locations (id) on delete cascade,
  name           text not null,
  description    text,
  price_cents    integer not null check (price_cents >= 0),
  sold_out_until sold_out_until,
  -- Reference only. The agent must transfer allergy questions to a human,
  -- never answer from this field.
  allergen_note  text,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index menu_items_category_idx on menu_items (category_id, sort_order);
-- The agent's hot path: every call reads the available items for one
-- location. Partial index keeps that read tiny.
create index menu_items_available_idx on menu_items (location_id)
  where sold_out_until is null;

create table menu_modifier_groups (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references menu_items (id) on delete cascade,
  name       text not null,
  min_select smallint not null default 0 check (min_select >= 0),
  max_select smallint not null default 1 check (max_select >= 1),
  required   boolean not null default false,
  sort_order integer not null default 0,
  check (max_select >= min_select)
);

create table menu_modifiers (
  id                uuid primary key default gen_random_uuid(),
  group_id          uuid not null references menu_modifier_groups (id) on delete cascade,
  name              text not null,
  price_delta_cents integer not null default 0,
  is_available      boolean not null default true,
  sort_order        integer not null default 0
);

-- An uploaded menu lands here and stays here until a human confirms every
-- line. Nothing reaches menu_items unreviewed: a wrong price comes out of
-- the owner's pocket.
create table menu_imports (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null references locations (id) on delete cascade,
  source_type    text not null check (source_type in ('pdf', 'image', 'url')),
  source_path    text,
  raw_extraction jsonb not null default '{}'::jsonb,
  status         text not null default 'pending'
                   check (status in ('pending', 'needs_review', 'confirmed', 'discarded')),
  confirmed_by   uuid references auth.users (id),
  confirmed_at   timestamptz,
  created_at     timestamptz not null default now(),
  -- Confirmation must record who and when, together.
  check ((status = 'confirmed') = (confirmed_at is not null))
);

create index menu_imports_location_idx on menu_imports (location_id, created_at desc);

-- ── calls ────────────────────────────────────────────────────────────

create type call_status as enum
  ('ringing', 'in_progress', 'completed', 'no_answer', 'busy', 'failed');

create type call_outcome as enum
  ('order', 'booking', 'question', 'transferred', 'spam', 'abandoned');

create table calls (
  id              uuid primary key default gen_random_uuid(),
  location_id     uuid not null references locations (id) on delete cascade,
  -- Twilio retries and reorders webhooks. Upsert on this key and ignore
  -- stale status transitions.
  twilio_call_sid text not null unique,

  from_number  text,
  from_city    text,
  from_state   text,
  dialed_number text,

  status  call_status not null default 'ringing',
  outcome call_outcome,

  started_at  timestamptz not null default now(),
  answered_at timestamptz,
  ended_at    timestamptz,
  duration_seconds integer check (duration_seconds >= 0),

  -- Path inside a PRIVATE storage bucket. Never a public URL: the app
  -- serves it through a short-lived signed URL.
  recording_path     text,
  recording_expires_at timestamptz,
  -- Card-like digit runs are stripped before this is written.
  transcript         jsonb,
  transcript_status  text default 'pending'
                       check (transcript_status in ('pending', 'ready', 'failed', 'skipped')),

  transferred_to_human boolean not null default false,
  transfer_reason      text,
  is_spam              boolean not null default false,
  -- Owner-initiated test calls: the one outbound path in the product.
  is_test              boolean not null default false,

  telephony_cost_cents integer not null default 0 check (telephony_cost_cents >= 0),
  llm_cost_cents       integer not null default 0 check (llm_cost_cents >= 0),

  notes      text,
  created_at timestamptz not null default now()
);

create index calls_location_started_idx on calls (location_id, started_at desc);
create index calls_outcome_idx on calls (location_id, outcome);

-- Raw webhook log. Append-only audit trail, replayable when a call's
-- derived state looks wrong.
create table call_events (
  id          uuid primary key default gen_random_uuid(),
  call_id     uuid not null references calls (id) on delete cascade,
  event_type  text not null,
  payload     jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index call_events_call_idx on call_events (call_id, occurred_at);

-- Per-turn latency, so a regression past the 1s budget is visible in the
-- data rather than in a customer complaint.
create table call_turn_metrics (
  id                 uuid primary key default gen_random_uuid(),
  call_id            uuid not null references calls (id) on delete cascade,
  turn_index         integer not null,
  end_of_speech_ms   integer,
  transcript_ms      integer,
  llm_first_token_ms integer,
  tts_first_audio_ms integer,
  total_ms           integer,
  barged_in          boolean not null default false,
  created_at         timestamptz not null default now(),
  unique (call_id, turn_index)
);

-- ── orders and bookings ──────────────────────────────────────────────

create type order_status as enum
  ('new', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled');

create table orders (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references locations (id) on delete cascade,
  call_id       uuid references calls (id) on delete set null,
  order_number  integer not null,
  customer_name  text,
  customer_phone text,
  type          text not null default 'pickup' check (type in ('pickup', 'delivery')),
  status        order_status not null default 'new',
  subtotal_cents integer not null default 0 check (subtotal_cents >= 0),
  tax_cents      integer not null default 0 check (tax_cents >= 0),
  total_cents    integer not null default 0 check (total_cents >= 0),
  notes         text,
  placed_at     timestamptz not null default now(),
  promised_at   timestamptz,
  completed_at  timestamptz,
  unique (location_id, order_number)
);

create index orders_location_status_idx on orders (location_id, status, placed_at desc);

create table order_items (
  id                   uuid primary key default gen_random_uuid(),
  order_id             uuid not null references orders (id) on delete cascade,
  menu_item_id         uuid references menu_items (id) on delete set null,
  -- Snapshots: an order must still read correctly after the menu changes
  -- or the item is deleted.
  name_snapshot        text not null,
  price_cents_snapshot integer not null check (price_cents_snapshot >= 0),
  quantity             integer not null default 1 check (quantity > 0),
  modifiers            jsonb not null default '[]'::jsonb
);

create index order_items_order_idx on order_items (order_id);

create table order_status_events (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders (id) on delete cascade,
  from_status order_status,
  to_status   order_status not null,
  changed_by  uuid references auth.users (id),
  changed_at  timestamptz not null default now()
);

create table bookings (
  id             uuid primary key default gen_random_uuid(),
  location_id    uuid not null references locations (id) on delete cascade,
  call_id        uuid references calls (id) on delete set null,
  customer_name  text,
  customer_phone text,
  party_size     smallint not null check (party_size > 0),
  requested_at   timestamptz not null,
  status         text not null default 'requested'
                   check (status in ('requested', 'confirmed', 'seated', 'cancelled', 'no_show')),
  notes          text,
  created_at     timestamptz not null default now()
);

create index bookings_location_time_idx on bookings (location_id, requested_at);

-- ── triggers ─────────────────────────────────────────────────────────

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger locations_touch
  before update on locations
  for each row execute function app.touch_updated_at();

create trigger menu_items_touch
  before update on menu_items
  for each row execute function app.touch_updated_at();

-- menu_items.location_id is denormalised; derive it from the category so
-- it can never drift out of agreement with the category's location.
create or replace function app.sync_menu_item_location()
returns trigger
language plpgsql
as $$
begin
  select c.location_id into new.location_id
  from menu_categories c
  where c.id = new.category_id;

  if new.location_id is null then
    raise exception 'menu_categories row % not found', new.category_id;
  end if;

  return new;
end;
$$;

create trigger menu_items_sync_location
  before insert or update of category_id on menu_items
  for each row execute function app.sync_menu_item_location();

-- Order numbers restart per location and stay gap-free enough to read
-- aloud over the phone.
create or replace function app.assign_order_number()
returns trigger
language plpgsql
as $$
begin
  if new.order_number is null or new.order_number = 0 then
    select coalesce(max(order_number), 1000) + 1 into new.order_number
    from orders
    where location_id = new.location_id;
  end if;
  return new;
end;
$$;

-- BEFORE triggers run ahead of the NOT NULL check, so the column stays
-- NOT NULL and callers may simply omit it.
create trigger orders_assign_number
  before insert on orders
  for each row execute function app.assign_order_number();

create or replace function app.log_order_status()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    insert into order_status_events (order_id, from_status, to_status, changed_by)
    values (new.id, old.status, new.status, auth.uid());
  elsif tg_op = 'INSERT' then
    insert into order_status_events (order_id, from_status, to_status, changed_by)
    values (new.id, null, new.status, auth.uid());
  end if;
  return new;
end;
$$;

create trigger orders_log_status
  after insert or update of status on orders
  for each row execute function app.log_order_status();
