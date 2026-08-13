import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { mustChangePassword } from "@/lib/auth/must-change-password";
import { SetPasswordForm } from "@/components/SetPasswordForm";
import { signOut } from "@/app/login/actions";

export const metadata = { title: "Set your password · Dialtone" };

/** Where a brand-new restaurant lands the first time it signs in.
 *
 *  The middleware already sent them here and will keep doing so, so this
 *  page's own checks are not the gate -- they are what stops the screen
 *  rendering for somebody it would only confuse: a signed-out visitor who
 *  typed the URL, or an owner who set their password last month. */
export default async function SetPasswordPage() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");
  if (!mustChangePassword(user)) redirect("/dashboard");

  return (
    <div className="auth-page">
      <div className="auth-head">
        <div className="sidebar-brand">Dialtone</div>
        <p className="text-muted">One thing before you start.</p>
      </div>

      <SetPasswordForm email={user.email ?? ""} />

      {/* Without this, an operator who signed in on the owner's laptop --
          or an owner handed the wrong login -- is stuck on this screen
          with no way off it. */}
      <form action={signOut}>
        <button type="submit" className="btn btn-ghost">
          Sign out instead
        </button>
      </form>
    </div>
  );
}
