"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";

export type SignupState = { error?: string; sent?: boolean };

type CreateOrganizationResult = {
  created: boolean;
  org_id: string | null;
  reason: string | null;
};

const MAX_NAME_LENGTH = 120; // matches the check in create_organization

export async function signUp(
  _prev: SignupState,
  formData: FormData,
): Promise<SignupState> {
  const businessName = String(formData.get("businessName") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!businessName) return { error: "Enter your restaurant's name." };
  if (businessName.length > MAX_NAME_LENGTH) {
    return { error: "That name is too long. Try something shorter." };
  }
  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await supabaseServer();
  const origin = (await headers()).get("origin") ?? "";

  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // Stashed on the auth user so /auth/callback can finish the job
      // (create the organization) once a confirmation link is clicked and
      // there is finally a session to run the RPC under. See
      // supabase/migrations/20260812001000_signup_create_organization.sql.
      data: { business_name: businessName },
      emailRedirectTo: `${origin}/auth/callback?next=/dashboard`,
    },
  });

  if (signUpError) {
    // Confirm-email disabled: an existing confirmed user gets a real
    // error here instead of the obfuscated-user trick below.
    if (
      signUpError.code === "user_already_exists" ||
      /already registered/i.test(signUpError.message)
    ) {
      return { error: "An account with that email already exists. Sign in instead." };
    }
    // Whatever Supabase rejected the password for (too short, on a
    // breached-password list, etc.) -- its own message is specific and
    // does not leak whether the email exists, so it is safe to show.
    return { error: signUpError.message || "Could not create your account. Try again." };
  }

  // Confirm-email enabled: signing up with an email that already has a
  // confirmed account returns success with no error, but an obfuscated
  // user with no new identity. Same user-facing outcome as the error
  // above -- point them at sign-in instead of silently "sending" a
  // confirmation email that was never actually sent to them.
  if (signUpData.user && signUpData.user.identities?.length === 0) {
    return { error: "An account with that email already exists. Sign in instead." };
  }

  // signUp() may or may not have started a session, depending on whether
  // this project requires email confirmation. getUser() revalidates
  // against Supabase rather than trusting a cookie (see
  // lib/supabase/middleware.ts), so it is the honest way to tell --
  // calling the RPC without a real session just returns not_signed_in.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // No session yet. /auth/callback creates the organization once they
    // click the confirmation link and land back here with one.
    return { sent: true };
  }

  const { data, error: rpcError } = await supabase
    .rpc("create_organization", { p_name: businessName })
    .single<CreateOrganizationResult>();

  if (rpcError || !data) {
    // The auth account exists and is signed in; only the organization
    // failed to create. Nothing left to retry from this form -- signing
    // up again would just hit "already registered" above. Send them on:
    // /dashboard already explains "no restaurant yet" for exactly this
    // shape of account.
    console.error("[signup] create_organization RPC failed", rpcError?.code);
    revalidatePath("/", "layout");
    redirect("/dashboard");
  }

  if (!data.created && data.reason !== "already_member") {
    // name_required / name_too_long / not_signed_in: defensive-only,
    // since the checks above already rule out an empty/oversized name
    // and a missing session. Report it rather than redirect into a
    // dashboard that would just look broken.
    return { error: "Could not create your restaurant. Try a shorter name." };
  }

  // Either freshly created, or already_member from a retried/double
  // submit -- both mean the account is ready.
  revalidatePath("/", "layout");
  redirect("/dashboard");
}
