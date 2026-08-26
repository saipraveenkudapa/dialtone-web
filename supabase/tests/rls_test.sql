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

-- The RIVAL's ticket, written here rather than in the "moving an order"
-- section at the foot of this file, because it has to exist before owner
-- A tries to move it: under RLS a write to another org's row is filtered
-- to zero rows rather than refused, so a missing row and a protected one
-- look identical and the assertion would pass against nothing at all.
-- Written by this file's own role, which owns the tables, so it does not
-- depend on the trigger fix it is here to help test.
insert into orders (id, location_id, customer_name, total_cents) values
  ('0d100000-0000-0000-0000-0000000000d1', 'b10c0000-0000-0000-0000-00000000000b',
   'A rival caller', 1800);

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

-- ── pick cap ─────────────────────────────────────────────────────────
--
-- Runs as an authenticated owner, the same way the sections above do --
-- NOT as agent_service, which is still the role in effect from the
-- section above and holds SELECT only on menu_items. A bare UPDATE run
-- as agent_service raises insufficient_privilege with no exception
-- handler around it, which aborts the whole enclosing transaction: every
-- statement after it, including this file's own `reset role;` and final
-- report, would fail with "current transaction is aborted" and the suite
-- would emit no PASS/FAIL rows at all.
--
-- The fixtures above give location A exactly one menu item (Cacio e
-- Pepe). Three more, in Nonna Rosa's own category, are added here so
-- there are four real rows to press the cap against -- "three allowed"
-- must mark three distinct items, not silently no-op against a missing
-- fourth row.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

insert into menu_items (category_id, name, price_cents, location_id) values
  ('ca100000-0000-0000-0000-0000000000ca', 'Tiramisu', 900, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca100000-0000-0000-0000-0000000000ca', 'Caprese Salad', 1100, 'a10c0000-0000-0000-0000-00000000000a'),
  ('ca100000-0000-0000-0000-0000000000ca', 'Osso Buco', 3200, 'a10c0000-0000-0000-0000-00000000000a');

do $$
declare
  loc uuid := 'a10c0000-0000-0000-0000-00000000000a';
  ids uuid[];
begin
  select array_agg(id) into ids
    from (select id from menu_items where location_id = loc order by created_at limit 4) t;

  -- Guarded like the blocks below it, and for the same reason this block
  -- itself exists to fix: a bare UPDATE with no exception handler that
  -- raises aborts the whole enclosing transaction, so a cap regression
  -- here would not FAIL this assertion, it would erase every PASS/FAIL
  -- row the file produces, including the ones above it.
  --
  -- Both labels are used deliberately: the cap counts non-null
  -- pick_label, so a restaurant that spends its three slots on a mix of
  -- kinds is at the cap exactly as one that spends them all on the same
  -- kind.
  begin
    update menu_items set pick_label = 'best_seller' where id = ids[1];
    update menu_items set pick_label = 'chefs_special' where id = ids[2];
    update menu_items set pick_label = 'best_seller' where id = ids[3];
    insert into results values ('picks: three allowed', 'ok', 'ok');
  exception when check_violation then
    insert into results values ('picks: three allowed', 'refused', 'ok');
  end;

  -- A fourth pick, as 'best_seller' so that the CAP is the only thing
  -- that can refuse it. ids[2] already holds this restaurant's one chef's
  -- special, and menu_items_one_chefs_special_idx raises unique_violation
  -- rather than check_violation -- which this handler would not catch, so
  -- asking for a fourth chefs_special would mean a cap regression aborted
  -- the transaction and erased every row this file has produced, instead
  -- of failing the one assertion it belongs to.
  begin
    update menu_items set pick_label = 'best_seller' where id = ids[4];
    insert into results values ('picks: fourth refused', 'allowed', 'refused');
  exception when check_violation then
    insert into results values ('picks: fourth refused', 'refused', 'refused');
  end;

  -- ONE chef's special per restaurant, which the cap above does not say:
  -- it counts picks, not kinds, so all three of them could be this one.
  -- ids[3] already holds a slot as a best seller, so the cap's "already
  -- counted" branch waves this through and only the partial unique index
  -- is left to refuse it. It has to, because lib/agent/menu.ts sends "the
  -- chef's special" definite and the prompt lets the agent name two picks
  -- in one call: two dishes holding this label is one caller being told
  -- that each of them is THE chef's special.
  begin
    update menu_items set pick_label = 'chefs_special' where id = ids[3];
    insert into results values ('picks: second chef''s special refused', 'allowed', 'refused');
  exception when unique_violation then
    insert into results values ('picks: second chef''s special refused', 'refused', 'refused');
  end;

  -- Re-wording a pick the restaurant already holds is not a fourth pick.
  -- At the cap, this is the one UPDATE that must still pass: it swaps
  -- which phrase the agent says about a dish that already owns a slot,
  -- and the trigger's "already counted" branch is what lets it. Moving
  -- OFF chefs_special rather than onto it, because the assertion directly
  -- above owns the other direction now.
  begin
    update menu_items set pick_label = 'best_seller' where id = ids[2];
    insert into results values ('picks: relabelling at the cap allowed', 'ok', 'ok');
  exception when check_violation or unique_violation then
    insert into results values ('picks: relabelling at the cap allowed', 'refused', 'ok');
  end;

  -- And the slot the index guards is freed the moment the label moves off
  -- the row that held it -- otherwise a restaurant gets one chef's
  -- special ever, not one at a time. This also leaves location A holding
  -- one, so the block after this one can prove the index is scoped to a
  -- restaurant rather than to the table.
  begin
    update menu_items set pick_label = 'chefs_special' where id = ids[2];
    insert into results values ('picks: the chef''s special slot is reusable', 'ok', 'ok');
  exception when check_violation or unique_violation then
    insert into results values ('picks: the chef''s special slot is reusable', 'refused', 'ok');
  end;

  -- A label the agent has no phrase for never reaches the column. The
  -- check constraint is the backstop under lib/admin/edit.ts's own
  -- validation, not a substitute for it.
  begin
    update menu_items set pick_label = 'house_favourite' where id = ids[1];
    insert into results values ('picks: unknown label refused', 'allowed', 'refused');
  exception when check_violation then
    insert into results values ('picks: unknown label refused', 'refused', 'refused');
  end;

  -- Clearing a label frees a slot.
  update menu_items set pick_label = null where id = ids[1];
  begin
    update menu_items set pick_label = 'best_seller' where id = ids[4];
    insert into results values ('picks: clearing one frees a slot', 'ok', 'ok');
  exception when check_violation then
    insert into results values ('picks: clearing one frees a slot', 'refused', 'ok');
  end;
end $$;

-- A second restaurant is counted separately. Nonna Rosa (location A) is
-- sitting at its cap of three from the block above; Rival Pizza (location
-- B, a fixture this file actually creates at the top -- not the
-- production-only location the earlier version of this test named) has
-- none, so marking its one item must succeed. This has to run as owner
-- B, not owner A: under RLS, a write to another org's row is filtered to
-- zero rows rather than raising, which produces a vacuous pass that never
-- touches the cap logic at all.
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

do $$
begin
  update menu_items set pick_label = 'best_seller'
   where location_id = 'b10c0000-0000-0000-0000-00000000000b'
     and name = 'Margherita';
  insert into results values ('picks: counted per restaurant', 'ok', 'ok');
exception when check_violation then
  insert into results values ('picks: counted per restaurant', 'refused', 'ok');
end $$;

-- And so is the chef's special. Nonna Rosa is holding one right now (the
-- block above left it that way on purpose), so an index keyed on nothing
-- but pick_label would refuse this and give every restaurant on the
-- platform a share of one label. It is keyed on location_id, and the
-- location_id it reads is the one menu_items_sync_location derived from
-- the category -- a BEFORE ROW trigger, which runs before any unique
-- index is consulted, so the spoofing route 20260817000200 had to close
-- for the cap does not exist here.
do $$
begin
  update menu_items set pick_label = 'chefs_special'
   where location_id = 'b10c0000-0000-0000-0000-00000000000b'
     and name = 'Margherita';
  insert into results values ('picks: one chef''s special EACH', 'ok', 'ok');
exception when unique_violation then
  insert into results values ('picks: one chef''s special EACH', 'refused', 'ok');
end $$;

-- ── moving an order ──────────────────────────────────────────────────
--
-- THESE ROWS READ FAIL UNTIL A HUMAN HAS APPLIED
-- 20260819000100_log_order_status_definer.sql, AND THAT IS THE POINT OF
-- THEM. The kitchen board's per-ticket control was blocked by the
-- database and not by the UI: `orders_log_status` fires AFTER INSERT OR
-- UPDATE OF status and inserts into `order_status_events`, which has RLS
-- enabled and no INSERT policy for `authenticated` -- so while that
-- trigger function was SECURITY INVOKER it ran as the owner, the log
-- INSERT was refused with 42501, and the UPDATE that fired it rolled back
-- with it. Confirmed live before the fix, inside a rolled-back
-- transaction: an owner's `update orders set status = 'preparing'` came
-- back REFUSED sqlstate 42501.
--
-- Back to owner A, who owns location A. The block above left owner B's
-- claims in place, and under RLS a write to another org's row is filtered
-- to zero rows rather than raising -- which would pass every assertion
-- here without touching the trigger at all.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

-- Every block below is guarded, including for exceptions it does not
-- expect: a raise with no handler aborts the whole enclosing transaction,
-- and this file's report and its own `reset role;` are statements in it.
do $$
begin
  insert into orders (id, location_id, customer_name, total_cents)
  values ('0d000000-0000-0000-0000-00000000000d',
          'a10c0000-0000-0000-0000-00000000000a', 'Phi', 2700);
  insert into results values ('orders: owner records a ticket', 'allowed', 'allowed');
exception
  when insufficient_privilege then
    -- The AFTER INSERT half of the same trigger, refused the same way.
    insert into results values ('orders: owner records a ticket', 'denied', 'allowed');
  when others then
    insert into results values ('orders: owner records a ticket', 'error ' || sqlstate, 'allowed');
end $$;

do $$
begin
  update orders set status = 'preparing'
   where id = '0d000000-0000-0000-0000-00000000000d';
  insert into results values ('orders: owner starts cooking a ticket', 'allowed', 'allowed');
exception
  when insufficient_privilege then
    insert into results values ('orders: owner starts cooking a ticket', 'denied', 'allowed');
  when others then
    insert into results values ('orders: owner starts cooking a ticket', 'error ' || sqlstate, 'allowed');
end $$;

insert into results
select 'orders: the move is in the log', count(*)::text, '1'
  from order_status_events
 where order_id = '0d000000-0000-0000-0000-00000000000d' and to_status = 'preparing';

-- THE CLAIM THAT MAKES SECURITY DEFINER SAFE HERE. The trigger now runs
-- as its owner, and `changed_by` must still be the person who pressed the
-- button: auth.uid() reads the request's JWT claims out of a GUC, which a
-- definer boundary does not touch. Verified independently against the
-- live database -- a SECURITY DEFINER function called by a statement
-- running as `authenticated` resolved the REQUEST's user, not its own
-- owner -- and pinned here so a later edit cannot quietly turn this log
-- into a record of which database role wrote it.
insert into results
select 'orders: the log names who moved it',
       coalesce(max(changed_by)::text, 'nobody'),
       '11111111-1111-1111-1111-111111111111'
  from order_status_events
 where order_id = '0d000000-0000-0000-0000-00000000000d' and to_status = 'preparing';

-- THE OTHER HALF OF THE DECISION, and the reason this was not closed with
-- `grant insert on order_status_events to authenticated` plus a policy. A
-- restaurant holding a direct INSERT could claim a ticket was ready at a
-- time it was not, against a user who pressed nothing, and this table is
-- the only record of who moved what and when. It stays a consequence of a
-- real status change. This row must read PASS both before and after the
-- migration.
do $$
begin
  insert into order_status_events (order_id, to_status, changed_by)
  values ('0d000000-0000-0000-0000-00000000000d', 'ready',
          '11111111-1111-1111-1111-111111111111');
  insert into results values ('orders: owner writes the log by hand', 'allowed', 'denied');
exception
  when insufficient_privilege then
    insert into results values ('orders: owner writes the log by hand', 'denied', 'denied');
  when others then
    insert into results values ('orders: owner writes the log by hand', 'error ' || sqlstate, 'denied');
end $$;

-- A rival's ticket is not raised at, it is filtered to nothing -- so this
-- counts rows changed rather than catching an exception, which is the
-- only way to tell a refusal apart from a write that found no row. The
-- row it aims at is a real one, inserted in the fixtures at the top: a
-- board that could move another restaurant's order is the failure this
-- whole file exists for, and it must not be able to pass by aiming at
-- nothing.
do $$
declare touched integer;
begin
  update orders set status = 'preparing'
   where id = '0d100000-0000-0000-0000-0000000000d1';
  get diagnostics touched = row_count;
  insert into results values ('orders: owner moves a rival ticket', touched::text, '0');
exception when others then
  insert into results values ('orders: owner moves a rival ticket', 'error ' || sqlstate, '0');
end $$;

reset role;

select case when got is not distinct from want then 'PASS' else 'FAIL' end as status,
       name, got, want
from results
order by (got is not distinct from want), name;

rollback;
