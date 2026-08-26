import Link from "next/link";
import { notFound } from "next/navigation";
import { MenuImportReview } from "@/components/MenuImportReview";
import { getCurrentLocation, getMenu, getMenuImportBatch } from "@/lib/data";
import { extractionHasItems } from "@/lib/menu-imports/extraction";
import { INGREDIENTS_NOTE } from "@/lib/menu-imports/review";
import { isUuid } from "@/lib/menu-imports/file";
import { dateTimeIn } from "@/lib/format";

export const metadata = { title: "Check a menu · Dialtone" };

/** The human gate for one batch of uploaded files.
 *
 *  A batch, not a single row: a menu is often three photos, they are read
 *  in one call so a section running across two of them stays one section,
 *  and every row of the batch carries the same reading. Reviewing one row
 *  at a time would show the same eighteen items three times and let
 *  somebody publish a third of a menu.
 *
 *  Everything here is read on the signed-in user's own session, so RLS
 *  decides. An import belonging to another restaurant is not
 *  distinguishable from one that does not exist. */
export default async function MenuImportReviewPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  if (!isUuid(batchId)) notFound();

  const location = await getCurrentLocation();
  if (!location) notFound();

  const batch = await getMenuImportBatch(location.id, batchId);
  if (!batch) notFound();

  // Signed for. This is also the screen somebody lands on the instant
  // they press Publish: the action revalidates this route, so the server
  // re-renders it and this branch replaces the review in place. It is
  // written for that moment first and for the person arriving a week
  // later second -- both need the same two facts, that the menu is live
  // and who signed for it.
  if (batch.status === "confirmed") {
    const at = batch.rows.find((row) => row.confirmed_at)?.confirmed_at ?? null;
    const menu = await getMenu(location.id);
    const items = menu.reduce((n, category) => n + category.items.length, 0);

    return (
      <div className="review">
        <div className="page-head">
          <div>
            <h1>This is the menu now</h1>
            <div className="text-muted sub">
              {items} item{items === 1 ? "" : "s"} across {menu.length} section
              {menu.length === 1 ? "" : "s"}
              {at ? ` · confirmed ${dateTimeIn(location.timezone, at)}` : ""}
            </div>
          </div>
        </div>

        <div className="card blueprint setup-card review-done">
          <h2>The assistant quotes these prices on the next call</h2>
          <p>
            The menu is read fresh at the start of every call, so this is already what a
            caller hears — there is nothing else to press. The {batch.rows.length} uploaded
            file{batch.rows.length === 1 ? " stays" : "s stay"} here, marked confirmed with
            who signed and when, so what a model read and what a person signed for can still
            be compared later.
          </p>
          <p>
            Corrections go to the menu itself from now on. A confirmed import is the record
            of what was signed for, not a working copy — editing it would destroy the only
            evidence in an argument about a price.
          </p>
          <p className="text-muted setup-note">{INGREDIENTS_NOTE}</p>
          <div className="cred-actions">
            <Link href="/dashboard/menu" className="btn btn-primary">
              See the menu
            </Link>
            <Link href="/dashboard/menu/live" className="btn btn-secondary">
              Manager screen
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (batch.status === "pending") {
    return (
      <div className="review">
        <div className="page-head">
          <h1>Not read yet</h1>
        </div>
        <div className="card blueprint setup-card">
          <h2>Nothing has been read out of these files</h2>
          <p>
            They are stored and nobody has spent a model call on them. Go back to the menu
            page and press “Read these files” to get a list to check.
          </p>
          <div className="cred-actions">
            <Link href="/dashboard/menu" className="btn btn-primary">
              Back to the menu
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Read, but nothing came back that anybody could confirm: a photo of a
  // parking meter, or a menu nothing could be made out of. The verdict is
  // shown rather than acted on -- a model calling a hand-lettered
  // chalkboard unreadable is exactly the call an owner overrules -- and
  // these rows are the ones discardMenuImport will still remove.
  const extraction = batch.extraction;
  if (!extraction || !extractionHasItems(batch.rows[0]?.raw_extraction)) {
    return (
      <div className="review">
        <div className="page-head">
          <h1>Nothing to check</h1>
        </div>
        <div className="card blueprint setup-card">
          <h2>No items came out of these files</h2>
          <p>
            {extraction?.document.note ??
              "What was read out of these files cannot be shown here."}
          </p>
          <p className="text-muted setup-note">
            Nothing was written to the menu, and nothing will be. Remove these files from
            the menu page and upload a sharper photo, or type the items in by hand.
          </p>
          <div className="cred-actions">
            <Link href="/dashboard/menu" className="btn btn-primary">
              Back to the menu
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <MenuImportReview
      locationId={location.id}
      batchId={batchId}
      extraction={extraction}
      files={batch.files.map((file) => ({
        index: file.index,
        filename: file.row.original_filename,
        sourceType: file.row.source_type,
        url: file.url,
      }))}
    />
  );
}
