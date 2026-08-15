-- RLS policy tests.
--
-- These are the tests that matter most in this product: a restaurant must
-- never see another restaurant's calls, and the voice agent must never be
-- able to read or write outside the one location it was minted for.
--
-- Deliberately not pgTAP. pgTAP lives in the `extensions` schema, which
-- `authenticated` has no USAGE on — and granting it just to run a test
-- would widen the surface the test exists to protect. Plain SQL asserts
-- into a temp table instead, and the final SELECT is the report.
--
-- Run with:  psql "$DATABASE_URL" -f supabase/tests/rls_test.sql
-- Every row of the output must read PASS. The whole thing rolls back.

begin;

create temp table results (name text, got text, want text);
grant all on results to public;

-- ── fixtures: two unrelated restaurants ──────────────────────────────

insert into auth.users (id, email, instance_id, aud, role)
values
  ('11111111-1111-1111-1111-111111111111', 'owner-a@example.com', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'owner-b@example.com', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

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

-- Cacio e Pepe deliberately claims the RIVAL location: the trigger must
-- overwrite it from the category, or a caller could smuggle an item into
-- another tenant's menu.
insert into menu_items (category_id, name, price_cents, location_id) values
  ('ca100000-0000-0000-0000-0000000000ca', 'Cacio e Pepe', 2200, 'b10c0000-0000-0000-0000-00000000000b'),
  ('cb100000-0000-0000-0000-0000000000cb', 'Margherita', 1800, 'b10c0000-0000-0000-0000-00000000000b');

insert into calls (id, location_id, twilio_call_sid) values
  ('cc100000-0000-0000-0000-0000000000cc', 'a10c0000-0000-0000-0000-00000000000a', 'CA_test_a');

-- One uploaded menu each, in the PRIVATE menu-uploads bucket. Objects are
-- keyed <location_id>/<uuid>, so the first path segment is the whole
-- tenant boundary -- the same shape call-recordings uses.
insert into menu_imports (id, location_id, source_type, source_path, original_filename, byte_size) values
  ('d1100000-0000-0000-0000-0000000000d1', 'a10c0000-0000-0000-0000-00000000000a', 'image',
   'a10c0000-0000-0000-0000-00000000000a/f0000000-0000-4000-8000-00000000000f.jpg', 'front.jpg', 2048),
  ('d2200000-0000-0000-0000-0000000000d2', 'b10c0000-0000-0000-0000-00000000000b', 'pdf',
   'b10c0000-0000-0000-0000-00000000000b/e0000000-0000-4000-8000-00000000000e.pdf', 'rival.pdf', 4096);

insert into storage.objects (bucket_id, name, metadata) values
  ('menu-uploads', 'a10c0000-0000-0000-0000-00000000000a/f0000000-0000-4000-8000-00000000000f.jpg',
   jsonb_build_object('size', 2048, 'mimetype', 'image/jpeg')),
  ('menu-uploads', 'b10c0000-0000-0000-0000-00000000000b/e0000000-0000-4000-8000-00000000000e.pdf',
   jsonb_build_object('size', 4096, 'mimetype', 'application/pdf'));

-- One recording each, in the PRIVATE call-recordings bucket. This is the
-- most sensitive object this product stores -- a caller's actual voice --
-- and its bucket and policy lived only in the Supabase dashboard until
-- 20260814020000_call_recordings_bucket.sql wrote them down. Same tenant
-- shape as above: the first path segment is the whole boundary, and both
-- writers spell it `<location_id>/<call_id>.<ext>`.
insert into storage.objects (bucket_id, name, metadata) values
  ('call-recordings', 'a10c0000-0000-0000-0000-00000000000a/cc100000-0000-0000-0000-0000000000cc.wav',
   jsonb_build_object('size', 720896, 'mimetype', 'audio/wav')),
  ('call-recordings', 'b10c0000-0000-0000-0000-00000000000b/cd100000-0000-0000-0000-0000000000cd.wav',
   jsonb_build_object('size', 350208, 'mimetype', 'audio/wav'));

insert into results
select 'trigger forces menu item to its category location',
       (select location_id::text from menu_items where name = 'Cacio e Pepe'),
       'a10c0000-0000-0000-0000-00000000000a';

-- ── owner A ──────────────────────────────────────────────────────────

set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into results values ('owner A: own locations visible', (select count(*)::text from public.locations), '1');
insert into results values ('owner A: own menu items visible', (select count(*)::text from public.menu_items), '1');
insert into results values ('owner A: own calls visible', (select count(*)::text from public.calls), '1');
insert into results values ('owner A: own org visible', (select count(*)::text from public.organizations), '1');
insert into results values ('owner A: rival item hidden', (select count(*)::text from public.menu_items where name = 'Margherita'), '0');

do $$
begin
  insert into public.menu_items (category_id, name, price_cents, location_id)
  values ('cb100000-0000-0000-0000-0000000000cb', 'Sneaky Item', 100, 'b10c0000-0000-0000-0000-00000000000b');
  insert into results values ('owner A: insert into rival menu', 'allowed', 'denied');
exception when insufficient_privilege then
  insert into results values ('owner A: insert into rival menu', 'denied', 'denied');
end $$;

do $$
begin
  update public.menu_items set sold_out_until = 'close' where name = 'Cacio e Pepe';
  insert into results values ('owner A: flag own item sold out', 'allowed', 'allowed');
exception when insufficient_privilege then
  insert into results values ('owner A: flag own item sold out', 'denied', 'allowed');
end $$;

-- ── owner A's menu uploads ───────────────────────────────────────────
--
-- A menu import is a photo nobody has confirmed yet. It must be as
-- private as a call recording, and the file behind it more so: the bucket
-- has no public URL at all.

insert into results values ('owner A: own menu import visible', (select count(*)::text from public.menu_imports), '1');
insert into results values ('owner A: rival menu import hidden', (select count(*)::text from public.menu_imports where original_filename = 'rival.pdf'), '0');
insert into results values ('owner A: own menu file visible', (select count(*)::text from storage.objects where bucket_id = 'menu-uploads'), '1');

do $$
begin
  insert into public.menu_imports (location_id, source_type, source_path)
  values ('b10c0000-0000-0000-0000-00000000000b', 'image',
          'b10c0000-0000-0000-0000-00000000000b/c0000000-0000-4000-8000-00000000000c.jpg');
  insert into results values ('owner A: import against rival location', 'allowed', 'denied');
exception when insufficient_privilege then
  insert into results values ('owner A: import against rival location', 'denied', 'denied');
end $$;

do $$
begin
  insert into public.menu_imports (location_id, source_type, source_path)
  values ('a10c0000-0000-0000-0000-00000000000a', 'image',
          'a10c0000-0000-0000-0000-00000000000a/c0000000-0000-4000-8000-00000000000c.jpg');
  insert into results values ('owner A: import against own location', 'allowed', 'allowed');
exception when insufficient_privilege then
  insert into results values ('owner A: import against own location', 'denied', 'allowed');
end $$;

-- The two facts the owner's rule rests on, at the only level that cannot
-- be talked out of them.
do $$
begin
  insert into public.menu_imports (location_id, source_type, source_path, status, confirmed_at)
  values ('a10c0000-0000-0000-0000-00000000000a', 'image',
          'a10c0000-0000-0000-0000-00000000000a/d0000000-0000-4000-8000-00000000000d.jpg', 'confirmed', null);
  insert into results values ('confirmed with no confirmed_at', 'allowed', 'denied');
exception when check_violation then
  insert into results values ('confirmed with no confirmed_at', 'denied', 'denied');
end $$;

do $$
begin
  insert into public.menu_imports (location_id, source_type, source_path)
  values ('a10c0000-0000-0000-0000-00000000000a', 'image', null);
  insert into results values ('file import with no stored path', 'allowed', 'denied');
exception when check_violation then
  insert into results values ('file import with no stored path', 'denied', 'denied');
end $$;

do $$
begin
  insert into storage.objects (bucket_id, name)
  values ('menu-uploads', 'a10c0000-0000-0000-0000-00000000000a/a0000000-0000-4000-8000-00000000000a.jpg');
  insert into results values ('owner A: upload into own folder', 'allowed', 'allowed');
exception when insufficient_privilege then
  insert into results values ('owner A: upload into own folder', 'denied', 'allowed');
end $$;

do $$
begin
  insert into storage.objects (bucket_id, name)
  values ('menu-uploads', 'b10c0000-0000-0000-0000-00000000000b/b0000000-0000-4000-8000-00000000000b.jpg');
  insert into results values ('owner A: upload into rival folder', 'allowed', 'denied');
exception when insufficient_privilege then
  insert into results values ('owner A: upload into rival folder', 'denied', 'denied');
end $$;

-- Removing a wrong photo before anything is extracted from it is the
-- owner's own job. It is not tested here: storage.protect_delete() blocks
-- deletes issued as SQL, so the only way to remove an object is the
-- Storage API, which evaluates the delete policy above. What this file
-- can assert is that the policy is there to be evaluated.
insert into results values (
  'menu-uploads has a delete policy',
  (select count(*)::text from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and cmd = 'DELETE' and qual like '%menu-uploads%'),
  '1');

-- And that the bucket itself is private, with the two limits the app
-- reads back out of lib/menu-imports/file.ts.
insert into results values (
  'menu-uploads is private, 10 MiB, four types',
  (select public::text || ' ' || file_size_limit::text || ' ' || array_length(allowed_mime_types, 1)::text
   from storage.buckets where id = 'menu-uploads'),
  'false 10485760 4');

-- ── owner A's call recordings ────────────────────────────────────────
--
-- The same three questions asked of the bucket holding callers' voices.
-- Until 20260814020000 there was no migration to ask them of: the bucket
-- and its policy were dashboard state, so a flag flipped by hand would
-- have made every recording in the product world-readable with nothing
-- in the repo, the test suite or CI to notice.
insert into results values (
  'owner A: own recording visible',
  (select count(*)::text from storage.objects where bucket_id = 'call-recordings'),
  '1');

insert into results values (
  'owner A: rival recording hidden',
  (select count(*)::text from storage.objects
   where bucket_id = 'call-recordings' and name like 'b10c%'),
  '0');

insert into results values (
  'call-recordings has a read policy',
  (select count(*)::text from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and cmd = 'SELECT' and qual like '%call-recordings%'),
  '1');

-- The single most consequential boolean in this product's storage.
insert into results values (
  'call-recordings is private',
  (select public::text from storage.buckets where id = 'call-recordings'),
  'false');

-- ── owner B ──────────────────────────────────────────────────────────

set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

insert into results values ('owner B: A calls hidden', (select count(*)::text from public.calls), '0');
insert into results values ('owner B: own location visible', (select count(*)::text from public.locations), '1');
insert into results values ('owner B: A menu hidden', (select count(*)::text from public.menu_items where name = 'Cacio e Pepe'), '0');
insert into results values ('owner B: A menu imports hidden', (select count(*)::text from public.menu_imports where original_filename = 'front.jpg'), '0');
insert into results values ('owner B: A menu files hidden', (select count(*)::text from storage.objects where name like 'a10c%'), '0');
insert into results values ('owner B: A recordings hidden', (select count(*)::text from storage.objects where bucket_id = 'call-recordings' and name like 'a10c%'), '0');
insert into results values ('owner B: own recording visible', (select count(*)::text from storage.objects where bucket_id = 'call-recordings'), '1');

-- ── anonymous ────────────────────────────────────────────────────────

set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

insert into results values ('anon: locations', (select count(*)::text from public.locations), '0');
insert into results values ('anon: menu', (select count(*)::text from public.menu_items), '0');
insert into results values ('anon: calls', (select count(*)::text from public.calls), '0');
insert into results values ('anon: menu imports', (select count(*)::text from public.menu_imports), '0');
insert into results values ('anon: menu files', (select count(*)::text from storage.objects where bucket_id = 'menu-uploads'), '0');
-- The one an unversioned `public = true` would have broken silently:
-- a public bucket is readable without a policy and without a session.
insert into results values ('anon: call recordings', (select count(*)::text from storage.objects where bucket_id = 'call-recordings'), '0');

-- ── the voice agent, minted for location A ───────────────────────────

set local role agent_service;
set local request.jwt.claims = '{"role":"agent_service","location_id":"a10c0000-0000-0000-0000-00000000000a"}';

insert into results values ('agent: sees only its own location menu', (select count(*)::text from public.menu_items), '1');

do $$
begin
  insert into public.calls (location_id, twilio_call_sid)
  values ('a10c0000-0000-0000-0000-00000000000a', 'CA_agent_ok');
  insert into results values ('agent: log call for own location', 'allowed', 'allowed');
exception when insufficient_privilege then
  insert into results values ('agent: log call for own location', 'denied', 'allowed');
end $$;

do $$
begin
  insert into public.calls (location_id, twilio_call_sid)
  values ('b10c0000-0000-0000-0000-00000000000b', 'CA_agent_bad');
  insert into results values ('agent: log call for another location', 'allowed', 'denied');
exception when insufficient_privilege then
  insert into results values ('agent: log call for another location', 'denied', 'denied');
end $$;

-- A leaked agent token must not be able to pull call history back out.
do $$
declare n int;
begin
  select count(*) into n from public.calls;
  insert into results values ('agent: read calls back', 'allowed', 'denied');
exception when insufficient_privilege then
  insert into results values ('agent: read calls back', 'denied', 'denied');
end $$;

do $$
begin
  update public.menu_items set sold_out_until = null where name = 'Cacio e Pepe';
  insert into results values ('agent: edit the menu', 'allowed', 'denied');
exception when insufficient_privilege then
  insert into results values ('agent: edit the menu', 'denied', 'denied');
end $$;

do $$
declare n int;
begin
  select count(*) into n from public.menu_imports;
  insert into results values ('agent: read menu imports', 'allowed', 'denied');
exception when insufficient_privilege then
  insert into results values ('agent: read menu imports', 'denied', 'denied');
end $$;

reset role;

select case when got is not distinct from want then 'PASS' else 'FAIL' end as status,
       name, got, want
from results
order by (got is not distinct from want), name;

rollback;
