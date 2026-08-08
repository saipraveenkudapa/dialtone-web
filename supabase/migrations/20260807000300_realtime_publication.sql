-- Realtime only broadcasts tables in this publication, and it starts
-- empty: without this, every subscription in the app reports SUBSCRIBED
-- and then silently receives nothing. The manager screen depends on
-- another manager's toggle arriving live, and the dashboard on a call
-- appearing without a refresh.
alter publication supabase_realtime add table menu_items;
alter publication supabase_realtime add table locations;
alter publication supabase_realtime add table calls;

-- Realtime applies the subscriber's own RLS policies to each change, so
-- these broadcasts stay tenant-scoped exactly like the queries do. The
-- client must hand the socket the user's token first (see
-- lib/supabase/realtime.ts) or it authenticates as anon and sees nothing.

-- A mutable search_path lets the caller decide which schema a function's
-- unqualified names resolve to. app.agent_location is the tenant boundary
-- for every agent policy, so pin all of them.
alter function app.touch_updated_at() set search_path = public;
alter function app.assign_order_number() set search_path = public;
alter function app.log_order_status() set search_path = public, auth;
alter function app.agent_location() set search_path = public;
