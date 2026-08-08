"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAgentStatus } from "./AgentStatus";
import { LOCATION } from "@/lib/demo";

const NAV = [
  { href: "/dashboard", label: "Today" },
  { href: "/dashboard/calls", label: "Calls" },
  { href: "/dashboard/orders", label: "Orders", badge: "4" },
  { href: "/dashboard/menu", label: "Menu" },
  { href: "/dashboard/menu/live", label: "Manager screen" },
  { href: "/dashboard/settings", label: "Settings" },
];

export function Sidebar() {
  const pathname = usePathname();
  const { killOn, toggleKill } = useAgentStatus();

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="sidebar-brand">Dialtone</div>
        <div className="sidebar-location">
          {LOCATION.name} · {LOCATION.city}
        </div>
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
            {tab.badge ? (
              <span className="tag tag-accent badge">{tab.badge}</span>
            ) : null}
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
          className={`btn ${killOn ? "btn-restore" : "btn-danger"}`}
        >
          {killOn ? "Turn the agent back on" : "Kill switch"}
        </button>
      </div>
    </aside>
  );
}
