import Link from "next/link";
import { notFound } from "next/navigation";
import { currentPlatformAdmin } from "@/lib/admin/auth";
import { signOut } from "@/app/login/actions";

export const metadata = { title: "Operator console · Dialtone" };

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const admin = await currentPlatformAdmin();

  // notFound(), not a redirect: a signed-in restaurant owner poking at
  // /admin learns nothing about whether the route exists.
  if (!admin) notFound();

  return (
    <div className="admin-shell">
      <header className="admin-bar">
        <Link href="/admin" className="sidebar-brand admin-brand">
          Dialtone <span className="admin-tag">operator</span>
        </Link>
        <span className="text-muted admin-who">{admin.email}</span>
        <Link href="/admin/new" className="btn btn-secondary">
          New restaurant
        </Link>
        <Link href="/dashboard" className="btn btn-ghost">
          My restaurant
        </Link>
        <form action={signOut}>
          <button type="submit" className="btn btn-ghost">
            Sign out
          </button>
        </form>
      </header>
      <div className="page">{children}</div>
    </div>
  );
}
