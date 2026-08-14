"use client";

import Link from "next/link";

/* The operator console's error boundary.
 *
 * Both of the console's data readers throw on any Supabase error --
 * getPortfolio() at lib/admin/data.ts and getAdminLocation() beside it --
 * and lib/provisioning/go-live.ts now throws LocationReadError rather
 * than reporting a failed read as a missing restaurant. Without a
 * boundary in this segment, every one of those reached Next's built-in
 * error screen, which renders inside the ROOT layout only: no operator
 * bar, no nav, no Sign out. A transient database blip turned the console
 * into a screen with no way off it.
 *
 * This file sits inside /admin, so it renders WITHIN
 * app/admin/layout.tsx and the bar and its nav survive. It does not
 * cover app/admin/layout.tsx itself -- error.js never wraps the layout
 * beside it (see node_modules/next/dist/docs/.../error.md) -- which is
 * why that layout's own read fails closed instead of throwing.
 *
 * Error boundaries must be Client Components. This one holds no state
 * and reads nothing: `retry()` re-runs the server render, which is the
 * right offer, because the failure this most often shows is a read that
 * would work on the next attempt.
 */
export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/admin" className="row-link">
            ← Every restaurant
          </Link>
          <h1>That did not load</h1>
          <div className="text-muted sub">
            Something this page needed could not be read. Nothing was changed.
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => retry()}>
            Try again
          </button>
        </div>
      </div>

      <section className="panel">
        <p className="text-muted empty-note">
          Most often this is the database refusing one read for a moment, and trying again is
          enough. If it keeps happening, the server log has the detail — a server error is not
          spelled out here on purpose, because the text can carry things a browser has no business
          holding.
          {error.digest ? (
            <>
              {" "}
              Quote <span className="num">{error.digest}</span> when you go looking: it is the
              handle on this exact failure in the log.
            </>
          ) : null}
        </p>
      </section>
    </>
  );
}
