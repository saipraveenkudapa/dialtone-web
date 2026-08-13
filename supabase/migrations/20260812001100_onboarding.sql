-- /onboarding: the form that takes a restaurant from "just signed up" to
-- "fully wired," with no script run by hand.
--
-- Two columns, both on locations:
--
--   onboarding_step   Where a half-finished signup resumes. Set forward
--                      only -- see app/onboarding/actions.ts -- so
--                      going back into an earlier step to fix a typo
--                      (the address, a tax rate) never rewinds where a
--                      reload lands. Nothing reads this once the location
--                      is fully wired: from that point on,
--                      agent_secret_hash is not null is what "onboarding
--                      is done" means (app/onboarding/page.tsx redirects
--                      to /dashboard on exactly that condition), because
--                      a location that finished onboarding but was
--                      re-opened here would otherwise regenerate a
--                      second, different tool secret and orphan the
--                      first -- see the finish step's own comment.
--
--   vapi_assistant_id  The Vapi assistant this location's tools and
--                      system prompt live on. Not load-bearing for
--                      correctness -- lib/vapi/provision.ts finds "the
--                      assistant for this location" the same way
--                      scripts/provision-vapi.mjs always has, by walking
--                      Vapi's own /assistant list for
--                      metadata.dialtone_location_id, so a NULL or stale
--                      value here can never cause a duplicate assistant
--                      or a lost one. Kept only so the dashboard and the
--                      operator console can show which assistant answers
--                      this location's calls without an extra Vapi call
--                      on every page load.
alter table locations
  add column onboarding_step text not null default 'business'
    check (onboarding_step in ('business', 'hours', 'money', 'menu')),
  add column vapi_assistant_id text;
