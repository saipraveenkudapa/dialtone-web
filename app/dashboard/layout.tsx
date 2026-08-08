import { AgentStatusProvider } from "@/components/AgentStatus";
import { MenuProvider } from "@/components/MenuStore";
import { Sidebar } from "@/components/Sidebar";
import { KillBanner } from "@/components/KillBanner";
import { getCurrentLocation, getMenu } from "@/lib/data";
import { supabaseConfigured } from "@/lib/supabase/env";

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

  const location = await getCurrentLocation();

  // Signed in, but no restaurant yet. Onboarding is not built; say so
  // plainly rather than rendering an empty dashboard.
  if (!location) {
    return (
      <div className="page">
        <h1>No restaurant yet</h1>
        <p className="text-muted">
          This account is not attached to a location. Onboarding is not built
          yet — seed one with <code>supabase db reset</code> for now.
        </p>
      </div>
    );
  }

  const categories = await getMenu(location.id);

  return (
    <AgentStatusProvider location={location}>
      <MenuProvider locationId={location.id} initialCategories={categories}>
        <div className="shell">
          <Sidebar />
          <main className="main">
            <KillBanner />
            <div className="page">{children}</div>
          </main>
        </div>
      </MenuProvider>
    </AgentStatusProvider>
  );
}
