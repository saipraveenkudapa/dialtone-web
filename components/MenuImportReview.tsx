"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMenu } from "./MenuStore";
import { money } from "@/lib/format";
import { INGREDIENTS_CAVEAT, type MenuExtraction } from "@/lib/menu-imports/extraction";
import {
  INGREDIENTS_NOTE,
  MAX_CATEGORY_NAME,
  MAX_ITEM_DESCRIPTION,
  MAX_ITEM_NAME,
  blankItem,
  draftFromExtraction,
  itemBlocker,
  itemCents,
  itemEdited,
  itemFlags,
  publishBlocker,
  reviewCounts,
  toPublishItems,
  usedCategories,
  type PublishMode,
  type ReviewDraft,
  type ReviewItem,
} from "@/lib/menu-imports/review";
import { publishMenuImport, type PublishOutcome } from "@/app/menu-imports/publish";
import type { MenuImportSourceType } from "@/lib/supabase/types";

/** The screen between a model's guess and a price read aloud to a caller.
 *
 *  Everything a model read is here, editable, with what it was unsure
 *  about flagged and the photograph it read from beside it. Nothing on
 *  this screen writes to the menu except Publish, and Publish is refused
 *  while a single item is unconfirmed.
 *
 *  There is deliberately no "confirm everything" button. It would take
 *  one click to undo the only thing this screen is for.
 *
 *  The draft lives in this component and nowhere else. It is not written
 *  back to raw_extraction -- that column is the record of what the model
 *  said, and a screen that edited it would destroy the only evidence in a
 *  later argument about a price. The cost is that a closed tab loses the
 *  work, which is why leaving with unconfirmed items asks first. */

export type ReviewFile = {
  index: number;
  filename: string | null;
  sourceType: MenuImportSourceType;
  url: string | null;
};

export function MenuImportReview({
  locationId,
  batchId,
  extraction,
  files,
}: {
  locationId: string;
  batchId: string;
  extraction: MenuExtraction;
  files: ReviewFile[];
}) {
  const { categories: liveCategories, itemCount: liveItemCount, soldOut } = useMenu();

  const [draft, setDraft] = useState<ReviewDraft>(() => draftFromExtraction(extraction));
  const [removed, setRemoved] = useState<ReviewItem[]>([]);
  const [shownFile, setShownFile] = useState(() => files[0]?.index ?? 0);
  const [mode, setMode] = useState<PublishMode>("add");
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<PublishOutcome | null>(null);

  const counts = reviewCounts(draft);
  const blocker = publishBlocker(draft);
  const sections = usedCategories(draft);

  const hasLiveMenu = liveItemCount > 0;

  // Closing the tab throws the review away, because the draft is not
  // stored anywhere -- see the note at the top of this file. Say so
  // before it happens rather than after.
  const unsaved = published === null && counts.total > 0;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const patch = useCallback((key: string, change: Partial<ReviewItem>) => {
    setDraft((prev) => ({
      ...prev,
      items: prev.items.map((item) => (item.key === key ? { ...item, ...change } : item)),
    }));
  }, []);

  /** An edit to a model's proposal un-confirms it: the confirmation was
   *  of the value that is no longer there. An item a person typed
   *  themselves stays confirmed -- there is no model guess on it for
   *  anybody to check. */
  const edit = useCallback(
    (item: ReviewItem, change: Partial<ReviewItem>) => {
      patch(item.key, { ...change, confirmed: item.origin === "human" });
    },
    [patch],
  );

  const remove = useCallback((item: ReviewItem) => {
    setRemoved((prev) => [item, ...prev]);
    setDraft((prev) => ({ ...prev, items: prev.items.filter((i) => i.key !== item.key) }));
  }, []);

  const putBack = useCallback((item: ReviewItem) => {
    setRemoved((prev) => prev.filter((i) => i.key !== item.key));
    setDraft((prev) => {
      // Back where it was: the model's own order is the order the card
      // prints, and an item that reappears at the bottom of its section
      // is a small lie about the menu.
      const items = [...prev.items, item].sort((a, b) => a.key.localeCompare(b.key, "en"));
      return { ...prev, items };
    });
  }, []);

  const add = useCallback((categoryKey: string) => {
    const item = blankItem(categoryKey, `h${crypto.randomUUID()}`);
    setDraft((prev) => ({ ...prev, items: [...prev.items, item] }));
  }, []);

  const renameSection = useCallback((key: string, name: string) => {
    setDraft((prev) => ({
      ...prev,
      categories: prev.categories.map((c) => (c.key === key ? { ...c, name } : c)),
    }));
  }, []);

  async function commit() {
    setPending(true);
    setError(null);
    const result = await publishMenuImport({
      locationId,
      batchId,
      mode,
      items: toPublishItems(draft),
    });
    setPending(false);
    setConfirming(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setPublished(result.published ?? null);
  }

  const soldOutCount = soldOut.length;

  const file = useMemo(
    () => files.find((f) => f.index === shownFile) ?? files[0] ?? null,
    [files, shownFile],
  );

  if (published) {
    return <Published outcome={published} batchFiles={files.length} />;
  }

  return (
    <div className="review">
      <div className="page-head">
        <div>
          <h1>Check this menu before it goes live</h1>
          <div className="text-muted sub">
            Read from {files.length} file{files.length === 1 ? "" : "s"}
            {extraction.document.language ? ` · ${extraction.document.language}` : ""} ·{" "}
            {counts.total} item{counts.total === 1 ? "" : "s"} proposed
          </div>
        </div>
        <div className="actions">
          <Link href="/dashboard/menu" className="btn btn-secondary">
            ← Menu
          </Link>
        </div>
      </div>

      <p className="text-muted review-lede">
        None of this is on the menu yet, and the assistant cannot quote any of it. A model
        read it off the photos and may have read a price wrong — a wrong price quoted down
        the phone comes out of your pocket. Check each item against the picture and confirm
        it. Only then can the menu go live.
      </p>

      {/* The running count, and the only button that writes anything. */}
      <div className="card review-tally">
        <div className="review-tally-count">
          <span className="review-tally-number">{counts.unconfirmed}</span>
          <span className="review-tally-label">
            still to confirm, of {counts.total}
          </span>
        </div>
        <div className="review-tally-tags">
          {counts.unpriced > 0 ? (
            <span className="tag tag-outline">{counts.unpriced} with no price read</span>
          ) : null}
          {counts.flagged > 0 ? (
            <span className="tag tag-neutral">{counts.flagged} flagged, unchecked</span>
          ) : null}
          {counts.edited > 0 ? (
            <span className="tag tag-accent-2">{counts.edited} corrected</span>
          ) : null}
          {removed.length > 0 ? (
            <span className="tag tag-neutral">{removed.length} removed</span>
          ) : null}
        </div>
        <div className="review-tally-go">
          <button
            type="button"
            className="btn btn-primary"
            disabled={blocker !== null || pending}
            onClick={() => setConfirming(true)}
          >
            Publish to the live menu
          </button>
          <span className="text-muted setup-note">
            {blocker ?? "Every item is confirmed. This is the last step."}
          </span>
        </div>
      </div>

      {extraction.document.note ? (
        <p className="text-muted review-note">
          What the reader said: {extraction.document.note}
        </p>
      ) : null}

      {error ? <p className="setup-error">{error}</p> : null}

      <div className="review-split">
        <div className="review-list">
          {sections.length === 0 ? (
            <p className="text-muted empty-note">
              Every item has been removed. There is nothing left to publish — go back and
              discard this import instead.
            </p>
          ) : null}

          {draft.categories.map((category) => {
            const items = draft.items.filter((i) => i.categoryKey === category.key);
            const gone = removed.filter((i) => i.categoryKey === category.key);
            if (items.length === 0 && gone.length === 0) return null;

            return (
              <section key={category.key} className="card review-section">
                <div className="review-section-head">
                  <div className="field">
                    <label htmlFor={`section-${category.key}`}>Section</label>
                    <input
                      id={`section-${category.key}`}
                      className="input"
                      type="text"
                      value={category.name}
                      maxLength={MAX_CATEGORY_NAME}
                      onChange={(e) => renameSection(category.key, e.target.value)}
                    />
                  </div>
                  {category.unsureName ? (
                    <span className="tag tag-outline">Heading was hard to read</span>
                  ) : null}
                  <span className="text-muted review-section-count">
                    {items.length} item{items.length === 1 ? "" : "s"}
                  </span>
                </div>

                {items.map((item) => (
                  <ItemCard
                    key={item.key}
                    item={item}
                    files={files}
                    onEdit={edit}
                    onConfirm={() => patch(item.key, { confirmed: true })}
                    onUnconfirm={() => patch(item.key, { confirmed: false })}
                    onRemove={() => remove(item)}
                    onShowFile={() => setShownFile(item.fileIndex)}
                  />
                ))}

                {gone.length > 0 ? (
                  <ul className="review-removed">
                    {gone.map((item) => (
                      <li key={item.key}>
                        <span className="text-muted">
                          Removed: {item.name.trim() || "an item with no name"}
                        </span>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => putBack(item)}
                        >
                          Put it back
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <button
                  type="button"
                  className="btn btn-secondary review-add"
                  onClick={() => add(category.key)}
                >
                  Add an item the reader missed
                </button>
              </section>
            );
          })}
        </div>

        <aside className="review-source">
          <div className="card review-source-card">
            <h3>What was uploaded</h3>
            <p className="text-muted setup-note">
              Check every price against this. The link expires an hour after this page was
              opened; reload to get a fresh one.
            </p>

            {files.length > 1 ? (
              <div className="seg review-files">
                {files.map((f) => (
                  <label key={f.index} className="seg-opt">
                    <input
                      type="radio"
                      name="review-file"
                      checked={shownFile === f.index}
                      onChange={() => setShownFile(f.index)}
                    />
                    {f.filename ?? `File ${f.index + 1}`}
                  </label>
                ))}
              </div>
            ) : null}

            {file?.url ? (
              <>
                {file.sourceType === "pdf" ? (
                  <iframe
                    className="review-image"
                    src={file.url}
                    title={file.filename ?? "Uploaded menu"}
                  />
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element --
                     a signed, expiring URL into a private bucket is not
                     something next/image can proxy or optimise. */
                  <img
                    className="review-image"
                    src={file.url}
                    alt={`The uploaded menu, ${file.filename ?? "file"}`}
                  />
                )}
                <a
                  className="upload-link"
                  href={file.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open it full size in a new tab
                </a>
              </>
            ) : (
              <p className="text-muted empty-note">That file could not be opened.</p>
            )}

            <p className="text-muted setup-note">{INGREDIENTS_NOTE}</p>
          </div>
        </aside>
      </div>

      {confirming ? (
        <PublishDialog
          mode={mode}
          setMode={setMode}
          hasLiveMenu={hasLiveMenu}
          liveItemCount={liveItemCount}
          liveCategoryCount={liveCategories.length}
          soldOutCount={soldOutCount}
          items={counts.total}
          sections={sections.length}
          pending={pending}
          onCancel={() => setConfirming(false)}
          onPublish={() => void commit()}
        />
      ) : null}
    </div>
  );
}

/* ── one item ───────────────────────────────────────────────────────── */

function ItemCard({
  item,
  files,
  onEdit,
  onConfirm,
  onUnconfirm,
  onRemove,
  onShowFile,
}: {
  item: ReviewItem;
  files: ReviewFile[];
  onEdit: (item: ReviewItem, change: Partial<ReviewItem>) => void;
  onConfirm: () => void;
  onUnconfirm: () => void;
  onRemove: () => void;
  onShowFile: () => void;
}) {
  const flags = itemFlags(item);
  const blocker = itemBlocker(item);
  const cents = itemCents(item);
  const edited = itemEdited(item);
  const source = files.find((f) => f.index === item.fileIndex);

  const state = item.confirmed
    ? "is-confirmed"
    : flags.length > 0
      ? "is-flagged"
      : "is-open";

  return (
    <div className={`review-item ${state}`}>
      <div className="review-item-head">
        <span className="review-item-name">
          {item.name.trim() || "Untitled item"}
        </span>
        <span className="num review-item-price">
          {cents === null ? "—" : money(cents)}
        </span>
        {edited ? <span className="tag tag-accent-2">Corrected</span> : null}
        {item.origin === "human" ? <span className="tag tag-accent">Added by you</span> : null}
        <span className={item.confirmed ? "tag tag-accent" : "tag tag-outline"}>
          {item.confirmed ? "Confirmed" : "To check"}
        </span>
      </div>

      {flags.length > 0 && !item.confirmed ? (
        <ul className="review-flags">
          {flags.map((flag) => (
            <li key={flag}>{flag}</li>
          ))}
        </ul>
      ) : null}

      <div className="review-fields">
        <div className="field review-field-name">
          <label htmlFor={`name-${item.key}`}>Item</label>
          <input
            id={`name-${item.key}`}
            className="input"
            type="text"
            value={item.name}
            maxLength={MAX_ITEM_NAME}
            onChange={(e) => onEdit(item, { name: e.target.value })}
          />
        </div>

        <div className="field review-field-price">
          <label htmlFor={`price-${item.key}`}>Price ($)</label>
          <input
            id={`price-${item.key}`}
            className="input"
            type="text"
            inputMode="decimal"
            placeholder="12.50"
            value={item.price}
            onChange={(e) => onEdit(item, { price: e.target.value })}
          />
          <span className="price-preview text-muted">
            {item.price.trim() === ""
              ? "No price yet."
              : cents === null
                ? "Not a plain amount."
                : `Stores ${cents}¢ (${money(cents)}).`}
          </span>
        </div>

        <div className="field review-field-desc">
          <label htmlFor={`desc-${item.key}`}>Description</label>
          <input
            id={`desc-${item.key}`}
            className="input"
            type="text"
            value={item.description}
            maxLength={MAX_ITEM_DESCRIPTION}
            onChange={(e) => onEdit(item, { description: e.target.value })}
          />
        </div>

        <div className="field review-field-ing">
          <label htmlFor={`ing-${item.key}`}>Ingredients printed on the card</label>
          <input
            id={`ing-${item.key}`}
            className="input"
            type="text"
            value={item.ingredients}
            onChange={(e) => onEdit(item, { ingredients: e.target.value })}
          />
          <span className="price-preview text-muted review-ing-note">
            Not published on their own.
          </span>
        </div>
      </div>

      {item.said && item.said.priceAsPrinted && !item.said.priceKnown ? (
        <p className="text-muted review-said">
          The card prints “{item.said.priceAsPrinted}” here, which is not an amount the
          assistant can quote. Type what a caller should be told.
        </p>
      ) : null}

      {item.said && edited ? (
        <p className="text-muted review-said">
          The reader proposed: {item.said.name}
          {item.said.priceCents !== null ? ` · ${money(item.said.priceCents)}` : ""}
          {item.said.description ? ` · ${item.said.description}` : ""}
        </p>
      ) : null}

      <div className="review-item-actions">
        {item.ingredients.trim() !== "" ? (
          <button
            type="button"
            className="btn btn-ghost"
            title={INGREDIENTS_CAVEAT}
            onClick={() =>
              onEdit(item, {
                description: [item.description.trim(), item.ingredients.trim()]
                  .filter(Boolean)
                  .join(". ")
                  .slice(0, MAX_ITEM_DESCRIPTION),
              })
            }
          >
            Put the ingredients in the description
          </button>
        ) : null}

        {source ? (
          <button type="button" className="btn btn-ghost" onClick={onShowFile}>
            Show {source.filename ?? `file ${source.index + 1}`}
          </button>
        ) : null}

        <button type="button" className="btn btn-ghost" onClick={onRemove}>
          Remove — the reader invented this
        </button>

        {item.confirmed ? (
          <button type="button" className="btn btn-secondary" onClick={onUnconfirm}>
            Unconfirm
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={blocker !== null}
            onClick={onConfirm}
          >
            Confirm this item
          </button>
        )}
      </div>

      {blocker && !item.confirmed ? <p className="setup-error">{blocker}</p> : null}
    </div>
  );
}

/* ── the last click ─────────────────────────────────────────────────── */

/** Replace or add, decided here, with the consequence counted rather than
 *  described. `add` is the default and it is the safe one: it destroys
 *  nothing, so a mistake is undone item by item in the menu editor.
 *  `replace` exists because the common reason to photograph a menu is
 *  that the old one is wrong, and an old item the assistant still quotes
 *  is exactly the wrong price this whole feature is about -- so it is
 *  offered, spelled out, and never the default. */
function PublishDialog({
  mode,
  setMode,
  hasLiveMenu,
  liveItemCount,
  liveCategoryCount,
  soldOutCount,
  items,
  sections,
  pending,
  onCancel,
  onPublish,
}: {
  mode: PublishMode;
  setMode: (mode: PublishMode) => void;
  hasLiveMenu: boolean;
  liveItemCount: number;
  liveCategoryCount: number;
  soldOutCount: number;
  items: number;
  sections: number;
  pending: boolean;
  onCancel: () => void;
  onPublish: () => void;
}) {
  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="publish-title"
    >
      <div className="dialog review-dialog">
        <div id="publish-title" className="dialog-title">
          Put {items} item{items === 1 ? "" : "s"} on the live menu?
        </div>
        <div className="dialog-body">
          {hasLiveMenu ? (
            <>
              <p>
                This restaurant already has {liveItemCount} item
                {liveItemCount === 1 ? "" : "s"} across {liveCategoryCount} section
                {liveCategoryCount === 1 ? "" : "s"}. Decide what happens to them.
              </p>

              <div className="seg review-modes">
                <label className="seg-opt">
                  <input
                    type="radio"
                    name="publish-mode"
                    checked={mode === "add"}
                    onChange={() => setMode("add")}
                  />
                  Add to the menu
                </label>
                <label className="seg-opt">
                  <input
                    type="radio"
                    name="publish-mode"
                    checked={mode === "replace"}
                    onChange={() => setMode("replace")}
                  />
                  Replace the menu
                </label>
              </div>

              {mode === "add" ? (
                <p className="review-consequence">
                  The {liveItemCount} item{liveItemCount === 1 ? "" : "s"} already on the
                  menu stay exactly as they are. The menu becomes{" "}
                  <strong>{liveItemCount + items} items</strong>. A section here with the
                  same name as one there is merged into it rather than repeated. If the
                  photos are of a menu that replaces the old one, the old prices will still
                  be quoted — choose Replace instead.
                </p>
              ) : (
                <p className="review-consequence review-consequence-hard">
                  <strong>
                    All {liveItemCount} item{liveItemCount === 1 ? "" : "s"} and{" "}
                    {liveCategoryCount} section{liveCategoryCount === 1 ? "" : "s"} on the
                    menu now are deleted
                  </strong>{" "}
                  and these {items} take their place.
                  {soldOutCount > 0
                    ? ` That includes ${soldOutCount} item${soldOutCount === 1 ? "" : "s"} a manager has flagged sold out; the flag goes with them.`
                    : ""}{" "}
                  Orders already taken keep their own copy of what was sold, so past tickets
                  still read correctly. Nothing else brings the old menu back.
                </p>
              )}
            </>
          ) : (
            <p>
              This restaurant has no menu yet, so these {items} item
              {items === 1 ? "" : "s"} in {sections} section
              {sections === 1 ? "" : "s"} become the whole of it.
            </p>
          )}

          <p>
            The assistant reads the menu fresh on every call, so it quotes these prices on
            the very next one — within seconds of this button.
          </p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending}
            onClick={onPublish}
          >
            {pending
              ? "Publishing…"
              : mode === "replace" && hasLiveMenu
                ? `Replace the menu with these ${items}`
                : `Put these ${items} on the menu`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── after ──────────────────────────────────────────────────────────── */

function Published({
  outcome,
  batchFiles,
}: {
  outcome: PublishOutcome;
  batchFiles: number;
}) {
  return (
    <div className="review">
      <div className="page-head">
        <div>
          <h1>This is the menu now</h1>
          <div className="text-muted sub">
            {outcome.itemsCreated} item{outcome.itemsCreated === 1 ? "" : "s"} added across{" "}
            {outcome.categoriesCreated} new section
            {outcome.categoriesCreated === 1 ? "" : "s"}
            {outcome.itemsRemoved > 0
              ? ` · ${outcome.itemsRemoved} old item${outcome.itemsRemoved === 1 ? "" : "s"} removed`
              : ""}
          </div>
        </div>
      </div>

      <div className="card blueprint setup-card review-done">
        <h2>The assistant quotes these prices on the next call</h2>
        <p>
          The menu is read fresh at the start of every call, so the change is already live —
          there is nothing else to press. The {batchFiles} uploaded file
          {batchFiles === 1 ? " is" : "s are"} kept, marked confirmed with your name and the
          time, so what was read and what you signed for can be compared later.
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
