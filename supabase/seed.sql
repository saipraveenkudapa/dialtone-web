-- Local development seed: the Nonna Rosa demo from the mockup.
-- Runs on `supabase db reset`. Never loaded in production.

-- GoTrue scans these token columns into non-nullable strings, so a
-- hand-inserted user with NULLs there fails every login with "Database
-- error querying schema". They must be '' rather than NULL.
insert into auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change,
  email_change_token_new, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token,
  created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'authenticated', 'authenticated', 'owner@nonnarosa.test',
  extensions.crypt('DialtoneDemo2026!', extensions.gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  '', '', '', '', '', '', '', '',
  now(), now()
) on conflict do nothing;

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) values (
  gen_random_uuid(),
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  '{"sub":"11111111-1111-1111-1111-111111111111","email":"owner@nonnarosa.test","email_verified":true,"phone_verified":false}'::jsonb,
  'email', now(), now(), now()
) on conflict do nothing;

insert into organizations (id, name, plan)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'Nonna Rosa', 'starter');

insert into memberships (user_id, org_id, role)
values ('11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001', 'owner');

insert into locations (
  id, org_id, name, timezone, address,
  business_phone, twilio_number, fallback_human_number,
  greeting_text, is_live, carrier_name, forwarding_verified_at,
  order_delivery, order_sms_to
) values (
  'a10c0000-0000-0000-0000-00000000000a',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'Nonna Rosa', 'America/Los_Angeles', '1412 Telegraph Ave, Oakland, CA',
  -- business_phone is display text; fallback_human_number is dialled by
  -- Twilio and must be E.164.
  '(510) 555-0142', '+15105550177', '+15105550142',
  -- No mention of AI: not required for inbound today. When the rule
  -- lands, this line changes and nothing else does.
  'Hi, thanks for calling Nonna Rosa.',
  true, 'Comcast Business', now() - interval '6 days',
  'sms', '(510) 555-0161'
);

insert into hours (location_id, day_of_week, open_time, close_time, is_closed)
select 'a10c0000-0000-0000-0000-00000000000a', d,
       '17:00'::time, '22:30'::time, d = 1
from generate_series(0, 6) as d;

insert into menu_categories (id, location_id, name, sort_order) values
  ('ca000000-0000-0000-0000-0000000000c1', 'a10c0000-0000-0000-0000-00000000000a', 'Antipasti', 1),
  ('ca000000-0000-0000-0000-0000000000c2', 'a10c0000-0000-0000-0000-00000000000a', 'Pasta', 2),
  ('ca000000-0000-0000-0000-0000000000c3', 'a10c0000-0000-0000-0000-00000000000a', 'Secondi', 3),
  ('ca000000-0000-0000-0000-0000000000c4', 'a10c0000-0000-0000-0000-00000000000a', 'Dolci', 4);

-- location_id is filled in by the sync trigger.
insert into menu_items (category_id, name, price_cents, sort_order, sold_out_until, location_id) values
  ('ca000000-0000-0000-0000-0000000000c1', 'Fritto Misto', 1600, 1, null, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c1', 'Burrata & Peach', 1500, 2, null, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c1', 'Meatballs al Forno', 1400, 3, null, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c1', 'Chicories, Anchovy', 1200, 4, null, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c2', 'Bucatini Amatriciana', 2400, 1, null, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c2', 'Cacio e Pepe', 2200, 2, null, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c2', 'Squid Ink Tonnarelli', 2900, 3, 'close', 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c2', 'Lasagne Verdi', 2600, 4, null, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c2', 'Gnocchi, Brown Butter', 2300, 5, null, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c3', 'Branzino, Whole', 3800, 1, null, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c3', 'Pork Milanese', 3200, 2, null, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c3', 'Bistecca, 32oz', 8800, 3, 'reopen', 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c4', 'Olive Oil Cake', 1100, 1, null, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca000000-0000-0000-0000-0000000000c4', 'Affogato', 900, 2, null, 'a10c0000-0000-0000-0000-00000000000a');

-- A night of calls, matching the mockup's log.
insert into calls (
  location_id, twilio_call_sid, from_number, from_city, from_state,
  status, outcome, started_at, answered_at, ended_at, duration_seconds,
  telephony_cost_cents, llm_cost_cents, transferred_to_human,
  transfer_reason, is_spam
) values
  ('a10c0000-0000-0000-0000-00000000000a', 'CA_seed_1', '(510) 555-0119', 'Oakland', 'CA',
   'completed', 'order', now() - interval '4 min', now() - interval '4 min',
   now() - interval '1 min', 168, 9, 10, false, null, false),
  ('a10c0000-0000-0000-0000-00000000000a', 'CA_seed_2', '(415) 555-0164', 'San Francisco', 'CA',
   'completed', 'booking', now() - interval '15 min', now() - interval '15 min',
   now() - interval '13 min', 96, 6, 6, false, null, false),
  ('a10c0000-0000-0000-0000-00000000000a', 'CA_seed_3', '(510) 555-0102', 'Berkeley', 'CA',
   'completed', 'transferred', now() - interval '27 min', now() - interval '27 min',
   now() - interval '26 min', 54, 5, 3, true, 'Allergen question', false),
  ('a10c0000-0000-0000-0000-00000000000a', 'CA_seed_4', '(925) 555-0188', 'Walnut Creek', 'CA',
   'completed', 'question', now() - interval '42 min', now() - interval '42 min',
   now() - interval '41 min', 41, 4, 2, false, null, false),
  ('a10c0000-0000-0000-0000-00000000000a', 'CA_seed_5', '(213) 555-0110', 'Los Angeles', 'CA',
   'completed', 'spam', now() - interval '1 hour', null,
   now() - interval '1 hour' + interval '11 sec', 11, 2, 0, false, null, true);

-- One order, hung off the first call.
with c as (
  select id from calls where twilio_call_sid = 'CA_seed_1'
), o as (
  insert into orders (location_id, call_id, customer_name, customer_phone,
                      type, status, subtotal_cents, tax_cents, total_cents)
  select 'a10c0000-0000-0000-0000-00000000000a', c.id, 'Dana', '(510) 555-0119',
         'pickup', 'preparing', 5600, 500, 6100
  from c
  returning id
)
insert into order_items (order_id, name_snapshot, price_cents_snapshot, quantity)
select o.id, v.name, v.price, v.qty
from o, (values
  ('Bucatini Amatriciana', 2400, 1),
  ('Lasagne Verdi', 2600, 1),
  ('Affogato', 900, 1)
) as v(name, price, qty);

insert into bookings (location_id, call_id, customer_name, customer_phone,
                      party_size, requested_at, status)
select 'a10c0000-0000-0000-0000-00000000000a', id, 'Marcus', '(415) 555-0164',
       4, date_trunc('day', now()) + interval '20 hour 30 min', 'confirmed'
from calls where twilio_call_sid = 'CA_seed_2';
