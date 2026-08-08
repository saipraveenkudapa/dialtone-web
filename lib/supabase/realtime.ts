"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

/** Hand the Realtime socket the signed-in user's token before subscribing.
 *
 *  Realtime applies RLS to every change it forwards, using the token the
 *  socket authenticated with. With cookie-based SSR sessions the browser
 *  client has not always loaded the session into memory by the time an
 *  effect subscribes, so the socket authenticates as `anon` — which can
 *  see none of these tables. The channel still reports SUBSCRIBED and then
 *  silently delivers nothing, which is exactly the failure the manager
 *  screen cannot afford. */
export async function primeRealtimeAuth(supabase: SupabaseClient) {
  const { data } = await supabase.auth.getSession();
  await supabase.realtime.setAuth(data.session?.access_token ?? null);
  return data.session?.access_token ?? null;
}
