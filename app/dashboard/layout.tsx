import { AgentStatusProvider } from "@/components/AgentStatus";
import { Sidebar } from "@/components/Sidebar";
import { KillBanner } from "@/components/KillBanner";

export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  return (
    <AgentStatusProvider>
      <div className="shell">
        <Sidebar />
        <main className="main">
          <KillBanner />
          <div className="page">{children}</div>
        </main>
      </div>
    </AgentStatusProvider>
  );
}
