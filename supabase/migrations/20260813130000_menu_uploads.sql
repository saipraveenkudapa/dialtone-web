-- Menu uploads: the private bucket a photo or PDF of a menu lands in, and
-- the columns menu_imports needs to describe one file.
--
-- Nothing here puts a price in front of a caller. A file lands in
-- storage, a menu_imports row lands in 'pending', and the existing
-- CHECK on this table still refuses 'confirmed' without a confirmed_at.
-- Extraction, review and confirmation are later steps against these same
-- rows.

-- ── the bucket ───────────────────────────────────────────────────────
--
-- PRIVATE, and keyed by location: the first path segment is the tenant
-- boundary, exactly as call-recordings does it (`<location_id>/<file>`).
-- That bucket was created out of band before this repo kept buckets in
-- SQL, so this migration is the first one that writes a bucket down.
--
-- There is no public URL by design; reads are short-lived signed URLs,
-- so a link pasted into a group chat stops working.
--
-- The two limits are the server-side backstop the browser cannot argue
-- with: Storage refuses a body over the ceiling or a content type
-- outside the list no matter what the file picker allowed. The app
-- checks the same two facts before it issues an upload ticket and again
-- against the stored object's own metadata before it writes a row, so a
-- hand-rolled request cannot leave an oversized or unreadable file
-- behind with a menu_imports row pointing at it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'menu-uploads',
  'menu-uploads',
  false,
  10485760, -- 10 MiB: a phone photo of a menu, not a video of one.
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

-- Same shape as "staff read own recordings": membership in the owning
-- organization, resolved from the first path segment. The operator does
-- not appear here -- they are not a member of the customer's org, and
-- their upload goes through the service role behind an explicit
-- platform-admin check, the same posture as creating the restaurant.
create policy "staff read own menu uploads" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'menu-uploads'
    and app.can_access_location(((storage.foldername(name))[1])::uuid)
  );

create policy "staff add own menu uploads" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'menu-uploads'
    and app.can_access_location(((storage.foldername(name))[1])::uuid)
  );

-- A photo of the wrong menu has to be removable before anyone spends a
-- model call on it.
create policy "staff remove own menu uploads" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'menu-uploads'
    and app.can_access_location(((storage.foldername(name))[1])::uuid)
  );

-- ── menu_imports ─────────────────────────────────────────────────────
--
-- A menu is often three photos. Two ways to hold that: one row with a
-- list of paths, or one row per file grouped by a batch. This picks one
-- row per file.
--
-- The unit of storage and of removal is the file: the owner deletes the
-- blurry third photo, not an element of an array on a row that also owns
-- the extraction result. One row per file keeps source_path single and
-- honest, keeps source_type ('pdf' vs 'image') true of the thing it
-- describes when a batch mixes a PDF with a photo, and makes deleting an
-- upload a row delete plus an object delete rather than array surgery.
-- What a list would have given -- "these three photos are one menu" --
-- is batch_id, which costs one column and one index.
alter table menu_imports
  add column if not exists batch_id uuid not null default gen_random_uuid(),
  add column if not exists original_filename text,
  add column if not exists byte_size integer check (byte_size > 0),
  add column if not exists uploaded_by uuid references auth.users (id);

comment on column menu_imports.batch_id is
  'The files uploaded together as one menu. One row per file; extraction and review work on the batch.';
comment on column menu_imports.original_filename is
  'What the file was called on the owner''s phone. The stored path is a uuid, so this is the only name a human recognises.';
comment on column menu_imports.byte_size is
  'Size of the stored object, read back from Storage rather than taken from the client.';
comment on column menu_imports.uploaded_by is
  'Who put the file there -- an owner, or the operator creating the restaurant.';

-- An import that claims a file must have one. Only a 'url' source has no
-- stored object.
alter table menu_imports
  add constraint menu_imports_file_has_path
  check (source_type = 'url' or source_path is not null);

create index if not exists menu_imports_batch_idx on menu_imports (batch_id);
