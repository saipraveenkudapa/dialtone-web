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

  // This used to do a second thing: if the signed-in user carried a
  // `business_name` in their metadata, it called the create_organization
  // RPC to finish a /signup that had been waiting on email confirmation.
  // That branch is gone, along with public signup and the RPC itself
  // (supabase/migrations/20260813120000_drop_create_organization.sql).
  //
  // Removing it was not tidying. Two accounts left over from testing that
  // flow still carry `business_name: "Marty's"` in their metadata and
  // belong to no organization; under the old code, either of them
  // signing in with a magic link would have silently minted a SECOND
  // organization called Marty's, owned by them, alongside the real one.
  // Restaurants are created by the operator now, and this route's only
  // job is exchanging a link for a session.
  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(`${origin}/login?error=link`);
}
