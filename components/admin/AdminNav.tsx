"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The operator console's own nav.
 *
 *  A client component only because aria-current needs the current path,
 *  which a server layout is never given -- the same and only reason
 *  components/Sidebar.tsx is one. It holds no data and gates nothing. */
export function AdminNav({ ownsRestaurant }: { ownsRestaurant: boolean }) {
  const pathname = usePathname();

  // "My restaurant" appears only when there is one. It is a link out of
  // the console, so it must never be the reason somebody ends up on a
  // screen whose only control is Sign out. ownsRestaurant is a rendering
  // hint decided server-side, not a gate: forging it reveals a link to
  // /dashboard, which every signed-in account may already visit.
  const items = [
    { href: "/admin", label: "Every restaurant" },
    { href: "/admin/new", label: "New restaurant" },
    ...(ownsRestaurant ? [{ href: "/dashboard", label: "My restaurant" }] : []),
  ];

  return (
    // The system's own .nav, worn directly: layout, resting colour,
    // hover and the aria-current accent all come from industry.css, and
    // .admin-nav is only the delta this bar needs (see app.css).
    <nav className="nav admin-nav">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className="admin-nav-item"
          // Exact match only. On /admin/<id> no nav item is "the current
          // page" -- the back link on that page carries the section
          // context, and claiming otherwise misreports the page to a
          // screen reader.
          aria-current={pathname === item.href ? "page" : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
