import Link from "next/link";
import { AgentStatusProvider } from "@/components/AgentStatus";
import { MenuProvider } from "@/components/MenuStore";
import { Sidebar } from "@/components/Sidebar";
import { KillBanner } from "@/components/KillBanner";
import { currentPlatformAdmin } from "@/lib/admin/auth";
import { getCurrentLocation, getMenu } from "@/lib/data";
import { supabaseConfigured } from "@/lib/supabase/env";
import { signOut } from "@/app/login/actions";

export default async function DashboardLayout({
  children,
}: LayoutProps<"/dashboard">) {
  // Before the environment is set up, say what to do instead of throwing
  // a stack trace at whoever just cloned the repo.
  if (!supabaseConfigured()) {
    return (
      <div className="page">
        <h1>Set up Supabase</h1>
        <p className="text-muted">
          Copy <code>.env.example</code> to <code>.env.local</code> and set{" "}
          <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>. Run{" "}
          <code>supabase start</code> for local values, then{" "}
          <code>supabase db reset</code> to load the schema and demo data.
        </p>
      </div>
    );
  }

  // In parallel: two independent round trips, and the admin check is only
  // ever used to decide whether to draw a link back to the console. It is
  // a server-side check on purpose -- a restaurant owner must see no trace
  // that /admin exists, and currentPlatformAdmin() fails closed to null.
  const [location, admin] = await Promise.all([
    getCurrentLocation(),
    currentPlatformAdmin(),
  ]);

  // Signed in, but attached to no restaurant. There is deliberately
  // nothing to offer here any more: restaurants are created by the
  // operator (app/admin/new), which creates the owner's login and the
  // location together, so an account in this state is not a half-finished
  // signup waiting to be completed -- it is an account that should not
  // exist, or one whose restaurant was removed. Offering a "set one up"
  // button would be the second way to create a restaurant this product
  // deliberately does not have.
  if (!location) {
    return (
      <div className="page">
        <h1>No restaurant yet</h1>
        {admin ? (
          // Staff land here whenever they follow a link to /dashboard --
          // they belong to no organization on purpose. Telling them to
          // "ask your contact at Dialtone" is telling them to ask
          // themselves, so they get the sentence that is true for them.
          <p className="text-muted">
            This operator account is not attached to a restaurant, which is how
            operator accounts are meant to be. Everything you run the platform
            with is in the console.
          </p>
        ) : (
          <p className="text-muted">
            This account is not attached to a restaurant. Dialtone sets those up — ask
            your contact there to attach this account, or sign in with the address
            they gave you.
          </p>
        )}
        {/* The link staff need, above the button an owner needs. Without
            one of these the account is stuck: no sidebar here means no
            other way off this screen. The link comes first because it is
            the constructive exit -- nobody should have to consider
            destroying their session to leave a screen they reached by
            clicking a link in their own console. */}
        {admin ? (
          <Link href="/admin" className="operator-back">
            ← Operator console
          </Link>
        ) : null}
        <form action={signOut}>
          <button type="submit" className="btn btn-secondary">
            Sign out
          </button>
        </form>
      </div>
    );
  }

  const categories = await getMenu(location.id);

  return (
    <AgentStatusProvider location={location}>
      <MenuProvider locationId={location.id} initialCategories={categories}>
        <div className="shell">
          <Sidebar isPlatformAdmin={admin !== null} />
          <main className="main">
            <KillBanner />
            <div className="page">{children}</div>
          </main>
        </div>
      </MenuProvider>
    </AgentStatusProvider>
  );
}
