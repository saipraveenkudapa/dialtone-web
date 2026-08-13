import "server-only";

import { supabaseServer } from "@/lib/supabase/server";
import { mustChangePassword } from "./must-change-password";

/* The same gate the middleware applies to routes, in the form a server
 * action can call.
 *
 * Both are needed and neither replaces the other. Middleware decides what
 * a browser may *load*; a "use server" export is a live HTTP endpoint that
 * anyone holding its action id can POST to without ever loading the page
 * that renders its button. /signup already made exactly that mistake once
 * -- the page was hidden and the action stayed reachable -- so every
 * action that writes tenant data asks this before it writes.
 */

/** True while the signed-in account is still using the password the
 *  operator generated for it.
 *
 *  Fails closed. If the token cannot be revalidated -- Supabase
 *  unreachable, key missing -- the honest answer is "I do not know
 *  whether this account has finished its handover", and the safe reading
 *  of that is "it has not". A refused note or an unmarked message is a
 *  nuisance; a write accepted from a session we could not verify is not.
 */
export async function passwordIsStillTemporary(): Promise<boolean> {
  try {
    const supabase = await supabaseServer();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return mustChangePassword(user);
  } catch (err) {
    console.error(
      "[auth] could not check whether this password is still temporary",
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}
