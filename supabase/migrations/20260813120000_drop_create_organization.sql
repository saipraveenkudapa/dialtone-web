-- Closing the last door a user could create their own restaurant through.
--
-- 20260812001000_signup_create_organization.sql added
-- public.create_organization(text): a SECURITY DEFINER function that let a
-- brand-new signed-in user, member of nothing, create an organization and
-- make themselves its owner. It was the right shape for the product it was
-- written for -- a public /signup page where restaurants made their own
-- accounts.
--
-- That product no longer exists. Restaurants are created by the operator,
-- from /admin/new, which creates the organization, the location, the hours,
-- the menu, the Vapi assistant AND the owner's login in one act, holding
-- the service-role key server-side (lib/provisioning/create-restaurant.ts).
-- Public signup is closed: /signup 404s and its action refuses.
--
-- Leaving this function granted to `authenticated` would leave a second way
-- in, and not a theoretical one. EXECUTE is granted to every signed-in user,
-- and PostgREST exposes it at POST /rest/v1/rpc/create_organization -- so any
-- restaurant owner holding the public anon key and their own session could
-- call it directly, with no page and no button, and mint an organization
-- this platform never agreed to. The web app itself no longer calls it from
-- anywhere: app/auth/callback/route.ts was its last caller, and that branch
-- is gone too (see that file for why -- two leftover accounts still carry a
-- `business_name` in their metadata and would each have minted a duplicate
-- organization on their next magic-link sign-in).
--
-- Dropped rather than merely revoked. A revoked function is a loaded gun
-- with the safety on: pg_default_acl in this database still carries
-- EXECUTE -> anon, authenticated for functions created in public, so any
-- future migration touching this signature would silently re-grant it. The
-- 20260812001000 migration says exactly this in its own self-check, which is
-- why that check is inverted rather than deleted below.
drop function if exists public.create_organization(text);

-- ── self-check ───────────────────────────────────────────────────────
--
-- The boundary this function used to cross must still be shut, and now
-- there must be nothing standing in the doorway either. If a future change
-- adds an INSERT policy to organizations, or re-creates this function,
-- creating a restaurant stops being something only an operator can do --
-- fail the migration rather than discover it in production.
do $$
begin
  assert not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'create_organization'
  ), 'create_organization must not exist -- the operator flow is the only way to create an organization';

  assert not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'organizations'
       and cmd in ('INSERT', 'ALL')
  ), 'organizations must have no INSERT policy -- only the service role may create one';

  assert not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'memberships'
       and cmd in ('INSERT', 'ALL')
       and roles::text[] @> array['anon']
  ), 'anon must never be able to write a membership';

  assert (select relrowsecurity from pg_class where oid = 'public.organizations'::regclass),
    'organizations must have row level security enabled';
  assert (select relrowsecurity from pg_class where oid = 'public.memberships'::regclass),
    'memberships must have row level security enabled';
end;
$$;
