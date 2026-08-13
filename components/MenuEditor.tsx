"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useMenu, type ItemPatch } from "./MenuStore";
import { parseDollarsToCents } from "@/lib/money";
import { money } from "@/lib/format";
import { UNTIL_LABEL } from "@/lib/menu";
import type { MenuCategoryWithItems } from "@/lib/data";
import type { MenuItemRow } from "@/lib/supabase/types";

/** The menu editor. Every write here goes through MenuStore's optimistic
 *  writers -- the same context ManagerScreen reads -- so a category or
 *  item added here shows up there without a reload, and the sold-out
 *  state ManagerScreen owns shows up here the same way. Nothing on this
 *  screen can flip sold-out itself; see the read-only tag in ItemRow. */
export function MenuEditor() {
  const { categories, itemCount, createCategory } = useMenu();
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

      <p className="text-muted">
        Prices are typed in dollars and stored as whole cents. A price you save here is what
        the phone agent quotes on the very next call -- the new value is always shown next to
        the old one before it commits.
      </p>

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
  const { updateItem, deleteItem, moveItem } = useMenu();
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
    );
  }

  return (
    <tr>
      <td colSpan={4}>
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
            <div className="dialog">
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
