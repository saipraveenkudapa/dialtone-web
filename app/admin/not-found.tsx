import Link from "next/link";

/* The operator's 404, and the reason it exists at all.
 *
 * Next's built-in not-found renders inside the ROOT layout only, so
 * every notFound() under /admin used to drop an operator onto "404 |
 * This page could not be found." with no operator bar, no nav and no
 * Sign out -- a harder dead end than the one this work was commissioned
 * to remove, and reachable without any mistake: a stale bookmark, or the
 * back button after a restaurant is removed.
 *
 * This file sits inside the /admin segment, so it renders WITHIN
 * app/admin/layout.tsx (not-found renders between loading and page --
 * see node_modules/next/dist/docs/.../not-found.md). The bar, the nav
 * and Sign out all survive, and the page adds its own way back.
 *
 * It is deliberately NOT where a non-admin lands: app/admin/layout.tsx's
 * notFound() is thrown from the layout itself, which is above this
 * boundary, so that one falls through to app/not-found.tsx and reveals
 * nothing about the console.
 */
export default function AdminNotFound() {
  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/admin" className="row-link">
            ← Every restaurant
          </Link>
          <h1>Not here</h1>
          <div className="text-muted sub">
            There is nothing at this address.
          </div>
        </div>
      </div>

      <section className="panel">
        <p className="text-muted empty-note">
          Usually this is a restaurant that has been removed, or a link that was copied before it
          was. The full list is one click away.
        </p>
      </section>
    </>
  );
}
