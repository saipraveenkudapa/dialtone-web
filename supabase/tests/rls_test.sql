-- RLS policy tests. Run with: supabase test db
--
-- These are the tests that matter most in this product: a restaurant must
-- never see another restaurant's calls, and the voice agent must never be
-- able to read or write outside the one location it was minted for.

begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- ── fixtures ─────────────────────────────────────────────────────────

insert into auth.users (id, email)
values
  ('11111111-1111-1111-1111-111111111111', 'owner-a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'owner-b@example.com');

insert into organizations (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Rosa Group'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Rival Group');

insert into memberships (user_id, org_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner'),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-0000-0000-0000-000000000002', 'owner');

insert into locations (id, org_id, name, twilio_number) values
  ('a10c0000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'Nonna Rosa', '+15105550142'),
  ('b10c0000-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000002', 'Rival Pizza', '+15105550199');

insert into menu_categories (id, location_id, name) values
  ('ca100000-0000-0000-0000-0000000000ca', 'a10c0000-0000-0000-0000-00000000000a', 'Pasta'),
  ('cb100000-0000-0000-0000-0000000000cb', 'b10c0000-0000-0000-0000-00000000000b', 'Pizza');

-- Cacio e Pepe is deliberately inserted claiming the RIVAL location: the
-- trigger must overwrite it from the category, or a caller could smuggle
-- an item into another tenant's menu.
insert into menu_items (category_id, name, price_cents, location_id) values
  ('ca100000-0000-0000-0000-0000000000ca', 'Cacio e Pepe', 2200, 'b10c0000-0000-0000-0000-00000000000b'),
  ('cb100000-0000-0000-0000-0000000000cb', 'Margherita', 1800, 'b10c0000-0000-0000-0000-00000000000b');

insert into calls (id, location_id, twilio_call_sid) values
  ('cc100000-0000-0000-0000-0000000000cc', 'a10c0000-0000-0000-0000-00000000000a', 'CA_test_a');

-- The denormalised column must be derived, never trusted from the caller.
select is(
  (select location_id from menu_items where name = 'Cacio e Pepe'),
  'a10c0000-0000-0000-0000-00000000000a'::uuid,
  'menu_items.location_id is forced to match its category'
);

-- ── owner A ──────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

select is((select count(*) from locations)::int, 1, 'owner A sees only their own location');
select is((select count(*) from menu_items)::int, 1, 'owner A sees only their own menu items');
select is((select count(*) from calls)::int, 1, 'owner A sees their own calls');
select is((select count(*) from organizations)::int, 1, 'owner A sees only their own org');

select throws_ok(
  $$ insert into menu_items (category_id, name, price_cents, location_id)
     values ('cb100000-0000-0000-0000-0000000000cb', 'Sneaky Item', 100,
             'b10c0000-0000-0000-0000-00000000000b') $$,
  '42501',
  null,
  'owner A cannot add an item to another org''s menu'
);

select lives_ok(
  $$ update menu_items set sold_out_until = 'close' where name = 'Cacio e Pepe' $$,
  'owner A can flag their own item sold out'
);

select is(
  (select count(*) from menu_items where name = 'Margherita')::int, 0,
  'owner A cannot even see the rival item they might try to update'
);

-- ── owner B ──────────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

select is((select count(*) from calls)::int, 0, 'owner B sees none of A''s calls');
select is((select count(*) from locations)::int, 1, 'owner B sees only their own location');

-- ── anonymous ────────────────────────────────────────────────────────

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select is((select count(*) from locations)::int, 0, 'anon sees no locations');
select is((select count(*) from menu_items)::int, 0, 'anon sees no menu');
select is((select count(*) from calls)::int, 0, 'anon sees no calls');

-- ── the voice agent, scoped to location A ────────────────────────────

set local role agent_service;
set local request.jwt.claims =
  '{"role":"agent_service","location_id":"a10c0000-0000-0000-0000-00000000000a"}';

select is(
  (select count(*) from menu_items)::int, 1,
  'agent reads only the menu of the location it was minted for'
);

select lives_ok(
  $$ insert into calls (location_id, twilio_call_sid)
     values ('a10c0000-0000-0000-0000-00000000000a', 'CA_agent_ok') $$,
  'agent can log a call for its own location'
);

select throws_ok(
  $$ insert into calls (location_id, twilio_call_sid)
     values ('b10c0000-0000-0000-0000-00000000000b', 'CA_agent_bad') $$,
  '42501',
  null,
  'agent cannot log a call against another location'
);

-- A compromised agent token must not be able to pull call history back
-- out, so the agent has no SELECT on calls at all.
select throws_ok(
  $$ select count(*) from calls $$,
  '42501',
  null,
  'agent cannot read calls back'
);

select throws_ok(
  $$ update menu_items set sold_out_until = null where name = 'Cacio e Pepe' $$,
  '42501',
  null,
  'agent cannot edit the menu it reads from'
);

select throws_ok(
  $$ select count(*) from menu_imports $$,
  '42501',
  null,
  'agent cannot read unconfirmed menu imports'
);

select * from finish();
rollback;
