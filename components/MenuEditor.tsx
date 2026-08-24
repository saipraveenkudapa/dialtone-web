"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Corners } from "./Corners";
import { useMenu, type ItemPatch } from "./MenuStore";
import { parseDollarsToCents } from "@/lib/money";
import { money } from "@/lib/format";
import { PICK_LABEL, UNTIL_LABEL, pickLabelFromControl } from "@/lib/menu";
import type { MenuCategoryWithItems } from "@/lib/data";
import type { MenuItemRow } from "@/lib/supabase/types";

/** The menu editor. Every write here goes through MenuStore's optimistic
 *  writers -- the same context ManagerScreen reads -- so a category or
 *  item added here shows up there without a reload, and the sold-out
 *  state ManagerScreen owns shows up here the same way. Nothing on this
 *  screen can flip sold-out itself; see the read-only tag in ItemRow.
 *
 *  THE PICK IS THE OTHER WAY ROUND, and deliberately. Sold-out is a
 *  mid-service reflex and belongs on ManagerScreen: one hand, 56px
 *  targets, no dialog. Which dish the restaurant wants the agent to
 *  praise is a considered decision made once a season, about what the
 *  kitchen stands behind -- so it is set HERE, on the row, beside the
 *  price and the description it belongs with, and ManagerScreen carries
 *  no pick control at all. The two screens each own the fact that moves
 *  at their own speed. */
export function MenuEditor() {
  const { categories, itemCount, picks, createCategory } = useMenu();
  // `picks` already carries the kind, so the holder needs no new store
  // field. At most one of these exists -- menu_items_one_chefs_special_idx
  // is what makes `find` rather than `filter` the right verb here.
  const special = picks.find((p) => p.label === "chefs_special") ?? null;
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);
    const result = await createCategory(name);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setName("");
  }

  return (
    <div className="menu-edit">
      <div className="page-head">
        <div>
          <h1>Menu</h1>
          <div className="text-muted sub">
            {itemCount} item{itemCount === 1 ? "" : "s"} across {categories.length}{" "}
            categor{categories.length === 1 ? "y" : "ies"} · every call reads this fresh
          </div>
        </div>
        <div className="actions">
          <Link href="/dashboard/menu/live" className="btn btn-secondary">
            Manager screen →
          </Link>
        </div>
      </div>

      {/* Not on a menu with no dishes: a rule about rows that do not
          exist is furniture on the emptiest version of this screen, and
          furniture is not read. Same reasoning, and all four of the same
          pieces, as the operator's Menu card -- the standing rule, the
          named cap when it binds, and the named chef's special when
          there is one -- rewritten for the person whose restaurant it
          is. */}
      {itemCount > 0 ? (
        <p className="text-muted">
          {/* "once", not "once on a call": the rule is once per PICKED
              DISH, at most twice in the whole call. Bound to the call
              instead, the same sentence said both once and twice, and an
              owner who caught that stopped believing the two rules after
              it -- the two they have to act on. This is the operator's
              already-reviewed wording. */}
          Three of your dishes at a time can be picks. The agent may say once that a picked dish
          is one of your best sellers, or that it is the chef&rsquo;s special -- in the
          caller&rsquo;s own language, and at most twice in a whole call. Choose one on any
          row. Any number of your dishes can be a best seller; only one can be the chef&rsquo;s
          special. Like a price, a pick is read live on the very next call, with nothing to
          re-push.
          {picks.length >= 3 ? (
            <>
              {" "}
              All three are taken -- {picks.map((p) => p.name).join(", ")}. Set one of those
              back to &ldquo;not a pick&rdquo; on its row to choose another.
            </>
          ) : null}
          {/* NAMED, for the same reason the three above are, and it is
              the harder of the two to find by eye: one dish among forty
              rather than three. Without it the greyed "Chef's special"
              option on every other row has nothing on screen explaining
              itself -- and because that option is shut, the owner can
              never raise the refusal that WOULD name the holder either,
              so this clause is the only way this screen ever says which
              dish has it. It stands on its own condition and not on the
              cap's: with one special and two picks used, `picks.length
              >= 3` is false and every other row is still greyed. */}
          {special ? (
            <>
              {" "}
              &ldquo;{special.name}&rdquo; is already your chef&rsquo;s special, so that choice
              is offered on that dish alone.
            </>
          ) : null}
        </p>
      ) : null}

      <form className="setup-row menu-edit-add" onSubmit={handleAdd}>
        <div className="field">
          <label htmlFor="new-category">New category</label>
          <input
            id="new-category"
            className="input"
            type="text"
            placeholder="Contorni"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
        </div>
        <button type="submit" className="btn btn-secondary" disabled={pending || !name.trim()}>
          Add category
        </button>
      </form>
      {error ? <p className="setup-error">{error}</p> : null}

      {categories.length === 0 ? (
        <p className="text-muted empty-note">No categories yet. Add one to start on items.</p>
      ) : (
        categories.map((category, i) => (
          <CategoryCard
            key={category.id}
            category={category}
            categories={categories}
            isFirst={i === 0}
            isLast={i === categories.length - 1}
          />
        ))
      )}
    </div>
  );
}

function CategoryCard({
  category,
  categories,
  isFirst,
  isLast,
}: {
  category: MenuCategoryWithItems;
  categories: MenuCategoryWithItems[];
  isFirst: boolean;
  isLast: boolean;
}) {
  const { renameCategory, deleteCategory, moveCategory } = useMenu();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A "this category still has N items" refusal goes stale the moment an
  // item leaves through any other control (its own Remove, or a move to
  // another category) -- clear it during render, the same way
  // MenuProvider's own seenCategories keeps its state from ever painting
  // a fact that's no longer true, so the message never quotes a count
  // that's already wrong.
  const [seenItemCount, setSeenItemCount] = useState(category.items.length);
  if (seenItemCount !== category.items.length) {
    setSeenItemCount(category.items.length);
    if (error) setError(null);
  }

  async function handleRename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result = await renameCategory(category.id, name);
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditing(false);
  }

  async function handleDelete() {
    setError(null);
    const result = await deleteCategory(category.id);
    if (result.error) setError(result.error);
  }

  return (
    <div className="card menu-edit-cat">
      <div className="menu-edit-cat-head">
        {editing ? (
          <form className="menu-edit-row-edit" onSubmit={handleRename}>
            <div className="field">
              <label htmlFor={`cat-name-${category.id}`}>Category name</label>
              <input
                id={`cat-name-${category.id}`}
                className="input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                autoFocus
              />
            </div>
            <button type="submit" className="btn btn-secondary" disabled={pending || !name.trim()}>
              Save
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setName(category.name);
                setEditing(false);
                setError(null);
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
                className="btn btn-ghost btn-icon"
                aria-label={`Move ${category.name} up`}
                disabled={isFirst}
                onClick={() => void moveCategory(category.id, "up")}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={`Move ${category.name} down`}
                disabled={isLast}
                onClick={() => void moveCategory(category.id, "down")}
              >
                ↓
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
                Rename
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void handleDelete()}>
                Remove category
              </button>
            </div>
          </>
        )}
      </div>

      {error ? <p className="setup-error">{error}</p> : null}

      {category.items.length === 0 ? (
        <p className="text-muted empty-note">No items yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Price</th>
                <th>Status</th>
                {/* Its own column, next to the other thing the agent says
                    about a dish. Status is what the phone is REFUSING and
                    is read-only here; this is what it is praising, and is
                    the one fact on the row this screen owns outright. */}
                <th>Pick</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {category.items.map((item, i) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  categories={categories}
                  isFirst={i === 0}
                  isLast={i === category.items.length - 1}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddItemForm categoryId={category.id} />
    </div>
  );
}

function ItemRow({
  item,
  categories,
  isFirst,
  isLast,
}: {
  item: MenuItemRow;
  categories: MenuCategoryWithItems[];
  isFirst: boolean;
  isLast: boolean;
}) {
  const { updateItem, deleteItem, moveItem, picks, setPick } = useMenu();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState(String(item.price_cents / 100));
  const [description, setDescription] = useState(item.description ?? "");
  const [categoryId, setCategoryId] = useState(item.category_id);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPriceCents, setConfirmPriceCents] = useState<number | null>(null);

  const previewCents = parseDollarsToCents(price);
  const out = item.sold_out_until !== null;

  /* The two courtesies, and neither is the enforcement. The cap is
     menu_items_staff_pick_cap (23514) and the one-chef's-special rule is
     menu_items_one_chefs_special_idx (23505); both sit below RLS and
     refuse this screen's own UPDATE exactly as they refuse the
     operator's. All these do is avoid spending a round trip to be told,
     and say the rule before it is hit.

     Not `!item.pick_label`: a row that already holds a slot may always
     be re-worded or cleared -- the trigger's "already counted" branch
     allows exactly that -- so the control must not be shut on the one
     dish it still works for. */
  const capReached = picks.length >= 3 && item.pick_label === null;
  /* Excludes this row, so the dish that already is the chef's special
     keeps it. A restaurant may call any number of dishes a best seller
     -- the agent says "one of our best sellers", partitive -- and
     exactly one the chef's special, because that phrase is definite and
     the agent may name two picks in a single call. */
  const specialTaken = picks.some(
    (p) => p.id !== item.id && p.label === "chefs_special",
  );

  async function choosePick(value: string) {
    setPending(true);
    setError(null);
    const result = await setPick(item.id, pickLabelFromControl(value));
    setPending(false);
    if (result.error) setError(result.error);
  }

  function beginSave() {
    if (!name.trim() || previewCents === null) return;
    // The dangerous edit: a price change is never applied silently, even
    // from this already-explicit "Save" click. Every other field commits
    // immediately -- only a changed price stops for its own confirmation,
    // with the old and new value both on screen at once.
    if (previewCents !== item.price_cents) {
      setConfirmPriceCents(previewCents);
      return;
    }
    void commit(previewCents);
  }

  async function commit(priceCents: number) {
    setPending(true);
    setError(null);
    const patch: ItemPatch = {
      name,
      priceCents,
      description: description.trim() ? description.trim() : null,
      categoryId,
    };
    const result = await updateItem(item.id, patch);
    setPending(false);
    setConfirmPriceCents(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    setEditing(false);
  }

  function cancelEdit() {
    setName(item.name);
    setPrice(String(item.price_cents / 100));
    setDescription(item.description ?? "");
    setCategoryId(item.category_id);
    setEditing(false);
    setError(null);
    setConfirmPriceCents(null);
  }

  async function handleDelete() {
    setError(null);
    const result = await deleteItem(item.id);
    if (result.error) setError(result.error);
  }

  if (!editing) {
    return (
      <>
        <tr>
          <td>
            <div className={out ? "name out" : "name"}>{item.name}</div>
            {item.description ? <div className="text-muted menu-edit-desc">{item.description}</div> : null}
          </td>
          <td className="num">{money(item.price_cents)}</td>
          <td>
            {out ? (
              <span className="tag tag-out">{UNTIL_LABEL[item.sold_out_until!]}</span>
            ) : (
              <span className="tag tag-neutral">Available</span>
            )}
          </td>
          <td>
            {/* ONE CONTROL, ONE WRITE, on the row and not behind Edit. The
                same shape as the operator's, for the same two reasons: a
                scan down the menu has to show what the agent is praising
                without opening fourteen dishes, and a restaurant that has
                never picked anything must still be able to SEE that it
                may. Saving it with the description would be the wrong
                moment as well as the wrong write -- see setPickAndWrite in
                MenuStore.

                The CAP GREYS THE OPTIONS, NEVER THE BOX. A disabled select
                is not focusable, so shutting it would leave a restaurant
                at its three holding a faded control no keyboard and no
                screen reader could reach, on every dish that is not one of
                the three -- and no click on it could even raise a refusal
                to read. Open, it is tabbed to, announced with the dish's
                name, and reads out the kind on file. The chef's-special
                courtesy already worked this way, so the row runs one
                mechanism and not two. `pending` is the exception and is
                this row's own write in flight, not a rule. */}
            <select
              className="input"
              aria-label={`${item.name} as a pick`}
              value={item.pick_label ?? ""}
              disabled={pending}
              onChange={(e) => void choosePick(e.target.value)}
            >
              <option value="">Not a pick</option>
              <option value="best_seller" disabled={capReached}>
                {PICK_LABEL.best_seller}
              </option>
              <option value="chefs_special" disabled={capReached || specialTaken}>
                {PICK_LABEL.chefs_special}
              </option>
            </select>
            {/* A pick on a dish that is sold out spends one of the three
                slots and reaches nobody: lib/agent/menu.ts drops it from
                the payload while the dish is out. Three spent slots can
                add up to no warmth at all on the phone, and this is the
                only place that can say why.

                SHORT, and measured. A cell's widest line sets its column's
                width under auto table layout, so one sold-out pick on one
                dish was widening this column to 422px of a 1280px table --
                wider than the dish names -- for a sentence that only
                appears on that one row. "Silent" is the word the
                operator's chip for the same state already uses. */}
            {item.pick_label && out ? (
              <div className="text-muted menu-edit-desc">Silent while sold out.</div>
            ) : null}
          </td>
          <td>
            <div className="menu-edit-row-actions">
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={`Move ${item.name} up`}
                disabled={isFirst}
                onClick={() => void moveItem(item.id, "up")}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={`Move ${item.name} down`}
                disabled={isLast}
                onClick={() => void moveItem(item.id, "down")}
              >
                ↓
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void handleDelete()}>
                Remove
              </button>
            </div>
          </td>
        </tr>
        {/* Under the dish it is about, across the whole row, because these
            are sentences: "you already have three picks", and the one a
            failed Remove has always set and no closed row has ever shown.
            A refusal squeezed into the Pick column would wrap to six
            lines and sit beside the wrong thing. */}
        {error ? (
          <tr>
            <td colSpan={5}>
              <p className="setup-error">{error}</p>
            </td>
          </tr>
        ) : null}
      </>
    );
  }

  return (
    <tr>
      <td colSpan={5}>
        <div className="menu-edit-row-edit">
          <div className="field">
            <label htmlFor={`item-name-${item.id}`}>Item</label>
            <input
              id={`item-name-${item.id}`}
              className="input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor={`item-price-${item.id}`}>Price ($)</label>
            <input
              id={`item-price-${item.id}`}
              className="input"
              type="text"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={`item-desc-${item.id}`}>Description</label>
            <input
              id={`item-desc-${item.id}`}
              className="input"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={280}
            />
          </div>
          <div className="field">
            <label htmlFor={`item-cat-${item.id}`}>Category</label>
            <select
              id={`item-cat-${item.id}`}
              className="input"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <span className="price-preview text-muted">
            {previewCents === null ? "Not a valid price." : `Stores ${money(previewCents)}.`}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={pending || !name.trim() || previewCents === null}
            onClick={beginSave}
          >
            Save
          </button>
          <button type="button" className="btn btn-ghost" onClick={cancelEdit}>
            Cancel
          </button>
        </div>
        {error ? <p className="setup-error">{error}</p> : null}

        {confirmPriceCents !== null ? (
          <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby={`price-confirm-${item.id}`}>
            <div className="dialog blueprint">
              <Corners />
              <div id={`price-confirm-${item.id}`} className="dialog-title">
                Change the price of {item.name}?
              </div>
              <div className="dialog-body">
                <p className="price-compare num">
                  <span className="was">{money(item.price_cents)}</span>
                  <span className="arrow">→</span>
                  <span className="now">{money(confirmPriceCents)}</span>
                </p>
                <p>
                  The phone agent quotes this on the next call, within seconds of you
                  confirming.
                </p>
              </div>
              <div className="dialog-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setConfirmPriceCents(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={pending}
                  onClick={() => void commit(confirmPriceCents)}
                >
                  Confirm new price
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function AddItemForm({ categoryId }: { categoryId: string }) {
  const { createItem } = useMenu();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewCents = parseDollarsToCents(price);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim() || previewCents === null) return;
    setPending(true);
    setError(null);
    const result = await createItem({
      categoryId,
      name: name.trim(),
      priceCents: previewCents,
      description: description.trim() ? description.trim() : null,
    });
    setPending(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setName("");
    setPrice("");
    setDescription("");
  }

  return (
    <form className="add-item-form" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor={`new-item-name-${categoryId}`}>Item</label>
        <input
          id={`new-item-name-${categoryId}`}
          className="input"
          type="text"
          placeholder="Cacio e Pepe"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
      </div>
      <div className="field">
        <label htmlFor={`new-item-price-${categoryId}`}>Price ($)</label>
        <input
          id={`new-item-price-${categoryId}`}
          className="input"
          type="text"
          inputMode="decimal"
          placeholder="22.00"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`new-item-desc-${categoryId}`}>Description (optional)</label>
        <input
          id={`new-item-desc-${categoryId}`}
          className="input"
          type="text"
          placeholder="Black pepper, pecorino"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={280}
        />
      </div>
      <span className="price-preview text-muted">
        {price.trim() === ""
          ? ""
          : previewCents === null
            ? "Not a valid price."
            : `Will store ${previewCents}¢ (${money(previewCents)}).`}
      </span>
      <button type="submit" className="btn btn-secondary" disabled={pending || !name.trim() || previewCents === null}>
        Add item
      </button>
      {error ? <p className="setup-error">{error}</p> : null}
    </form>
  );
}
