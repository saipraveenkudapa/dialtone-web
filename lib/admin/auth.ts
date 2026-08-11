import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Is the signed-in user operator staff?
 *
 *  The check runs with the service role because platform_admins is not
 *  readable through PostgREST by anyone -- if users could read it, any
 *  account could enumerate who works here. */
export async function currentPlatformAdmin() {
  const supabase = await supabaseServer();

  // getUser() revalidates the token with Supabase. getSession() only
  // reads a cookie, which is not a basis for granting cross-tenant
  // access to every restaurant on the platform.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  // Fail closed. Anything that goes wrong here -- a missing service-role
  // key, a network blip -- must read as "not staff", never as staff and
  // never as a 500 that hints the route exists.
  try {
    const { data, error } = await supabaseAdmin()
      .from("platform_admins")
      .select("user_id, note")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error("[admin] platform_admins lookup failed", error);
      return null;
    }

    return data ? { userId: user.id, email: user.email ?? "", note: data.note } : null;
  } catch (err) {
    console.error("[admin] platform admin check could not run", err);
    return null;
  }
}
