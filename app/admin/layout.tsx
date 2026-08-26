import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin/AdminNav";
import { currentPlatformAdmin } from "@/lib/admin/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { signOut } from "@/app/login/actions";

export const metadata = { title: "Operator console · Dialtone" };

/** Would /dashboard have a restaurant to show this user?
 *
 *  The same question getCurrentLocation() answers, asked for one column
 *  instead of a whole row, because the only caller just needs to decide
 *  whether to draw a link. It must stay on supabaseServer(): RLS is what
 *  makes this "does *this person* have a restaurant" rather than "does
 *  the platform have one". The service-role answer is true for every
 *  operator, which would put the link back in front of the accounts it
 *  exists to protect and land them on "No restaurant yet" again.
 *
 *  Fails closed. A hidden link is a cosmetic loss; a throw in a layout
 *  takes the whole operator console down with it. */
async function ownsRestaurant(): Promise<boolean> {
  try {
    const supabase = await supabaseServer();
    const { data, error } = await supabase
      .from("locations")
      .select("id")
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("[nav] locations probe failed", { code: error.code });
      return false;
    }
    return data !== null;
  } catch (err) {
    console.error("[nav] locations probe could not run", err);
    return false;
  }
}

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const admin = await currentPlatformAdmin();

  // notFound(), not a redirect: a signed-in restaurant owner poking at
  // /admin learns nothing about whether the route exists.
  if (!admin) notFound();

  // Only asked once we know this is staff, and only to decide whether to
  // draw one link. "My restaurant" used to sit here unconditionally and
  // pointed operator staff -- who belong to no organization on purpose --
  // at the "No restaurant yet" screen, which had no way back.
  const owns = await ownsRestaurant();

  return (
    <div className="admin-shell">
      <header className="admin-bar">
        <Link href="/admin" className="sidebar-brand admin-brand">
          Dialtone <span className="admin-tag">operator</span>
        </Link>
        {/* The bar is navigation. "New restaurant" used to be a
            btn-secondary here and a btn-primary in /admin's page-head;
            actions belong in the page-head, routes belong here. */}
        <AdminNav ownsRestaurant={owns} />
        <span className="text-muted admin-who">{admin.email}</span>
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
