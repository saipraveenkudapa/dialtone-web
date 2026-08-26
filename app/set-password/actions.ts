"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseEnv } from "@/lib/supabase/env";
import {
  MINIMUM_PASSWORD_LENGTH,
  MUST_CHANGE_PASSWORD_CLAIM,
  mustChangePassword,
} from "@/lib/auth/must-change-password";

/* Turning a handed-over credential into one only its owner knows.
 *
 * Order matters here more than anywhere else in this file's neighbourhood:
 * the flag is what stands between this account and every screen in the
 * product, so it is cleared last, and only on the strength of Supabase
 * having actually accepted the new password. A clear-then-change would
 * mean a network failure in the middle leaves an account through the gate
 * still using the password the operator read off their screen.
 *
 * Nothing here logs, stores or returns a password. The one place either
 * string goes is Supabase's own hashing endpoints. */

export type SetPasswordState = { error?: string };

export async function setOwnPassword(
  _prev: SetPasswordState,
  formData: FormData,
): Promise<SetPasswordState> {
  const supabase = await supabaseServer();

  // getUser(), not getSession(): this decides whether an account may
  // stop being gated, which is not a decision to make on a cookie the
  // browser could have written itself.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Not flagged means there is nothing here to do -- and, more to the
  // point, means this action must not be a way for a signed-in account to
  // change its password without knowing the current one. Anyone past the
  // handover uses a normal reset flow.
  if (!mustChangePassword(user)) redirect("/dashboard");

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  // Server-side, because the `minLength` on the input is a convenience
  // for a person typing and nothing at all to a POST.
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    return {
      error: `Use at least ${MINIMUM_PASSWORD_LENGTH} characters. Longer is better than clever.`,
    };
  }
  if (password !== confirm) {
    return { error: "Those two do not match. Type the same password in both boxes." };
  }

  const email = user.email ?? "";
  if (!email) {
    console.error("[set-password] a flagged account has no email address", user.id);
    return { error: "This account cannot set a password here. Contact Dialtone." };
  }

  // Keeping the temporary password would defeat the entire point: the
  // operator would still know it. Asked directly rather than inferred,
  // because the only thing that truly knows is Supabase.
  if (await isTheCurrentPassword(email, password)) {
    return {
      error:
        "That is the password you already have. Pick a different one -- the point of this " +
        "screen is that nobody else knows the next one.",
    };
  }

  // The user's own session does this, not the service role: changing a
  // password is theirs to do, and routing it through the admin key would
  // make this action a password-change endpoint for any account id it
  // could be talked into naming.
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    // Never log the error object whole -- Supabase echoes the request
    // body back on some failures, and the request body is a password.
    console.error("[set-password] Supabase refused the new password", error.code ?? error.name);
    // Belt and braces for the check above: newer GoTrue refuses a
    // password identical to the current one on its own.
    if (error.code === "same_password") {
      return { error: "That is the password you already have. Pick a different one." };
    }
    return { error: "That password was not accepted. Try a different one." };
  }

  // Only now, and only with the service role, because app_metadata is
  // deliberately not writable by the account it describes.
  const cleared = await supabaseAdmin().auth.admin.updateUserById(user.id, {
    app_metadata: { [MUST_CHANGE_PASSWORD_CLAIM]: null },
  });

  if (cleared.error) {
    // The password IS changed at this point -- the operator no longer
    // knows it, which was the whole objective -- but the gate is still
    // up. Say so plainly rather than bouncing them into a loop that will
    // now tell them their brand-new password is "the one you already
    // have", which is true and useless.
    console.error("[set-password] password changed but the flag did not clear", cleared.error.message);
    return {
      error:
        "Your password is changed -- use the new one from now on. Something went wrong lifting " +
        "the hold on this account, though. Tell Dialtone, and sign in again in a minute.",
    };
  }

  // The layout, the sidebar and every cached page were all rendered for
  // an account that could not go anywhere.
  revalidatePath("/", "layout");
  redirect("/dashboard");
}

/** Does this password already sign this account in?
 *
 *  Answered by asking Supabase, on a throwaway client that persists
 *  nothing: there is no hash to compare against on this side, and there
 *  must not be. `scope: "local"` on the way out so that proving the point
 *  revokes only the session this probe just minted -- the default is
 *  global, which would sign the user out of the tab they are standing in.
 *
 *  A wrong password is what this expects and is not an error worth
 *  logging; it is the answer "no". */
async function isTheCurrentPassword(email: string, candidate: string): Promise<boolean> {
  const { url, anonKey } = supabaseEnv();
  const probe = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await probe.auth.signInWithPassword({ email, password: candidate });
  if (error || !data.session) return false;

  await probe.auth.signOut({ scope: "local" });
  return true;
}
