"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAgentStatus } from "./AgentStatus";
import { signOut } from "@/app/login/actions";

const NAV = [
  { href: "/dashboard", label: "Today" },
  { href: "/dashboard/calls", label: "Calls" },
  { href: "/dashboard/messages", label: "Messages" },
  { href: "/dashboard/orders", label: "Orders" },
  { href: "/dashboard/menu", label: "Menu" },
  { href: "/dashboard/menu/live", label: "Manager screen" },
  { href: "/dashboard/settings", label: "Settings" },
];

// isPlatformAdmin is decided server-side in app/dashboard/layout.tsx and
// is required, not defaulted: there is one call site, and whether an
// owner can see that /admin exists should be forced to be a decision.
export function Sidebar({ isPlatformAdmin }: { isPlatformAdmin: boolean }) {
  const pathname = usePathname();
  const { killOn, toggleKill, location, pending, error } = useAgentStatus();

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-brand">Dialtone</div>
        <div className="sidebar-location">{location.name}</div>
        {/* Staff arrive at a restaurant's dashboard from the console;
            without this the only way back is the browser's back button.
            It sits in the head, with the other navigation, and not in
            the foot under a red kill switch -- an escape hatch buried
            beneath a destructive control is one nobody finds.

            Owners never see it, and that is a security property, not
            styling: middleware.ts and app/admin/layout.tsx conspire so a
            signed-in restaurant owner cannot learn /admin exists. Do not
            "simplify" this conditional away. */}
        {isPlatformAdmin ? (
          <Link href="/admin" className="operator-back">
            ← Operator console
          </Link>
        ) : null}
      </div>

      <nav className="side-nav">
        {NAV.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className="side-nav-item"
            aria-current={pathname === tab.href ? "page" : undefined}
          >
            <span className="mark" />
            <span className="label">{tab.label}</span>
          </Link>
        ))}
      </nav>

      <div className="sidebar-foot">
        <h6>Agent status</h6>
        <div className="status-line">
          <span className={`status-dot ${killOn ? "off" : "live"}`} />
          <span>{killOn ? "Not answering" : "Answering calls"}</span>
        </div>
        <button
          type="button"
          onClick={toggleKill}
          disabled={pending}
          className={`btn ${killOn ? "btn-restore" : "btn-danger"}`}
        >
          {killOn ? "Turn the agent back on" : "Kill switch"}
        </button>
        {error ? <p className="auth-error">{error}</p> : null}
        <form action={signOut}>
          <button type="submit" className="btn btn-ghost sidebar-signout">
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
