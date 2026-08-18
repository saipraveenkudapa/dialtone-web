"use client";

import { useEffect, useState, useTransition } from "react";
import { Corners } from "@/components/Corners";
import {
  ReplacedNote,
  useSectionDirty,
  useSectionReplaced,
} from "@/components/admin/ConsoleTabs";
import { money } from "@/lib/format";
import { PICK_LABEL, UNTIL_LABEL } from "@/lib/menu";
import { parseDollarsToCents } from "@/lib/money";
import type {
  CategoryInput,
  EditResult,
  EditableCategory,
  EditableItem,
  MenuItemInput,
  PhoneSync,
} from "@/lib/admin/edit";

/* The operator's menu: categories and items, in full, for a restaurant
 * that is already answering the phone.
 *
 * WHY THIS IS NOT components/MenuEditor.tsx
 * -----------------------------------------
 * MenuEditor is the owner's screen and every write it makes goes through
 * MenuStore's optimistic writers, which call supabaseBrowser() -- the
 * signed-in user's own RLS session. The operator is deliberately NOT a
 * member of the restaurant's organization (see the header of
 * lib/provisioning/create-restaurant.ts), so every one of those writes
 * would be rejected and the owner's editor would sit there saying
 * "Could not rename that category. Try again." forever.
 *
 * So this screen writes through the gated server actions in
 * lib/admin/edit.ts instead, and takes them as props. What it does NOT
 * do is re-decide anything MenuEditor already decided: the price
 * confirmation dialog, the cents preview under every price box, the
 * category card, the item table and the dollar-in/cents-out rule are
 * that file's shapes and its class vocabulary, reproduced against a
 * different transport. See the report accompanying this file for the
 * line-by-line account of what was reused and what could not be.
 *
 * THE FORK IS RECORDED WHERE ITS CSS LIVES. app/app.css's "menu editor"
 * block header names both consumers and the two places they have already
 * diverged -- MenuEditor's .btn-icon reorder controls, which have no
 * counterpart here, and the blueprint frame this one wears because it
 * sits in /edit's stack. Every .menu-edit-* rule now has two call sites
 * to check, and that header is the only thing that can say so. The
 * cheaper shape, if this is ever reworked: an injectable write transport
 * on MenuProvider, so /admin renders MenuEditor itself.
 *
 * THE THIRD DIVERGENCE IS THE SHAPE OF THE LIST. MenuEditor stacks its
 * categories in one column and sets each one's items in a table; this
 * screen lays the categories out as a grid of cards (.menu-grid) and
 * sets the items inside each card as rows (.menu-item-list /
 * .menu-item-row), because on /edit the whole menu is one tab and the
 * question being asked of it is "which sections do we have, and what in
 * them are we not offering tonight" -- which is a question about the
 * heads of the cards, not about any one row. A five-column table cannot
 * survive a card this wide, so the table went; nothing it carried went
 * with it except its header row.
 *
 * NO OPTIMISM HERE, ON PURPOSE. MenuStore paints the change first and
 * rolls back on failure, because mid-service there is no save button.
 * This screen is the opposite situation: an operator with a restaurant
 * on the phone needs to be told what actually landed, and the server
 * action revalidates the page and hands these props back. A row that
 * says "Saved" here is a row Postgres has.
 *
 * THE PROMISE THIS SCREEN GETS TO MAKE. app/api/agent/menu/route.ts
 * queries Postgres on every call and is never cached into the
 * assistant's prompt, and public.place_order re-reads the price and the
 * sold-out state in the same statement that builds the line. So a price
 * saved here is what the agent quotes on the very next call, with
 * nothing to re-push and nothing that can half-fail -- which is why
 * lib/admin/edit.ts returns phone: "not-needed" from every action below.
 * It is written on the card because the operator has to be able to say
 * it down the phone while the owner is still on the line.
 *
 * NOTHING HERE IS A PERMISSION. Every action prop re-checks
 * currentPlatformAdmin() first, proves each category and item id belongs
 * to this location before it writes, and refuses a category from another
 * restaurant -- app.sync_menu_item_location would otherwise re-derive
 * location_id FROM THE CATEGORY and silently hand the dish to another
 * tenant. A <select> that only lists this location's categories is
 * ergonomics, not the defence.
 */

export type MenuAdminProps = {
  locationId: string;
  categories: EditableCategory[];
  /** Every item for this location, flat. Grouped by category here so a
   *  move between categories is one prop change rather than two. */
  items: EditableItem[];
  createCategoryAction: (locationId: string, input: CategoryInput) => Promise<EditResult>;
  saveCategoryAction: (
    locationId: string,
    categoryId: string,
    input: CategoryInput,
  ) => Promise<EditResult>;
  /** Takes its items with it -- menu_items.category_id is on delete cascade. */
  deleteCategoryAction: (locationId: string, categoryId: string) => Promise<EditResult>;
  createItemAction: (locationId: string, input: MenuItemInput) => Promise<EditResult>;
  saveItemAction: (
    locationId: string,
    itemId: string,
    input: MenuItemInput,
  ) => Promise<EditResult>;
  deleteItemAction: (locationId: string, itemId: string) => Promise<EditResult>;
  /** "" puts it back on sale. */
  setSoldOutAction: (locationId: string, itemId: string, until: string) => Promise<EditResult>;
  /** Which kind of pick a dish is; "" is not a pick. Its own action, like
   *  sold-out, because it is its own one-click control on the row --
   *  lib/admin/edit.ts's saveMenuItem deliberately does not write this
   *  column. */
  setPickAction: (locationId: string, itemId: string, label: string) => Promise<EditResult>;
};

const DROPPED: EditResult = {
  ok: false,
  error:
    "That did not come back — the connection dropped, or the request ran too long. Nothing " +
    "here knows whether it landed. Reload the page to see what the menu actually says.",
};

/** `ok: true` means the database was written and nothing more --
 *  lib/admin/edit.ts is explicit that `phone` is the only authority on
 *  whether the assistant agrees. Nothing on this screen edits a column
 *  that is baked into the assistant, so every result here should arrive
 *  "not-needed"; rendering the field anyway is what keeps that from
 *  quietly stopping being true. */
function phoneNote(phone: PhoneSync): string | null {
  switch (phone.state) {
    case "not-needed":
      return null;
    case "updated":
      return "The assistant was rebuilt as well.";
    case "no-assistant":
      return "There is no assistant on this restaurant yet.";
    case "failed":
      return (
        `The assistant could not be rebuilt: ${phone.reason} ` +
        "The phone is still on the old value."
      );
    case "secret-lost":
      return `${phone.reason} Repair the assistant on the go-live panel now.`;
  }
}

function useWrite() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<EditResult | null>(null);

  function run(act: () => Promise<EditResult>, onSaved?: () => void) {
    setResult(null);
    startTransition(async () => {
      try {
        const answer = await act();
        setResult(answer);
        if (answer.ok) onSaved?.();
      } catch {
        setResult(DROPPED);
      }
    });
  }

  return { pending, result, setResult, run };
}

/** The account of one write, in the two voices this product already
 *  uses: a refusal on .setup-error, everything else on .edit-status --
 *  the same split components/admin/EditSections.tsx makes, so a save on
 *  this screen and a save on the record editor read as one product.
 *
 *  The button that started the write never changes its label, which is
 *  why "Saving…" lives here. A control that resizes under the cursor
 *  mid-press is a control an operator stops trusting. */
function WriteResult({
  pending,
  result,
  dirty = false,
}: {
  pending: boolean;
  result: EditResult | null;
  /** Renders "Not saved yet." so a typed-in change is never mistaken for
   *  a saved one. */
  dirty?: boolean;
}) {
  if (!pending && result && !result.ok) return <p className="setup-error">{result.error}</p>;

  const phone = !pending && result?.ok ? phoneNote(result.phone) : null;
  const status = pending
    ? "Saving…"
    : result?.ok
      ? `${result.message}${phone ? ` ${phone}` : ""}`
      : dirty
        ? "Not saved yet."
        : "";

  return (
    <p className="edit-status" role="status" aria-live="polite">
      {status}
    </p>
  );
}

function useEscape(active: boolean, close: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, close]);
}

/** The same flattening lib/agent/orders.ts's matchItem does before it
 *  compares a spoken name to a menu row, and that lib/admin/edit.ts's
 *  normaliseItemName repeats for the write path. Repeated a third time
 *  rather than imported because that module is server-only and importing
 *  a value from it would drag the service-role client into the browser
 *  bundle. If either of the others changes, this must.
 *
 *  It only saves a round trip: the server refuses the duplicate either
 *  way. But the refusal matters -- two rows whose names normalise the
 *  same make every caller who says that dish an `ambiguous_item`, and
 *  the agent reads back two identical names, which is a question nobody
 *  can answer. */
function sameName(a: string, b: string): boolean {
  const flat = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  return flat(a) === flat(b);
}

/** A sort_order nothing distinguishes. `.order("sort_order")` leaves ties
 *  to Postgres, so the same menu can be read out in two different orders
 *  on two calls. Not an error, and not silent either. */
function tiedSortOrders(rows: { sort_order: number }[]): boolean {
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.sort_order)) return true;
    seen.add(row.sort_order);
  }
  return false;
}

export function MenuAdmin(props: MenuAdminProps) {
  const { locationId, categories, items, createCategoryAction, setSoldOutAction } = props;

  const { pending, result, run } = useWrite();
  const [name, setName] = useState("");

  const soldOut = items.filter((item) => item.sold_out_until !== null);
  const nextSort = categories.reduce((max, c) => Math.max(max, c.sort_order + 1), 0);
  /* The two rules, counted where they are true: per RESTAURANT. The row
     controls below carry the courtesy (an option that is certain to be
     refused is not offered), and the database carries the guarantee --
     menu_items_staff_pick_cap and menu_items_one_chefs_special_idx. What
     this card carries is the only thing neither of those can: that any
     of it exists at all. A restaurant with no picks yet has no chip on
     any row, which is exactly the restaurant whose operator reported
     seeing "no option in the menu to label them". */
  const picksUsed = items.filter((item) => item.pick_label !== null).length;
  const specialUsed = items.some((item) => item.pick_label === "chefs_special");

  /* Everything below is behind the Menu tab, and every reporter in it is
     OR'd into one "Unsaved" chip on that tab. This is the biggest panel
     on the page and the one whose typing is most likely to be a long way
     from the strip, so the chip is the only thing that can say a
     half-typed dish is still waiting. It also registers the beforeunload
     guard this field never had. Outside a <ConsoleTabs> -- on
     /dashboard/menu, or from a test -- the chip goes nowhere and the
     guard still works. */
  useSectionDirty("menu", name.trim() !== "");

  return (
    <>
      <section id="menu" className="card blueprint setup-card">
        <Corners />
        <h2>Menu</h2>
        <p className="text-muted sub">
          {items.length} item{items.length === 1 ? "" : "s"} across {categories.length}{" "}
          categor{categories.length === 1 ? "y" : "ies"}
          {soldOut.length > 0 ? `, ${soldOut.length} not offered` : ""}. Prices are typed in
          dollars and stored as whole cents; what will actually be stored is shown beside every
          price box.
        </p>

        {/* No chip. .tag.tag-outline is this feature's REBUILD mark --
            the flag on every baked field label, and the opener of all
            three "this also rebuilds the assistant" notes -- so wearing
            it here to assert the opposite is what makes an operator push
            a rebuild they did not need or skip one they did. The live
            notes in components/admin/EditSections.tsx carry none. */}
        <p className="edit-note is-live">
          The assistant reads the menu out of the database on every call — it is never baked into
          the assistant, so there is nothing to re-push and nothing on the phone that can be left
          on the old price. A price saved here is what the agent quotes on the very next call.
        </p>

        <form
          className="setup-row menu-edit-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || pending) return;
            run(
              () => createCategoryAction(locationId, { name, sortOrder: String(nextSort) }),
              () => setName(""),
            );
          }}
        >
          <div className="field">
            <label htmlFor="ma-new-category">New category</label>
            <input
              id="ma-new-category"
              className="input"
              type="text"
              placeholder="Contorni"
              maxLength={80}
              value={name}
              disabled={pending}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={pending || !name.trim()}
          >
            Add category
          </button>
        </form>
        <WriteResult pending={pending} result={result} />

        {/* Inside the card, not loose in the stack. .setup-stack is a
            column of framed blueprint sections separated by var(--space-6);
            a bare <p> between two of them reads as a fragment of the page
            rather than as this card's own note. */}
        {categories.length === 0 ? (
          <p className="text-muted empty-note">
            No categories yet. Add one above to start on items.
          </p>
        ) : null}

        {/* Not on a restaurant with no dishes: a rule about rows that do
            not exist is furniture on the emptiest version of this screen,
            and furniture is not read. */}
        {items.length > 0 ? (
          <p className="text-muted setup-note">
            Three dishes at a time can be picks. The assistant volunteers one of them once in a
            call, in the caller&rsquo;s own language — that the dish is one of your best
            sellers, or that it is the chef&rsquo;s special. Set one on any row, beside the
            sold-out control. Any number of dishes can be a best seller; only one can be the
            chef&rsquo;s special.
            {picksUsed >= 3 ? (
              <>
                {" "}
                Three dishes are already picked. Set one back to “not a pick” to choose another.
              </>
            ) : null}
            {specialUsed ? (
              <>
                {" "}
                One dish is already the chef&rsquo;s special, so that option is offered on that
                dish alone.
              </>
            ) : null}
          </p>
        ) : null}

        {tiedSortOrders(categories) ? (
          <p className="text-muted setup-note">
            Two categories share a sort order. Ties are resolved by nothing, so the assistant can
            read the menu&rsquo;s sections in a different order on different calls — give them
            distinct numbers.
          </p>
        ) : null}
      </section>

      <SoldOutNow
        locationId={locationId}
        soldOut={soldOut}
        setSoldOutAction={setSoldOutAction}
      />

      {/* One card per category, side by side instead of stacked. The
          operator's complaint was that a restaurant is a column you
          scroll to the bottom of; the answer is that a section is a
          thing you look at, whole, with its name and its counts on its
          head. Rendered only when there is something to put in it: an
          empty grid is still a child of the column above, and .setup-stack
          separates its children by var(--space-6) whether they have any
          height or not. */}
      {categories.length > 0 ? (
        <div className="menu-grid">
          {categories.map((category) => (
            <CategoryCard
              key={category.id}
              locationId={locationId}
              category={category}
              categoryItems={items.filter((item) => item.category_id === category.id)}
              allItems={items}
              categories={categories}
              saveCategoryAction={props.saveCategoryAction}
              deleteCategoryAction={props.deleteCategoryAction}
              createItemAction={props.createItemAction}
              saveItemAction={props.saveItemAction}
              deleteItemAction={props.deleteItemAction}
              setSoldOutAction={props.setSoldOutAction}
              setPickAction={props.setPickAction}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

/* ── what the kitchen has run out of ───────────────────────────────── */

/** The fastest-moving fact on the record, and the one an operator is
 *  most often phoned about mid-service. It also has to be visible from
 *  the top of the page: neither value expires on its own -- there is no
 *  job that clears "reopen" or "close" -- so an item flagged on Friday
 *  is still flagged on Monday unless a person unsets it. */
function SoldOutNow({
  locationId,
  soldOut,
  setSoldOutAction,
}: {
  locationId: string;
  soldOut: EditableItem[];
  setSoldOutAction: MenuAdminProps["setSoldOutAction"];
}) {
  const { pending, result, run } = useWrite();

  return (
    <section id="sold-out" className="card blueprint setup-card">
      <Corners />
      <h2>Sold out right now</h2>
      <p className="text-muted sub">
        The assistant stops offering these on the next call, and refuses them if a caller asks
        for one by name.
      </p>

      {soldOut.length === 0 ? (
        <p className="text-muted empty-note">
          Nothing is flagged. The agent is offering the whole menu.
        </p>
      ) : (
        <div className="soldout-list">
          {soldOut.map((item) => (
            <div key={item.id} className="soldout-row">
              <span>{item.name}</span>
              <span className="until">{UNTIL_LABEL[item.sold_out_until!]}</span>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={pending}
                onClick={() => run(() => setSoldOutAction(locationId, item.id, ""))}
              >
                Put back on sale
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-muted setup-note">
        Nothing clears these by itself — there is no job that puts an item back on sale
        overnight. Somebody has to unset it here or on the manager screen.
      </p>
      <WriteResult pending={pending} result={result} />
    </section>
  );
}

/* ── one category ──────────────────────────────────────────────────── */

function CategoryCard({
  locationId,
  category,
  categoryItems,
  allItems,
  categories,
  saveCategoryAction,
  deleteCategoryAction,
  createItemAction,
  saveItemAction,
  deleteItemAction,
  setSoldOutAction,
  setPickAction,
}: {
  locationId: string;
  category: EditableCategory;
  /** This category's items. */
  categoryItems: EditableItem[];
  /** Every item on the location, for the duplicate-name check -- a name
   *  only has to collide once anywhere on the menu to make every caller
   *  who says it an `ambiguous_item`. */
  allItems: EditableItem[];
  categories: EditableCategory[];
  saveCategoryAction: MenuAdminProps["saveCategoryAction"];
  deleteCategoryAction: MenuAdminProps["deleteCategoryAction"];
  createItemAction: MenuAdminProps["createItemAction"];
  saveItemAction: MenuAdminProps["saveItemAction"];
  deleteItemAction: MenuAdminProps["deleteItemAction"];
  setSoldOutAction: MenuAdminProps["setSoldOutAction"];
  setPickAction: MenuAdminProps["setPickAction"];
}) {
  const { pending, result, setResult, run } = useWrite();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [sortOrder, setSortOrder] = useState(String(category.sort_order));
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState(false);

  // By VALUE, not by identity. Every action on this route revalidates
  // the page, so a save anywhere on it -- a holiday, a dish flipped to
  // sold out -- hands this card a freshly deserialised object with the
  // same contents and a new identity. On `seen !== category` that
  // re-seeded a rename the operator had typed and not yet saved, with
  // nothing on screen saying it had gone.
  const seedCat = `${category.name}|${category.sort_order}`;
  const typedCat = `${name}|${sortOrder}`;
  const [seen, setSeen] = useState(seedCat);
  const [replaced, setReplaced] = useState(false);
  if (seen !== seedCat) {
    // ...and it no longer takes a rename in silence. Two conditions, so
    // the operator's own save is quiet: the field did not match what it
    // was seeded from, and it does not match what has just arrived.
    setReplaced(typedCat !== seen && typedCat !== seedCat);
    setSeen(seedCat);
    setName(category.name);
    setSortOrder(String(category.sort_order));
    // The message from the write that CAUSED this re-seed is deliberately
    // left standing: revalidatePath lands these props in the same commit
    // as the result, so clearing here would wipe "Saved." the instant it
    // was earned.
  }

  useEscape(confirming, () => setConfirming(false));

  // Deterministic on screen even when the numbers are not: sort_order,
  // then name, so an operator looking for the tie can see it.
  const ordered = [...categoryItems].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
  );
  const nextSort = categoryItems.reduce((max, item) => Math.max(max, item.sort_order + 1), 0);
  const count = categoryItems.length;
  const outCount = categoryItems.filter((item) => item.sold_out_until !== null).length;
  const dirty =
    editing && (name !== category.name || sortOrder !== String(category.sort_order));

  // The account of a loss stands until there is something new to lose.
  if (replaced && dirty) setReplaced(false);

  // The chip, and -- new here -- the beforeunload guard. A half-typed
  // rename had none: Ctrl-R destroyed it with no prompt of any kind.
  useSectionDirty("menu", dirty);
  useSectionReplaced("menu", replaced);

  return (
    /* .blueprint and the four registration marks, like every other card
       on this page. These sit as direct children of /edit's .setup-stack,
       between eight framed blueprint sections and the "What the system
       manages" one; without them the marks drop out across the tallest,
       densest region of the screen and it stops reading as the console
       the mockup draws. On /dashboard/menu the same class is the only
       card on the page, which is why it never showed there. */
    <div className="card blueprint menu-edit-cat">
      <Corners />
      <div className="menu-edit-cat-head">
        {editing ? (
          <form
            className="menu-edit-row-edit"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => saveCategoryAction(locationId, category.id, { name, sortOrder }), () =>
                setEditing(false),
              );
            }}
          >
            <div className="field">
              <label htmlFor={`ma-cat-name-${category.id}`}>Category name</label>
              <input
                id={`ma-cat-name-${category.id}`}
                className="input"
                type="text"
                maxLength={80}
                value={name}
                disabled={pending}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor={`ma-cat-sort-${category.id}`}>Sort order</label>
              <input
                id={`ma-cat-sort-${category.id}`}
                className="input"
                type="number"
                min={0}
                max={9999}
                value={sortOrder}
                disabled={pending}
                onChange={(e) => setSortOrder(e.target.value)}
              />
            </div>
            <button
              type="submit"
              className="btn btn-secondary"
              disabled={pending || !dirty || !name.trim()}
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={pending}
              onClick={() => {
                setName(category.name);
                setSortOrder(String(category.sort_order));
                setEditing(false);
                setResult(null);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <h3>{category.name}</h3>
            <div className="menu-edit-cat-controls">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={pending}
                onClick={() => setEditing(true)}
              >
                Rename
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={pending}
                onClick={() => setConfirming(true)}
              >
                Remove category
              </button>
            </div>
          </>
        )}
      </div>

      {/* What the owner asked to be able to see without opening anything:
          how many dishes this section has, and how many of them the
          assistant is currently refusing. The second chip is worded
          exactly as the chip on the rows below it, so the summary and the
          rows are provably the same fact, and it is absent rather than
          zero -- a scan down the grid finds the sections with a problem
          by there being a dark chip on them at all.

          Hidden while the rename form is open: "sort 3" beside a sort
          order box the operator has just typed 4 into is a stale number,
          which is why the note it replaces was in the non-editing branch
          too. */}
      {editing ? null : (
        <div className="card-meta">
          <span className="tag tag-neutral">
            {count} item{count === 1 ? "" : "s"}
          </span>
          {outCount > 0 ? <span className="tag tag-out">{outCount} not offered</span> : null}
          <span className="text-muted">sort {category.sort_order}</span>
        </div>
      )}

      {/* The account of a re-seed that landed on a typed rename. */}
      <ReplacedNote when={replaced} />

      <WriteResult pending={pending} result={result} dirty={dirty} />

      {ordered.length === 0 ? (
        <p className="text-muted empty-note">No items yet.</p>
      ) : (
        /* Rows, not a table. Five columns and a header row cannot be read
           in a card a third of the page wide, and the header was the only
           thing the change costs: every control below is the one that was
           in the cell beside it, writing what it wrote. */
        <div className="menu-item-list">
          {ordered.map((item) => (
            <ItemRow
              key={item.id}
              locationId={locationId}
              item={item}
              categories={categories}
              allItems={allItems}
              saveItemAction={saveItemAction}
              deleteItemAction={deleteItemAction}
              setSoldOutAction={setSoldOutAction}
              setPickAction={setPickAction}
            />
          ))}
        </div>
      )}

      {tiedSortOrders(ordered) ? (
        <p className="text-muted setup-note">
          Two items here share a sort order, so the assistant can read them out in a different
          order on different calls.
        </p>
      ) : null}

      {/* Asked for, not standing open. .add-item-form is three fields, a
          preview and a button, which wraps to four rows in a card this
          wide; a dozen categories each holding one open is most of a grid
          whose entire purpose is that the sections can be seen at once.
          The form is otherwise untouched -- same fields, same
          createItemAction, same duplicate-name refusal, same cents
          preview -- and it stays at the foot of its own card because that
          is the only thing on screen that says which category it adds to.

          HIDDEN, NOT UNMOUNTED, and for the same reason EditPanel hides
          the seven other sections instead of dropping them. `adding ?
          <AddItemForm/> : ...` took the form's name, price and
          description useState with it, so Cancel destroyed a typed-in
          dish with no dialog, no dirty check and nothing to restore it
          from -- from a button sitting 6.8px from the one that adds it,
          which is the identical hazard the Remove dialog forty lines up
          was written for. Cancel now only puts the form AWAY: what was
          typed is still in it when it comes back, and while it is away
          it goes on reporting "Unsaved" to the Menu tab and goes on
          holding its beforeunload guard.
          app/app.css carries the `.add-item-form[hidden]` line that
          makes `hidden` bite on a flex container. */}
      <AddItemForm
        locationId={locationId}
        categoryId={category.id}
        nextSort={nextSort}
        allItems={allItems}
        createItemAction={createItemAction}
        hidden={!adding}
        onCancel={() => setAdding(false)}
      />
      {adding ? null : (
        <div className="menu-edit-cat-controls">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pending}
            onClick={() => setAdding(true)}
          >
            Add item
          </button>
        </div>
      )}

      {confirming ? (
        <div
          className="dialog-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`ma-cat-confirm-${category.id}`}
        >
          <div className="dialog blueprint">
            <Corners />
            <div id={`ma-cat-confirm-${category.id}`} className="dialog-title">
              Remove {category.name}?
            </div>
            <div className="dialog-body">
              <p>
                {count === 0
                  ? "This category has no items in it."
                  : `The ${count} item${count === 1 ? "" : "s"} in it go with it. ` +
                    "Removing a category deletes its items -- there is no undo, and the " +
                    "assistant stops offering them on the next call."}
              </p>
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirming(false)}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={pending}
                onClick={() =>
                  run(() => deleteCategoryAction(locationId, category.id), () =>
                    setConfirming(false),
                  )
                }
              >
                {count === 0
                  ? "Remove category"
                  : `Remove it and ${count} item${count === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── one item ──────────────────────────────────────────────────────── */

function ItemRow({
  locationId,
  item,
  categories,
  allItems,
  saveItemAction,
  deleteItemAction,
  setSoldOutAction,
  setPickAction,
}: {
  locationId: string;
  item: EditableItem;
  categories: EditableCategory[];
  allItems: EditableItem[];
  saveItemAction: MenuAdminProps["saveItemAction"];
  deleteItemAction: MenuAdminProps["deleteItemAction"];
  setSoldOutAction: MenuAdminProps["setSoldOutAction"];
  setPickAction: MenuAdminProps["setPickAction"];
}) {
  const { pending, result, setResult, run } = useWrite();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState((item.price_cents / 100).toFixed(2));
  const [description, setDescription] = useState(item.description ?? "");
  const [allergenNote, setAllergenNote] = useState(item.allergen_note ?? "");
  const [categoryId, setCategoryId] = useState(item.category_id);
  const [sortOrder, setSortOrder] = useState(String(item.sort_order));
  /* NO pickLabel state, for the same reason there is no sold-out state:
     both are one-click controls on the collapsed row that write on the
     change and are re-rendered from the server's answer. A useState here
     would be a second, slower opinion about a column this form no longer
     saves. */
  const [confirmPriceCents, setConfirmPriceCents] = useState<number | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  /* By VALUE, not by identity, and this row was the worst of the four
     places that got it wrong: `editing` is not reset, so an open edit row
     kept its Save button and simply swapped the operator's typing for
     what was on file. Every action on this route revalidates the page, so
     any save anywhere on it -- a holiday, another dish flipped to sold
     out -- handed this row a freshly deserialised object with identical
     contents and a new identity. */
  const seedItem = [
    item.name,
    item.price_cents,
    item.description ?? "",
    item.allergen_note ?? "",
    item.category_id,
    item.sort_order,
  ].join("|");
  const [seen, setSeen] = useState(seedItem);
  const [replaced, setReplaced] = useState(false);
  const typedItem = [
    name,
    // The row types dollars and the seed holds cents, so the comparison
    // is made in cents. A price that is not a price cannot be, and is
    // kept as typed -- half a price is still typing.
    parseDollarsToCents(price) ?? `~${price}`,
    description,
    allergenNote,
    categoryId,
    sortOrder,
  ].join("|");
  if (seen !== seedItem) {
    // ...and it no longer takes the typing in silence. Two conditions,
    // so the operator's own save is quiet: the row did not match what it
    // was seeded from, and it does not match what has just arrived.
    setReplaced(typedItem !== seen && typedItem !== seedItem);
    setSeen(seedItem);
    setName(item.name);
    setPrice((item.price_cents / 100).toFixed(2));
    setDescription(item.description ?? "");
    setAllergenNote(item.allergen_note ?? "");
    setCategoryId(item.category_id);
    setSortOrder(String(item.sort_order));
    // The message from the write that CAUSED this re-seed is deliberately
    // left standing: revalidatePath lands these props in the same commit
    // as the result, so clearing here would wipe "Saved." the instant it
    // was earned.
  }

  useEscape(confirmPriceCents !== null, () => setConfirmPriceCents(null));
  useEscape(confirmingRemove, () => setConfirmingRemove(false));

  const previewCents = parseDollarsToCents(price);
  /* Only when the name has actually MOVED -- the same rule
     lib/admin/edit.ts's saveMenuItem applies before it asks the database.
     Twins are routine: app.publish_menu_import appends items with no name
     check, and neither does the owner's own menu screen, so importing the
     same PDF twice or a menu that prints "Side Salad" under two sections
     leaves two rows that normalise the same. Flagging an UNTOUCHED name
     would disable Save on exactly the rows most in need of a fix, and put
     a red sentence under a field the operator never typed in. */
  const duplicate =
    !sameName(name, item.name) &&
    allItems.some((other) => other.id !== item.id && sameName(other.name, name));
  const out = item.sold_out_until !== null;
  /* The courtesy count. menu_items_staff_pick_cap (SQLSTATE 23514) is
     the guarantee -- this only stops an operator wasting a round trip
     and tells them the rule before they hit it. Read from allItems,
     which this card already has, so no extra query is made to draw it. */
  const picksUsed = allItems.filter((other) => other.pick_label !== null).length;
  /* Not `!item.pick_label`: the cap counts non-null labels, and a row
     that already holds a slot may always be re-worded or cleared -- the
     trigger's "already counted" branch allows exactly that, so the
     control must not be shut on the one dish it still works for. */
  const capReached = picksUsed >= 3 && item.pick_label === null;
  /* The other courtesy count, with the same standing:
     menu_items_one_chefs_special_idx (SQLSTATE 23505) is the guarantee.
     A restaurant has one chef's special, and the phrase the agent speaks
     for it is definite -- two dishes each called "the chef's special" is
     the assistant contradicting itself inside one call. Excludes this
     row, so the dish that already holds it can keep it. */
  const specialTaken = allItems.some(
    (other) => other.id !== item.id && other.pick_label === "chefs_special",
  );
  const dirty =
    name !== item.name ||
    price !== (item.price_cents / 100).toFixed(2) ||
    description !== (item.description ?? "") ||
    allergenNote !== (item.allergen_note ?? "") ||
    categoryId !== item.category_id ||
    sortOrder !== String(item.sort_order);

  // The account of a loss stands until there is something new to lose.
  if (replaced && dirty) setReplaced(false);

  // The chip, and -- new here -- the beforeunload guard. This row never
  // had one: a price changed from 14.00 to 16.00 and left open behind
  // another tab was destroyed by Ctrl-R with no prompt at all, which is
  // exactly what lib/admin/edit.ts's stale-save refusal tells the
  // operator to do.
  useSectionDirty("menu", dirty);
  useSectionReplaced("menu", replaced);

  function patch(): MenuItemInput {
    return {
      categoryId,
      name,
      description,
      priceDollars: price,
      allergenNote,
      sortOrder,
      /* BOTH deliberately EMPTY, and lib/admin/edit.ts's saveMenuItem
         deliberately ignores both: an update writes the six columns this
         form actually shows and touches neither sold_out_until nor
         pick_label.

         Sending `item.sold_out_until` here -- which is what this did --
         echoed a prop that may be minutes old. The owner marks the
         branzino sold out from their own screen at seven; the operator
         fixes its description in a tab opened at ten to, and the save
         puts the fish back on sale, live on the very next call, with the
         success sentence talking about the description. The pick is now
         the same kind of control and carries the same hazard: an echoed
         `item.pick_label` would un-pick the dish somebody made the
         chef's special while this tab was open. Each column has one
         writer, and it is the control that sits on the row. */
      soldOutUntil: "",
      pickLabel: "",
    };
  }

  function beginSave() {
    if (!dirty || !name.trim() || previewCents === null || duplicate) return;
    // The dangerous edit. Every other field commits on the Save click --
    // only a changed price stops for its own confirmation, with the old
    // and the new value on screen at once, because the agent quotes it
    // to a caller within seconds and a wrong one is money out of the
    // owner's pocket. Same rule, same dialog, as components/MenuEditor.tsx.
    if (previewCents !== item.price_cents) {
      setConfirmPriceCents(previewCents);
      return;
    }
    commit();
  }

  function commit() {
    run(() => saveItemAction(locationId, item.id, patch()), () => {
      setEditing(false);
      setConfirmPriceCents(null);
    });
  }

  if (!editing) {
    return (
      <>
        {/* THREE MARKS, AND NOT ONE OF THEM IS A COLOUR. An operator has
            to be able to tell at a glance which dishes the agent is
            refusing, so the state is carried by the word on the chip, by
            the name being struck through and dimmed (.is-out -- the same
            treatment the manager screen gives an item that is off, so the
            two screens say "off" the same way), and by the select itself,
            whose chosen option is the sentence. Take any one away and the
            other two still say it. */}
        <div className={out ? "menu-item-row is-out" : "menu-item-row"}>
          <div className="name">
            {item.name}
            {/* The select further along the row is the control; this is so
                a scan down the card shows what the agent is refusing
                without reading every dropdown. */}
            {out ? <span className="tag tag-out edit-flag">Not offered</span> : null}
            {/* WHICH pick, and whether it reaches anyone. A sold-out pick
                still holds one of the three slots -- the trigger and
                picksUsed below agree on that -- but lib/agent/menu.ts
                drops `pick` from the payload while the dish is out, so it
                produces no warmth. Three spent slots can add up to zero
                warmth with nothing on the card to say why, and now that
                there are two kinds of pick the chip has to name the kind
                as well: they are different sentences out of the agent's
                mouth. Same reasoning the "Not offered" chip above and the
                sort column below are already kept for. */}
            {item.pick_label ? (
              <span className={out ? "tag tag-neutral edit-flag" : "tag tag-outline edit-flag"}>
                {out
                  ? `Silent ${PICK_LABEL[item.pick_label].toLowerCase()}`
                  : PICK_LABEL[item.pick_label]}
              </span>
            ) : null}
            {item.description ? (
              <div className="text-muted menu-edit-desc">{item.description}</div>
            ) : null}
            {item.allergen_note ? (
              <div className="text-muted menu-edit-desc">Staff note: {item.allergen_note}</div>
            ) : null}
          </div>
          <span className="price num">{money(item.price_cents)}</span>
          {/* The table's third column, kept. The tie warning under this
              list names a number, and an operator who cannot see it on
              the rows has to open every dish to find which two collide. */}
          <span className="text-muted num">sort {item.sort_order}</span>
          {/* One control, one write. The kitchen runs out of branzino at
              seven and the agent has to stop selling it on the next call
              -- opening an edit row and re-saving six other fields is the
              wrong shape for that. */}
          <select
            className="input"
            aria-label={`${item.name} on the phone`}
            value={item.sold_out_until ?? ""}
            disabled={pending}
            onChange={(e) => run(() => setSoldOutAction(locationId, item.id, e.target.value))}
          >
            <option value="">Available</option>
            <option value="reopen">{UNTIL_LABEL.reopen}</option>
            <option value="close">{UNTIL_LABEL.close}</option>
          </select>
          {/* AND THE SAME SHAPE FOR THE OTHER THING THE AGENT SAYS ABOUT
              A DISH, for the reason the sold-out control is already on
              the row: a scan down the card has to show what the phone is
              refusing AND what it is praising, without opening anything.
              This one used to sit inside the edit form below, which meant
              the words "pick", "best seller" and "chef's special"
              appeared nowhere on this tab until an operator had already
              opened a dish -- and the chip that names a pick only renders
              on a restaurant that has one, so on the restaurant that has
              none the whole feature was invisible. Its own action, its
              own write, on the change: no Save, and nothing else on the
              row re-sent with it.

              BOTH SELECTS SIT OUTSIDE .menu-edit-row-actions, which is
              nowrap so that Remove -- which destroys a dish with no undo
              -- can never come apart from the Edit an operator is aiming
              at. Four controls do not fit one line of a 300px card, so
              inside that block they would have overflowed the card's edge
              instead of wrapping; out here the row's own flex-wrap puts
              the pair of selects on one line and the pair of buttons on
              the next. */}
          <select
            className="input"
            aria-label={`${item.name} as a pick`}
            value={item.pick_label ?? ""}
            /* Shut, not merely refused afterwards, when this dish is not
               one of the three and there is no fourth slot: every option
               it could offer is one the trigger will certainly refuse.
               The dishes that HOLD the three keep their control -- the
               trigger's "already counted" branch lets a pick be re-worded
               or cleared, and clearing one is the only way back under the
               cap. The sentence saying why is on the Menu card, once,
               because it is a fact about the restaurant rather than about
               this row. */
            disabled={pending || capReached}
            onChange={(e) => run(() => setPickAction(locationId, item.id, e.target.value))}
          >
            <option value="">Not a pick</option>
            <option value="best_seller">{PICK_LABEL.best_seller}</option>
            {/* Only this one. A restaurant may call any number of dishes
                a best seller -- lib/agent/menu.ts says "one of our best
                sellers", partitive -- and exactly one the chef's special,
                because that phrase is definite and the agent may name two
                picks in a single call. */}
            <option value="chefs_special" disabled={specialTaken}>
              {PICK_LABEL.chefs_special}
            </option>
          </select>
          <div className="menu-edit-row-actions">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={pending}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={pending}
              onClick={() => setConfirmingRemove(true)}
            >
              Remove
            </button>
          </div>

          {/* Asked, not fired. .menu-edit-row-actions is a 4px flex gap,
              so Remove is the neighbour of the Edit button an operator is
              aiming at while a restaurant owner talks -- and one stray
              click destroyed the row's name, description, price, allergen
              note and sold-out state with no undo and no trash, and
              stopped the agent offering the dish on the next call.
              Deleting a category asks; changing a price asks; this is the
              same dialog, for a loss of the same kind. */}
          {confirmingRemove ? (
            <div
              className="dialog-backdrop"
              role="dialog"
              aria-modal="true"
              aria-labelledby={`ma-item-confirm-${item.id}`}
            >
              <div className="dialog blueprint">
                <Corners />
                <div id={`ma-item-confirm-${item.id}`} className="dialog-title">
                  Remove {item.name}?
                </div>
                <div className="dialog-body">
                  <p>
                    The assistant stops offering it on the next call. Its price, description and
                    staff note go with it — there is no undo and nothing to restore it from. To
                    stop selling it for tonight only, set it to {UNTIL_LABEL.close} instead.
                  </p>
                </div>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setConfirmingRemove(false)}
                    autoFocus
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={pending}
                    onClick={() =>
                      run(() => deleteItemAction(locationId, item.id), () =>
                        setConfirmingRemove(false),
                      )
                    }
                  >
                    Remove {item.name}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        {/* Outside the row rather than in it: .menu-item-list is a column,
            so the account of the write lands on its own line under the row
            it belongs to instead of fighting the name and the price for
            width. This is where the table's extra <tr colSpan={5}> went. */}
        <ReplacedNote when={replaced} />
        {pending || result ? <WriteResult pending={pending} result={result} /> : null}
      </>
    );
  }

  return (
    <>
      {/* The account of a re-seed that landed on this open edit form --
          the one place on the page where it was worst, because `editing`
          is deliberately not reset and the row simply swapped what was
          typed for what is on file. */}
      <ReplacedNote when={replaced} />
      <div className="menu-edit-row-edit">
        <div className="field">
          <label htmlFor={`ma-item-name-${item.id}`}>Item</label>
          <input
            id={`ma-item-name-${item.id}`}
            className="input"
            type="text"
            maxLength={120}
            value={name}
            disabled={pending}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={duplicate ? "true" : undefined}
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor={`ma-item-price-${item.id}`}>Price ($)</label>
          <input
            id={`ma-item-price-${item.id}`}
            className="input"
            type="text"
            inputMode="decimal"
            value={price}
            disabled={pending}
            onChange={(e) => setPrice(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`ma-item-desc-${item.id}`}>Description</label>
          <input
            id={`ma-item-desc-${item.id}`}
            className="input"
            type="text"
            maxLength={500}
            value={description}
            disabled={pending}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`ma-item-allergen-${item.id}`}>Staff note (allergens)</label>
          <input
            id={`ma-item-allergen-${item.id}`}
            className="input"
            type="text"
            maxLength={300}
            value={allergenNote}
            disabled={pending}
            onChange={(e) => setAllergenNote(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`ma-item-cat-${item.id}`}>Category</label>
          <select
            id={`ma-item-cat-${item.id}`}
            className="input"
            value={categoryId}
            disabled={pending}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`ma-item-sort-${item.id}`}>Sort order</label>
          <input
            id={`ma-item-sort-${item.id}`}
            className="input"
            type="number"
            min={0}
            max={9999}
            value={sortOrder}
            disabled={pending}
            onChange={(e) => setSortOrder(e.target.value)}
          />
        </div>
        {/* NO PICK FIELD HERE, and its absence is the point. The control
            is on the collapsed row above, where it saves on the change;
            a second control for the same column that saved only on Save
            would be two controls disagreeing about when the column is
            written -- and the one behind the Edit button would be the one
            re-sending a value the page may have rendered minutes ago.
            Sold-out made the same journey off this form for the same
            reason. */}
        <span className="price-preview text-muted">
          {previewCents === null ? "Not a valid price." : `Stores ${money(previewCents)}.`}
        </span>
        <button
          type="button"
          className="btn btn-primary"
          disabled={pending || !dirty || !name.trim() || previewCents === null || duplicate}
          onClick={beginSave}
        >
          Save
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={pending}
          onClick={() => {
            setName(item.name);
            setPrice((item.price_cents / 100).toFixed(2));
            setDescription(item.description ?? "");
            setAllergenNote(item.allergen_note ?? "");
            setCategoryId(item.category_id);
            setSortOrder(String(item.sort_order));
            setEditing(false);
            setConfirmPriceCents(null);
            setResult(null);
          }}
        >
          Cancel
        </button>
      </div>

      <p className="text-muted setup-note">
        The description is read aloud to callers as what the dish comes with. The staff note is
        not: lib/agent/menu.ts leaves it out of the assistant&rsquo;s payload on purpose,
        because an allergy question is transferred to a person rather than answered from a
        column. Whether the dish is a pick, and whether the phone is offering it at all, are
        set on the row itself and save the moment they are changed.
      </p>

      {duplicate ? (
        <p className="setup-error">
          This restaurant already has an item by that name. Two items with the same name make
          the assistant ask which one the caller meant and then read back two identical names,
          which is a question nobody can answer.
        </p>
      ) : null}

      <WriteResult pending={pending} result={result} dirty={dirty} />

      {confirmPriceCents !== null ? (
        <div
          className="dialog-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`ma-price-confirm-${item.id}`}
        >
          <div className="dialog blueprint">
            <Corners />
            <div id={`ma-price-confirm-${item.id}`} className="dialog-title">
              Change the price of {item.name}?
            </div>
            <div className="dialog-body">
              <p className="price-compare num">
                <span className="was">{money(item.price_cents)}</span>
                <span className="arrow">→</span>
                <span className="now">{money(confirmPriceCents)}</span>
              </p>
              <p>
                The phone agent quotes this on the next call, within seconds of you confirming.
              </p>
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setConfirmPriceCents(null)}
                autoFocus
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pending}
                onClick={commit}
              >
                Confirm new price
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ── a new item ────────────────────────────────────────────────────── */

function AddItemForm({
  locationId,
  categoryId,
  nextSort,
  allItems,
  createItemAction,
  onCancel,
  hidden,
}: {
  locationId: string;
  categoryId: string;
  /** One past the highest in this category, so a new dish lands at the
   *  bottom of its section instead of tying with something. */
  nextSort: number;
  allItems: EditableItem[];
  createItemAction: MenuAdminProps["createItemAction"];
  /** Puts the form away again. Optional so this stays the same component
   *  it was: without it the form is simply always open, which is what it
   *  was before the category card started disclosing it. It does NOT run
   *  on a successful add -- an operator typing a menu in adds several
   *  dishes in a row, and closing the form under them after each one is
   *  the wrong shape for that. */
  onCancel?: () => void;
  /** Away, but still mounted and still holding what was typed into it.
   *  The card discloses this form; unmounting it on Cancel is what would
   *  make Cancel destructive. `display: none` also takes it out of the
   *  focus order and out of find-in-page while it is away. */
  hidden?: boolean;
}) {
  const { pending, result, run } = useWrite();

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");

  const previewCents = parseDollarsToCents(price);
  const duplicate = name.trim() !== "" && allItems.some((other) => sameName(other.name, name));

  /* A half-typed dish is unsaved work like any other. This reports it to
     the Menu tab's chip -- which matters more now that the form is a
     disclosure and can be put away inside a card the operator has tabbed
     away from -- and registers the beforeunload guard the form never
     had, so a reload asks first instead of taking it. */
  useSectionDirty(
    "menu",
    name.trim() !== "" || price.trim() !== "" || description.trim() !== "",
  );

  return (
    <form
      className="add-item-form"
      hidden={hidden}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || previewCents === null || duplicate) return;
        run(
          () =>
            createItemAction(locationId, {
              categoryId,
              name,
              description,
              priceDollars: price,
              allergenNote: "",
              sortOrder: String(nextSort),
              soldOutUntil: "",
              // No control on this form -- a new dish is picked from the
              // edit form, once it exists and picksUsed can be checked
              // against it.
              pickLabel: "",
            }),
          () => {
            setName("");
            setPrice("");
            setDescription("");
          },
        );
      }}
    >
      <div className="field">
        <label htmlFor={`ma-new-item-name-${categoryId}`}>Item</label>
        <input
          id={`ma-new-item-name-${categoryId}`}
          className="input"
          type="text"
          placeholder="Cacio e Pepe"
          maxLength={120}
          value={name}
          disabled={pending}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={duplicate ? "true" : undefined}
        />
      </div>
      <div className="field">
        <label htmlFor={`ma-new-item-price-${categoryId}`}>Price ($)</label>
        <input
          id={`ma-new-item-price-${categoryId}`}
          className="input"
          type="text"
          inputMode="decimal"
          placeholder="22.00"
          value={price}
          disabled={pending}
          onChange={(e) => setPrice(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`ma-new-item-desc-${categoryId}`}>Description (optional)</label>
        <input
          id={`ma-new-item-desc-${categoryId}`}
          className="input"
          type="text"
          placeholder="Black pepper, pecorino"
          maxLength={500}
          value={description}
          disabled={pending}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <span className="price-preview text-muted">
        {price.trim() === ""
          ? ""
          : previewCents === null
            ? "Not a valid price."
            : `Will store ${previewCents}¢ (${money(previewCents)}).`}
      </span>
      <button
        type="submit"
        className="btn btn-secondary"
        disabled={pending || !name.trim() || previewCents === null || duplicate}
      >
        Add item
      </button>
      {onCancel ? (
        <button type="button" className="btn btn-ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      ) : null}
      {duplicate ? (
        <p className="setup-error">
          This restaurant already has an item by that name. Two items with the same name make the
          assistant ask which one the caller meant and then read back two identical names, which
          is a question nobody can answer.
        </p>
      ) : null}
      <WriteResult pending={pending} result={result} />
    </form>
  );
}
