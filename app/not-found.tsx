import Link from "next/link";

/* The 404 everyone else gets.
 *
 * Three real routes land here, none of them a typo:
 *
 *   * /signup, which calls notFound() outright -- public signup is
 *     closed on purpose (see app/signup/page.tsx).
 *   * app/admin/layout.tsx's notFound() for a signed-in caller who is
 *     not staff. That one is thrown from the layout, which sits ABOVE
 *     app/admin/not-found.tsx's boundary, so it falls through to here --
 *     which is what we want. A restaurant owner poking at /admin must
 *     not be shown a screen with "Every restaurant" on it.
 *   * anything genuinely mistyped.
 *
 * So this page says as little as possible and offers one exit. `/`
 * redirects to /dashboard, and both an owner and an operator have
 * somewhere to stand there.
 */
export const metadata = { title: "Not found · Dialtone" };

export default function NotFound() {
  return (
    <div className="auth-page">
      <div className="auth-head">
        <div className="sidebar-brand">Dialtone</div>
        <p className="text-muted">There is nothing at this address.</p>
      </div>
      <Link href="/" className="btn btn-secondary">
        Take me back
      </Link>
    </div>
  );
}
