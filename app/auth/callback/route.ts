import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/** Magic-link and OAuth landing. Exchanges the code for a session cookie. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next") ?? "/dashboard";
  const next =
    nextParam.startsWith("/") && !nextParam.startsWith("//")
      ? nextParam
      : "/dashboard";

  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Finish a signup that had to wait on email confirmation. Only a
      // user who just came through /signup has business_name in their
      // metadata -- an ordinary magic-link sign-in never sets it, so an
      // existing member never runs into the RPC's name validation here.
      // See supabase/migrations/20260812001000_signup_create_organization.sql.
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const businessName = user?.user_metadata?.business_name;
      if (typeof businessName === "string" && businessName.trim()) {
        // Result deliberately ignored: created, already_member, and any
        // defensive validation failure all land the same way -- signed
        // in, headed to /dashboard, which explains a missing restaurant
        // if the RPC genuinely could not make one.
        await supabase.rpc("create_organization", { p_name: businessName });
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=link`);
}
