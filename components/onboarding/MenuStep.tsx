"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Corners } from "@/components/Corners";
import {
  addMenuCategory,
  addMenuItem,
  deleteMenuCategory,
  deleteMenuItem,
} from "@/app/onboarding/actions";
import { parseDollarsToCents } from "@/lib/money";
import { money } from "@/lib/format";
import type { MenuCategoryWithItems } from "@/lib/data";
import type { MenuItemRow } from "@/lib/supabase/types";

/** Unlike the first three steps, menu items are saved one at a time as
 *  they're added -- there is no single "menu" form to submit -- so this
 *  keeps its own local list (seeded once from the server) and calls
 *  addMenuCategory/addMenuItem/deleteMenuCategory/deleteMenuItem
 *  directly, the same way components/MenuStore.tsx manages the sold-out
 *  list, rather than through useActionState. */
export function MenuStep({
  locationId,
  initialCategories,
  onContinue,
}: {
  locationId: string | null;
  initialCategories: MenuCategoryWithItems[];
  onContinue: () => void;
}) {
  const [categories, setCategories] = useState(initialCategories);
  const [categoryName, setCategoryName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleAddCategory(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = categoryName.trim();
    if (!trimmed) return;

    const formData = new FormData();
    formData.set("name", trimmed);
    setError(null);
    startTransition(async () => {
      const result = await addMenuCategory(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.category) {
        setCategories((prev) => [...prev, { ...result.category!, items: [] }]);
        setCategoryName("");
      }
    });
  }

  function handleDeleteCategory(id: string) {
    setCategories((prev) => prev.filter((c) => c.id !== id));
    const formData = new FormData();
    formData.set("id", id);
    startTransition(() => {
      void deleteMenuCategory(formData);
    });
  }

  function handleAddItem(categoryId: string, item: MenuItemRow) {
    setCategories((prev) =>
      prev.map((c) => (c.id === categoryId ? { ...c, items: [...c.items, item] } : c)),
    );
  }

  function handleDeleteItem(categoryId: string, itemId: string) {
    setCategories((prev) =>
      prev.map((c) =>
        c.id === categoryId ? { ...c, items: c.items.filter((it) => it.id !== itemId) } : c,
      ),
    );
    const formData = new FormData();
    formData.set("id", itemId);
    startTransition(() => {
      void deleteMenuItem(formData);
    });
  }

  const itemCount = categories.reduce((sum, c) => sum + c.items.length, 0);

  return (
    <div className="card blueprint onboard-card">
      <Corners />
      <h2>Menu</h2>
      <p className="text-muted sub">
        Prices are typed in dollars and stored as whole cents. Exactly what will be stored is
        shown before you add each item -- a wrong price is money out of your pocket, and the
        assistant quotes it to a caller within seconds.
      </p>

      {!locationId ? (
        <p className="onboard-error">Finish the business step first.</p>
      ) : (
        <>
          <form className="onboard-row" onSubmit={handleAddCategory}>
            <div className="field">
              <label htmlFor="ob-category">New category</label>
              <input
                id="ob-category"
                className="input"
                type="text"
                placeholder="Pasta"
                value={categoryName}
                onChange={(e) => setCategoryName(e.target.value)}
                maxLength={80}
              />
            </div>
            <button
              type="submit"
              className="btn btn-secondary"
              disabled={pending || !categoryName.trim()}
            >
              Add category
            </button>
          </form>

          {error ? <p className="onboard-error">{error}</p> : null}

          {categories.length === 0 ? (
            <p className="text-muted empty-note">No categories yet. Add one to start on items.</p>
          ) : (
            categories.map((category) => (
              <CategoryCard
                key={category.id}
                category={category}
                onAddItem={(item) => handleAddItem(category.id, item)}
                onDeleteItem={(itemId) => handleDeleteItem(category.id, itemId)}
                onDeleteCategory={() => handleDeleteCategory(category.id)}
              />
            ))
          )}

          <div className="onboard-actions">
            <span className="text-muted onboard-note">
              {itemCount} item{itemCount === 1 ? "" : "s"} across {categories.length}{" "}
              categor{categories.length === 1 ? "y" : "ies"}
            </span>
            <button type="button" className="btn btn-primary" onClick={onContinue}>
              Continue
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CategoryCard({
  category,
  onAddItem,
  onDeleteItem,
  onDeleteCategory,
}: {
  category: MenuCategoryWithItems;
  onAddItem: (item: MenuItemRow) => void;
  onDeleteItem: (itemId: string) => void;
  onDeleteCategory: () => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const previewCents = parseDollarsToCents(price);

  function handleAddItem(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim() || previewCents === null) return;

    const formData = new FormData();
    formData.set("categoryId", category.id);
    formData.set("name", name.trim());
    formData.set("priceDollars", price.trim());
    setError(null);
    startTransition(async () => {
      const result = await addMenuItem(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.item) {
        onAddItem(result.item);
        setName("");
        setPrice("");
      }
    });
  }

  return (
    <div className="card menu-category">
      <div className="menu-category-head">
        <h4>{category.name}</h4>
        <button type="button" className="btn btn-ghost" onClick={onDeleteCategory}>
          Remove category
        </button>
      </div>

      {category.items.length === 0 ? (
        <p className="text-muted empty-note">No items yet.</p>
      ) : (
        category.items.map((item) => (
          <div key={item.id} className="menu-item-row">
            <span className="name">{item.name}</span>
            <span className="price">{money(item.price_cents)}</span>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={`Remove ${item.name}`}
              onClick={() => onDeleteItem(item.id)}
            >
              ×
            </button>
          </div>
        ))
      )}

      <form className="add-item-form" onSubmit={handleAddItem}>
        <div className="field">
          <label htmlFor={`item-name-${category.id}`}>Item</label>
          <input
            id={`item-name-${category.id}`}
            className="input"
            type="text"
            placeholder="Cacio e Pepe"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
        </div>
        <div className="field">
          <label htmlFor={`item-price-${category.id}`}>Price ($)</label>
          <input
            id={`item-price-${category.id}`}
            className="input"
            type="text"
            inputMode="decimal"
            placeholder="22.00"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
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
          disabled={pending || !name.trim() || previewCents === null}
        >
          Add item
        </button>
      </form>
      {error ? <p className="onboard-error">{error}</p> : null}
    </div>
  );
}
