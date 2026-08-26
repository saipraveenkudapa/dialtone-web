-- Two hardening fixes for public.book_table (20260812000200_book_table.sql).
-- Neither changes its logic, signature or return shape -- the peak-
-- occupancy SQL is verified against lib/agent/availability.ts's seatsTaken
-- across seven fixtures and stays exactly as it is.

-- 1. Pin pg_temp out of the search path. `set search_path = public` still
--    lets Postgres search pg_temp first for unqualified relation names --
--    pg_temp is implicitly consulted ahead of every schema actually listed
--    -- so a caller able to CREATE TEMP TABLE bookings/locations inside
--    this SECURITY DEFINER function could shadow the real ones. Only
--    service_role and postgres can execute book_table today, so this is
--    hardening rather than a live hole, but it costs nothing and matches
--    the intent of 20260807000300_realtime_publication.sql's
--    "pin_function_search_paths" pass over app.*'s functions.
alter function public.book_table(
  uuid, timestamptz, integer, text, text, uuid
) set search_path = public, pg_temp;

-- 2. Close the silent re-grant vector, not just today's symptom of it.
--    pg_default_acl in this database still carries
--    `EXECUTE -> anon, authenticated` for functions created in public by
--    owners postgres and supabase_admin (confirmed live: both rows list
--    anon and authenticated in defaclacl). 20260812000200_book_table.sql's
--    revoke only touches the exact six-argument pg_proc row that exists
--    today, by name -- `create or replace` against that same signature
--    preserves the ACL, so the revoke holds across a routine reapply. But
--    any future migration that adds/changes a parameter, or drops and
--    recreates book_table, produces a *new* pg_proc row, which inherits
--    those defaults fresh and silently reopens EXECUTE to anon and
--    authenticated -- nothing before this assert would catch that. Since
--    book_table is SECURITY DEFINER and writes bookings by bypassing RLS,
--    that regression means any holder of the public anon key could book
--    into any restaurant. This turns the regression into a failed
--    migration instead of a silent grant.
do $$
begin
  assert not has_function_privilege(
    'anon',
    'public.book_table(uuid, timestamptz, integer, text, text, uuid)',
    'execute'
  ), 'book_table must not be executable by anon -- pg_default_acl re-grant regression';

  assert not has_function_privilege(
    'authenticated',
    'public.book_table(uuid, timestamptz, integer, text, text, uuid)',
    'execute'
  ), 'book_table must not be executable by authenticated -- pg_default_acl re-grant regression';
end;
$$;
