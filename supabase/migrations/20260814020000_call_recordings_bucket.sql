-- The call-recordings bucket, written down.
--
-- WHY THIS MIGRATION EXISTS. Until now the answer to "is the bucket that
-- holds our callers' voices still private?" was "yes, we believe so" --
-- the bucket and its policy were made by hand in the Supabase dashboard
-- before this repo kept buckets in SQL, and 20260813130000_menu_uploads
-- says so out loud at its own line 15. So the privacy flag and the
-- tenant boundary on the most sensitive artifact this product stores
-- were unversioned state that no migration, no test and no build gate
-- would notice changing. One toggle in a web console would have made
-- every recording in the product world-readable, and the object paths
-- are guessable by structure -- `<location_id>/<call_id>.<ext>`, two
-- uuids the operator console prints on screen. lib/admin/data.ts
-- reasons carefully about this policy's exact semantics; the policy
-- itself was not in the repo it reasons in.
--
-- Nothing here is a change of behaviour. It is the state that is already
-- meant to be true, declared so that it stays true and so that a fresh
-- environment gets it without anyone remembering.

-- ── the bucket ───────────────────────────────────────────────────────
--
-- PRIVATE, and keyed by location: the first path segment is the tenant
-- boundary, the same shape menu-uploads uses. Reads are short-lived
-- signed URLs (300 seconds, both in lib/data.ts for the owner and
-- lib/admin/data.ts for the operator), so a link pasted into a group
-- chat stops working.
--
-- `do update set public = false` rather than `do nothing`: on an
-- existing bucket this migration's whole job is to ASSERT the flag, and
-- do-nothing would leave a bucket somebody had switched public exactly
-- as it was found. Re-running it is how the flag gets put back.
--
-- No file_size_limit and no allowed_mime_types, deliberately. Two
-- writers put objects here -- app/api/vapi/webhook/route.ts uploads
-- audio/wav and app/api/twilio/recording/route.ts uploads audio/mpeg --
-- both with the service role, and a recording is roughly 2 MB per
-- minute of call with no ceiling on how long a caller talks. A limit
-- invented here would not reject a bad file, it would silently lose a
-- real call's audio. The size and type belong to whoever is writing.
insert into storage.buckets (id, name, public)
values ('call-recordings', 'call-recordings', false)
on conflict (id) do update set public = false;

-- ── who may read one ─────────────────────────────────────────────────
--
-- The policy lib/admin/data.ts names as "staff read own recordings":
-- membership in the owning organization, resolved from the first path
-- segment. Dropped first rather than guarded by an existence check --
-- the hand-made policy this replaces may carry a different predicate,
-- and the point of the migration is that the predicate in this file is
-- the one in force.
--
-- SELECT only. Nothing else needs a policy: both writers hold the
-- service-role key, which bypasses RLS, and a restaurant has no way to
-- upload or delete a recording -- retention is
-- locations.recording_retention_days, not a button. Operator staff are
-- members of no customer organization on purpose, so they do not appear
-- here either; their path is the service role behind an explicit
-- currentPlatformAdmin() check, the same posture as menu uploads.
drop policy if exists "staff read own recordings" on storage.objects;

create policy "staff read own recordings" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'call-recordings'
    and app.can_access_location(((storage.foldername(name))[1])::uuid)
  );
