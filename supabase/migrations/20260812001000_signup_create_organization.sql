-- Letting a restaurant owner make their own account.
--
-- Until now every account was hand-made in SQL, which is why Marty's has
-- a location, a menu and zero users: nobody can log in and look at it.
-- A public /signup page fixes that, and it runs straight into the RLS
-- boundary.
--
-- There is deliberately no INSERT policy on `organizations` (see
-- 20260807000200_rls.sql: org_read and org_write are both gated on
-- app.is_org_member / app.is_org_owner). That is correct and must stay
-- correct -- an authenticated user is a member of some restaurant, and a
-- member of one restaurant has no business creating rows in the tenancy
-- tables. But it means the very first act of a brand-new account, which
-- is by definition performed by a user who is a member of nothing, has
-- no policy that could ever admit it. Signup has to cross that boundary
-- from the outside.
--
-- Two ways across. The service-role key in a server action would work,
-- and it is the wrong one: that key bypasses RLS on every table in the
-- database, and this is the one route on the site that an anonymous
-- stranger on the internet is invited to POST to. Any bug in that action
-- -- a mis-scoped follow-up query, a logged error object, a future edit
-- by someone who did not read this comment -- is a total tenancy
-- compromise rather than a bad signup. lib/supabase/admin.ts says the
-- same thing in its own header, and its list of callers is "Twilio
-- webhooks", verified by signature, and nothing else.
--
-- So: the house pattern, the same one book_table and place_order use. A
-- SECURITY DEFINER function that bypasses RLS for exactly one operation
-- and nothing else. The safety argument is in the signature, not in the
-- body:
--
--   * The only parameter is the business name. There is no org id
--     parameter, so there is no value a caller could send that would
--     attach them to Nonna Rosa -- the org is always freshly INSERTed
--     with a generated id. Joining an existing restaurant is a different
--     act (an owner invites you) with a different door: the
--     membership_manage policy, which only an existing owner passes.
--   * There is no user id parameter either. The membership is written
--     for auth.uid() and can be written for nobody else, so a caller
--     cannot enrol a colleague, a stranger, or the platform admin.
--   * One membership per user, checked under a lock, so the function
--     cannot be used to mint organizations in a loop.
--
-- Everything a caller controls is the name of a row that did not exist a
-- moment ago and that only they can see.
--
-- The org and the membership go in together or not at all. An org with
-- no members is invisible to every policy in the database -- unreadable,
-- unwritable, undeletable by anyone including the person who just paid
-- for it, and only findable by an operator with the service key. That is
-- exactly the state Marty's is in today and the reason this page is
-- being built, so it is worth spending a transaction to make it
-- unreachable.
--
-- Lives in public rather than app because PostgREST only exposes public,
-- and the web app calls this over PostgREST as the signed-in user.
create or replace function public.create_organization(p_name text)
returns table (created boolean, org_id uuid, reason text)
language plpgsql
security definer
-- pg_temp pinned last: `set search_path = public` alone still lets
-- Postgres consult pg_temp first for unqualified names, so a caller who
-- can CREATE TEMP TABLE organizations could shadow the real one inside a
-- definer function. Same fix as 20260812000300_book_table_hardening.sql.
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid;
  v_name     text;
  v_existing uuid;
  v_org      uuid;
begin
  -- auth.uid() is read from the request's JWT, not from an argument.
  -- This is the whole tenancy story of this function.
  v_uid := auth.uid();

  if v_uid is null then
    -- anon cannot execute this function at all (see the revoke below),
    -- so this is the belt to that braces: if a future default-privilege
    -- re-grant ever hands anon EXECUTE again, the worst it gets is this
    -- sentence.
    return query select false, null::uuid, 'not_signed_in'::text;
    return;
  end if;

  v_name := btrim(coalesce(p_name, ''));

  if v_name = '' then
    return query select false, null::uuid, 'name_required'::text;
    return;
  end if;

  -- Long enough for "Nonna Rosa Trattoria & Wine Bar (Alameda)", short
  -- enough that nobody pastes a novel into a sidebar heading.
  if length(v_name) > 120 then
    return query select false, null::uuid, 'name_too_long'::text;
    return;
  end if;

  -- Serialised per user, not globally: two people signing up at the same
  -- moment never wait on each other, but a double-submitted form does.
  -- Without this, both requests read "no membership", both insert, and
  -- the owner ends up with two restaurants and a dashboard that shows
  -- whichever one sorts first. The check below has to happen under the
  -- lock to mean anything.
  perform pg_advisory_xact_lock(
    hashtext('dialtone.create_organization'),
    hashtext(v_uid::text)
  );

  select m.org_id into v_existing
    from memberships m
   where m.user_id = v_uid
   limit 1;

  if found then
    -- Not an error the caller has to see. A retried signup, a
    -- double-clicked button, or a confirmation link opened twice all land
    -- here, and the honest answer is "you already have one, here it is".
    return query select false, v_existing, 'already_member'::text;
    return;
  end if;

  insert into organizations (name) values (v_name) returning id into v_org;

  insert into memberships (user_id, org_id, role)
  values (v_uid, v_org, 'owner');

  return query select true, v_org, null::text;
end;
$$;

comment on function public.create_organization(text) is
  'Creates a new organization and makes the calling user its owner, '
  'atomically. Called by the /signup server action and by '
  '/auth/callback once a confirmed user lands with a session. Takes no '
  'org id and no user id by design: a caller can neither attach '
  'themselves to an organization that already exists nor create a '
  'membership for anybody but auth.uid().';

-- ── grants ───────────────────────────────────────────────────────────
--
-- This is the first function in this database that `authenticated` is
-- allowed to execute, and it has to be: the caller of signup is a real
-- signed-in user with no rows anywhere. anon is not granted it -- an
-- unauthenticated caller has no auth.uid() to own the result, so the
-- function could only ever create the orphan org described above.
revoke all on function public.create_organization(text) from public;
revoke all on function public.create_organization(text) from anon;
revoke all on function public.create_organization(text) from agent_service;
grant execute on function public.create_organization(text) to authenticated;

-- ── self-check ───────────────────────────────────────────────────────
--
-- pg_default_acl in this database still carries EXECUTE -> anon,
-- authenticated for functions created in public. The revoke above holds
-- for this exact pg_proc row, but any future migration that changes the
-- signature creates a fresh row that inherits the default again. For a
-- SECURITY DEFINER function that writes the tenancy tables, that
-- regression means anyone holding the public anon key can create
-- organizations. Fail the migration rather than discover it.
do $$
begin
  assert not has_function_privilege(
    'anon', 'public.create_organization(text)', 'execute'
  ), 'create_organization must not be executable by anon -- pg_default_acl re-grant regression';

  assert not has_function_privilege(
    'agent_service', 'public.create_organization(text)', 'execute'
  ), 'the voice agent must never create an organization';

  assert has_function_privilege(
    'authenticated', 'public.create_organization(text)', 'execute'
  ), 'a signed-in user must be able to create their own restaurant, or signup is dead';

  -- The boundary this function exists to cross must still be shut for
  -- everyone else. If somebody ever adds an INSERT policy to
  -- organizations, this function is no longer the only way in and this
  -- comment is a lie.
  assert not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'organizations'
       and cmd in ('INSERT', 'ALL')
  ), 'organizations must have no INSERT policy -- create_organization is the only way in';

  assert (select relrowsecurity from pg_class where oid = 'public.organizations'::regclass),
    'organizations must have row level security enabled';
  assert (select relrowsecurity from pg_class where oid = 'public.memberships'::regclass),
    'memberships must have row level security enabled';
end;
$$;
