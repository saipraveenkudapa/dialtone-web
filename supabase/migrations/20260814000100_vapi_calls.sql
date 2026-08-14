-- A Vapi call has no Twilio SID, and until now no row could say so.
--
-- calls.twilio_call_sid shipped as `text not null unique` because every
-- call this product had ever seen arrived through a Twilio webhook. The
-- live number is Vapi-provisioned and bound straight to an assistant:
-- its calls report phoneCallProvider "vapi" and transport.provider
-- "vapi.sip", and carry no Twilio SID at all. So every insert for a real
-- call violated this constraint, which is the structural reason call
-- logging could not simply have been "wired up" -- a webhook route alone
-- would have failed at the database on every delivery.
alter table calls alter column twilio_call_sid drop not null;

-- What deliberately does NOT change here:
--
--   * The UNIQUE on twilio_call_sid. Postgres treats NULLs as distinct,
--     so any number of Vapi rows may carry NULL while Twilio's own
--     upsert (app/api/twilio/voice/route.ts, onConflict:
--     "twilio_call_sid") keeps working unchanged.
--
--   * calls_provider_call_id_idx, the UNIQUE index on provider_call_id
--     added in 20260812000100_agent_config.sql. It is unique globally
--     rather than per location, and that is worth keeping: a Vapi call
--     id is globally unique, so a global constraint means one call id
--     can belong to exactly one row, and one location, forever.
--
--     It does mean the index must never be used as an UPSERT conflict
--     target, because the conflict target would then come from the
--     request body while location_id came from the authenticated
--     secret -- letting a report authenticated for one restaurant match
--     and rewrite another restaurant's row. app/api/vapi/webhook does
--     not upsert for exactly that reason: it selects scoped by
--     (location_id, provider_call_id) and then inserts or updates by
--     primary key, so the tenant column is part of every write
--     predicate. A row belonging to another location is invisible to
--     the select, and the insert that follows is refused by this index
--     rather than silently stealing it.

comment on column calls.twilio_call_sid is
  'Twilio''s call SID, or NULL for a call that did not come through Twilio. '
  'A Vapi-provisioned number has no Twilio SID; provider_call_id carries '
  'Vapi''s own call id instead. Never write one provider''s id into the '
  'other''s column: twilio_call_sid is an upsert key for the Twilio '
  'webhooks, and mixing the two namespaces in one globally-unique column '
  'would poison it.';
