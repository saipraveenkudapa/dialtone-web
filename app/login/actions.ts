"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { SET_PASSWORD_PATH, mustChangePassword } from "@/lib/auth/must-change-password";

export type AuthState = { error?: string; sent?: boolean };

/** Only ever redirect to a path on this site — never to a URL an attacker
 *  put in the query string. */
function safeNext(next: FormDataEntryValue | null) {
  const value = typeof next === "string" ? next : "";
  return value.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

export async function signInWithPassword(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  // Deliberately vague: a precise message tells an attacker which emails
  // have accounts.
  if (error) return { error: "That email and password did not match." };

  revalidatePath("/", "layout");

  // The middleware would bounce them there anyway on the next request.
  // Going straight saves a redirect the owner would otherwise watch
  // flicker past on the one screen they are most likely to distrust.
  if (mustChangePassword(data.user)) redirect(SET_PASSWORD_PATH);

  redirect(safeNext(formData.get("next")));
}

export async function sendMagicLink(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { error: "Enter your email." };

  const supabase = await supabaseServer();
  const origin = (await headers()).get("origin") ?? "";
  const next = safeNext(formData.get("next"));

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });

  if (error) return { error: "Could not send the link. Try again." };
  return { sent: true };
}

export async function signOut() {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
