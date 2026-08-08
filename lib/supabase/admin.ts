import "server-only";

import { createClient } from "@supabase/supabase-js";

/** Service-role client. Bypasses RLS entirely.
 *
 *  Only Twilio webhooks use this: they are not a signed-in user, and the
 *  rows they write span whichever restaurant was dialled. Every request
 *  that reaches here has already had its X-Twilio-Signature verified.
 *
 *  Never import this from a component, and never hand this key to the
 *  voice agent -- the agent gets an agent_service token scoped to one
 *  location per call. */
export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Webhook storage is not configured: set NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY in .env.local (Supabase dashboard -> " +
        "Project Settings -> API -> service_role).",
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
