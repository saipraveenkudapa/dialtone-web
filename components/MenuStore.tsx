"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { RealtimePostgresUpdatePayload } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/client";
import { primeRealtimeAuth } from "@/lib/supabase/realtime";
import { pickRefusal } from "@/lib/menu";
import type { MenuCategoryWithItems } from "@/lib/data";
import type {
  MenuCategoryRow,
  MenuItemRow,
  PickLabel,
  SoldOutUntil,
} from "@/lib/supabase/types";

export type NewItemInput = {
  categoryId: string;
  name: string;
  priceCents: number;
  description: string | null;
};

export type ItemPatch = {
  name?: string;
  priceCents?: number;
  description?: string | null;
  categoryId?: string;
};

type WriteResult = { error?: string };

type MenuStore = {
  categories: MenuCategoryWithItems[];
  soldOut: { id: string; name: string; until: SoldOutUntil }[];
  /** The dishes the restaurant nominated, at most three, in menu order.
   *  Read the same way `soldOut` is: the editor draws its own note from
   *  this rather than re-deriving it, and a row asks it how many slots
   *  are spent and whether the chef's special is taken. */
  picks: { id: string; name: string; label: PickLabel; soldOut: boolean }[];
  itemCount: number;
  toggleSoldOut: (id: string) => void;
  setSoldOutUntil: (id: string, until: SoldOutUntil) => void;
  /** Which kind of pick a dish is; null is not a pick. Its own writer,
   *  like sold-out and for the same reason -- one control, one column,
   *  saved on the change. `updateItem` below deliberately never touches
   *  this column. */
  setPick: (id: string, label: PickLabel | null) => Promise<WriteResult>;
  lastChangeAt: Date | null;
  /** Set when a write failed and the row was rolled back. */
  error: string | null;

  // ── categories ─────────────────────────────────────────────────────
  createCategory: (name: string) => Promise<WriteResult>;
  renameCategory: (id: string, name: string) => Promise<WriteResult>;
  /** Refuses when the category still has items -- see deleteCategory's own
   *  comment on why. */
  deleteCategory: (id: string) => Promise<WriteResult>;
  moveCategory: (id: string, direction: "up" | "down") => Promise<void>;

  // ── items ──────────────────────────────────────────────────────────
  createItem: (input: NewItemInput) => Promise<WriteResult>;
  updateItem: (id: string, patch: ItemPatch) => Promise<WriteResult>;
  deleteItem: (id: string) => Promise<WriteResult>;
  moveItem: (id: string, direction: "up" | "down") => Promise<void>;
};

const Ctx = createContext<MenuStore | null>(null);

export function MenuProvider({
  locationId,
  initialCategories,
  children,
}: {
  locationId: string;
  initialCategories: MenuCategoryWithItems[];
  children: ReactNode;
}) {
  const [categories, setCategories] = useState(initialCategories);
  const [lastChangeAt, setLastChangeAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The server re-renders this route on navigation; take its data as the
  // truth whenever it changes. Adjusted during render rather than in an
  // effect, so no frame ever paints the stale list.
  const [seenCategories, setSeenCategories] = useState(initialCategories);
  if (seenCategories !== initialCategories) {
    setSeenCategories(initialCategories);
    setCategories(initialCategories);
  }

  const applyLocal = useCallback((id: string, next: SoldOutUntil | null) => {
    setCategories((prev) =>
      prev.map((c) => ({
        ...c,
        items: c.items.map((it) =>
          it.id === id ? { ...it, sold_out_until: next } : it,
        ),
      })),
    );
  }, []);

  // Optimistic by design: mid-service there is no save button and no
  // confirm dialog, so the row flips immediately and rolls back only if
  // the write is rejected.
  const write = useCallback(
    async (id: string, next: SoldOutUntil | null, previous: SoldOutUntil | null) => {
      applyLocal(id, next);
      setLastChangeAt(new Date());
      setError(null);

      const { error: writeError } = await supabaseBrowser()
        .from("menu_items")
        .update({ sold_out_until: next })
        .eq("id", id);

      if (writeError) {
        applyLocal(id, previous);
        setError("That did not save. Check the connection and tap again.");
      }
    },
    [applyLocal],
  );

  // ── category/item editing ───────────────────────────────────────────
  //
  // Same optimistic-then-rollback shape as `write` above, generalised to
  // full-row replacement so create/rename/move/delete are all one
  // primitive: put this exact row (or its absence) into local state,
  // fire the network write, and if it fails put back what was there
  // before. Two invariants every one of these preserves so plain
  // `categories.map()` callers (ManagerScreen, this file's own realtime
  // handler) never need to re-sort: the categories array is always in
  // `sort_order`, and every category's `items` array is always in its
  // own `sort_order`.

  const applyCategoryFull = useCallback((category: MenuCategoryWithItems) => {
    setCategories((prev) => {
      const exists = prev.some((c) => c.id === category.id);
      const next = exists
        ? prev.map((c) => (c.id === category.id ? category : c))
        : [...prev, category];
      return next.sort((a, b) => a.sort_order - b.sort_order);
    });
  }, []);

  const removeCategoryFull = useCallback((id: string) => {
    setCategories((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const applyItemFull = useCallback((item: MenuItemRow) => {
    setCategories((prev) => {
      const stripped = prev.map((c) => ({
        ...c,
        items: c.items.filter((it) => it.id !== item.id),
      }));
      return stripped.map((c) =>
        c.id === item.category_id
          ? { ...c, items: [...c.items, item].sort((a, b) => a.sort_order - b.sort_order) }
          : c,
      );
    });
  }, []);

  const removeItemFull = useCallback((id: string) => {
    setCategories((prev) => prev.map((c) => ({ ...c, items: c.items.filter((it) => it.id !== id) })));
  }, []);

  const createCategoryAndWrite = useCallback(
    async (optimistic: MenuCategoryWithItems, insert: { location_id: string; name: string; sort_order: number }) => {
      applyCategoryFull(optimistic);
      setLastChangeAt(new Date());
      setError(null);

      const { data, error: writeError } = await supabaseBrowser()
        .from("menu_categories")
        .insert(insert)
        .select("*")
        .single();

      if (writeError || !data) {
        removeCategoryFull(optimistic.id);
        setError("Could not add that category. Try again.");
        return { error: "Could not add that category. Try again." };
      }

      removeCategoryFull(optimistic.id);
      applyCategoryFull({ ...(data as MenuCategoryRow), items: [] });
      return {};
    },
    [applyCategoryFull, removeCategoryFull],
  );

  const renameCategoryAndWrite = useCallback(
    async (previous: MenuCategoryWithItems, name: string) => {
      applyCategoryFull({ ...previous, name });
      setLastChangeAt(new Date());
      setError(null);

      const { error: writeError } = await supabaseBrowser()
        .from("menu_categories")
        .update({ name })
        .eq("id", previous.id);

      if (writeError) {
        applyCategoryFull(previous);
        setError("Could not rename that category. Try again.");
        return { error: "Could not rename that category. Try again." };
      }
      return {};
    },
    [applyCategoryFull],
  );

  const deleteCategoryAndWrite = useCallback(
    async (category: MenuCategoryWithItems) => {
      removeCategoryFull(category.id);
      setLastChangeAt(new Date());
      setError(null);

      const { error: writeError } = await supabaseBrowser()
        .from("menu_categories")
        .delete()
        .eq("id", category.id);

      if (writeError) {
        applyCategoryFull(category);
        setError("Could not remove that category. Try again.");
        return { error: "Could not remove that category. Try again." };
      }
      return {};
    },
    [applyCategoryFull, removeCategoryFull],
  );

  const swapCategoriesAndWrite = useCallback(
    async (a: MenuCategoryWithItems, b: MenuCategoryWithItems) => {
      const nextA = { ...a, sort_order: b.sort_order };
      const nextB = { ...b, sort_order: a.sort_order };
      applyCategoryFull(nextA);
      applyCategoryFull(nextB);
      setLastChangeAt(new Date());
      setError(null);

      const supabase = supabaseBrowser();
      const [r1, r2] = await Promise.all([
        supabase.from("menu_categories").update({ sort_order: nextA.sort_order }).eq("id", a.id),
        supabase.from("menu_categories").update({ sort_order: nextB.sort_order }).eq("id", b.id),
      ]);

      if (r1.error || r2.error) {
        applyCategoryFull(a);
        applyCategoryFull(b);
        setError("Could not reorder categories. Try again.");
      }
    },
    [applyCategoryFull],
  );

  const createItemAndWrite = useCallback(
    async (
      optimistic: MenuItemRow,
      insert: {
        category_id: string;
        name: string;
        description: string | null;
        price_cents: number;
        sort_order: number;
      },
    ) => {
      applyItemFull(optimistic);
      setLastChangeAt(new Date());
      setError(null);

      const { data, error: writeError } = await supabaseBrowser()
        .from("menu_items")
        .insert(insert)
        .select("*")
        .single();

      if (writeError || !data) {
        removeItemFull(optimistic.id);
        setError("Could not add that item. Try again.");
        return { error: "Could not add that item. Try again." };
      }

      removeItemFull(optimistic.id);
      applyItemFull(data as MenuItemRow);
      return {};
    },
    [applyItemFull, removeItemFull],
  );

  const updateItemAndWrite = useCallback(
    async (previous: MenuItemRow, next: MenuItemRow) => {
      applyItemFull(next);
      setLastChangeAt(new Date());
      setError(null);

      const { error: writeError } = await supabaseBrowser()
        .from("menu_items")
        .update({
          name: next.name,
          price_cents: next.price_cents,
          description: next.description,
          category_id: next.category_id,
          sort_order: next.sort_order,
        })
        .eq("id", next.id);

      if (writeError) {
        applyItemFull(previous);
        setError("That did not save. Check the connection and try again.");
        return { error: "That did not save. Check the connection and try again." };
      }
      return {};
    },
    [applyItemFull],
  );

  /* WHICH KIND OF PICK, and nothing else in the same statement.
   *
   * One column, written on its own, exactly as `write` above sends
   * sold_out_until on its own -- and for a sharper reason than symmetry:
   * updateItemAndWrite names five columns and pick_label is
   * deliberately not among them, so an owner fixing a description cannot
   * clear a pick. That guarantee is only worth anything if the reverse
   * also holds. A pick sent as part of a row would echo whatever this
   * tab last rendered, and un-sold-out a dish the kitchen pulled at
   * seven, or un-pick the one somebody made the chef's special while
   * this tab was open.
   *
   * THE TWO RULES ARE THE DATABASE'S, AND THEY REACH THIS WRITE. This
   * goes out as the signed-in user under RLS (menu_items_rw, which
   * admits any member of the restaurant's organization), and both rules
   * sit below RLS: menu_items_staff_pick_cap is a BEFORE ROW trigger on
   * menu_items with no role condition, and menu_items_one_chefs_special_idx
   * is a unique index, which the storage engine checks for every writer
   * there is. So the owner's UPDATE is refused by the same two things
   * that refuse the operator's service-role UPDATE, and arrives here as
   * 23514 or 23505. Counting rows in this browser first would be a check
   * two people editing at once could both pass; the greyed options on
   * the row are a courtesy, and this is the enforcement.
   *
   * Optimistic, like every other write in this file: the row shows the
   * new kind at once and goes back to what it was if the write is
   * refused, with the sentence that names the rule that refused it. */
  const setPickAndWrite = useCallback(
    async (previous: MenuItemRow, next: PickLabel | null) => {
      applyItemFull({ ...previous, pick_label: next });
      setLastChangeAt(new Date());
      setError(null);

      const { error: writeError } = await supabaseBrowser()
        .from("menu_items")
        .update({ pick_label: next })
        .eq("id", previous.id);

      if (writeError) {
        applyItemFull(previous);
        // The code alone. A PostgrestError's message, details and hint
        // name columns, constraints and sometimes row values.
        const message = pickRefusal(writeError.code);
        setError(message);
        return { error: message };
      }
      return {};
    },
    [applyItemFull],
  );

  const deleteItemAndWrite = useCallback(
    async (item: MenuItemRow) => {
      removeItemFull(item.id);
      setLastChangeAt(new Date());
      setError(null);

      const { error: writeError } = await supabaseBrowser().from("menu_items").delete().eq("id", item.id);

      if (writeError) {
        applyItemFull(item);
        setError("Could not remove that item. Try again.");
        return { error: "Could not remove that item. Try again." };
      }
      return {};
    },
    [applyItemFull, removeItemFull],
  );

  const swapItemsAndWrite = useCallback(
    async (a: MenuItemRow, b: MenuItemRow) => {
      const nextA = { ...a, sort_order: b.sort_order };
      const nextB = { ...b, sort_order: a.sort_order };
      applyItemFull(nextA);
      applyItemFull(nextB);
      setLastChangeAt(new Date());
      setError(null);

      const supabase = supabaseBrowser();
      const [r1, r2] = await Promise.all([
        supabase.from("menu_items").update({ sort_order: nextA.sort_order }).eq("id", a.id),
        supabase.from("menu_items").update({ sort_order: nextB.sort_order }).eq("id", b.id),
      ]);

      if (r1.error || r2.error) {
        applyItemFull(a);
        applyItemFull(b);
        setError("Could not reorder items. Try again.");
      }
    },
    [applyItemFull],
  );

  // Another manager's toggle has to land here without a refresh, or two
  // people during a rush will fight over the same item.
  //
  // THE WHOLE ROW, NOT A COLUMN LIST. `payload.new` carries every column
  // of menu_items -- 20260807000300_realtime_publication.sql adds the
  // table with no column filter, and nothing here narrows it -- and the
  // handler spreads it, so a column added to the table arrives on this
  // screen without a second place to remember. That is how pick_label
  // gets here: both consoles now write it, so a pick the OPERATOR sets
  // while the owner has their menu open lands on it the same way a
  // sold-out toggle does. Replace this spread with named columns and
  // that stops being true silently.
  useEffect(() => {
    const supabase = supabaseBrowser();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    void (async () => {
      await primeRealtimeAuth(supabase);
      if (cancelled) return;

      channel = supabase
      .channel(`menu_items:${locationId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "menu_items",
          filter: `location_id=eq.${locationId}`,
        },
        (payload: RealtimePostgresUpdatePayload<MenuItemRow>) => {
          const row = payload.new;
          setCategories((prev) =>
            prev.map((c) => ({
              ...c,
              items: c.items.map((it) => (it.id === row.id ? { ...it, ...row } : it)),
            })),
          );
        },
      )
      .subscribe((status: string) => {
        // A silently dead channel is the worst failure here: the screen
        // would look fine while showing another manager a stale menu.
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn("[dialtone] menu realtime channel:", status);
          setError("Live sync is down. Reload to see other staff's changes.");
        }
        if (status === "SUBSCRIBED") setError(null);
      });
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [locationId]);

  const value = useMemo<MenuStore>(() => {
    const all = categories.flatMap((c) => c.items);

    return {
      categories,
      itemCount: all.length,
      soldOut: all
        .filter((it) => it.sold_out_until !== null)
        .map((it) => ({
          id: it.id,
          name: it.name,
          until: it.sold_out_until as SoldOutUntil,
        })),
      /* Filtered on `!== null` and not on truthiness: the cap counts
         non-null labels, and "" is neither a label nor a pick. Carries
         `soldOut` with each one because a sold-out pick still spends a
         slot and still reaches nobody -- lib/agent/menu.ts drops it from
         the payload while the dish is out -- and the screen has to be
         able to say both. */
      picks: all
        .filter((it) => it.pick_label !== null)
        .map((it) => ({
          id: it.id,
          name: it.name,
          label: it.pick_label as PickLabel,
          soldOut: it.sold_out_until !== null,
        })),
      lastChangeAt,
      error,
      toggleSoldOut: (id) => {
        const item = all.find((it) => it.id === id);
        if (!item) return;
        void write(id, item.sold_out_until ? null : "close", item.sold_out_until);
      },
      setSoldOutUntil: (id, until) => {
        const item = all.find((it) => it.id === id);
        if (!item) return;
        void write(id, until, item.sold_out_until);
      },

      setPick: (id, label) => {
        const item = all.find((it) => it.id === id);
        if (!item) return Promise.resolve({ error: "That item no longer exists." });
        // Nothing to say to the database. Re-selecting the kind a dish
        // already is would still be admitted -- the trigger's "already
        // counted" branch exists for exactly that -- but a write nobody
        // asked for is a write that can fail.
        if (item.pick_label === label) return Promise.resolve({});
        return setPickAndWrite(item, label);
      },

      createCategory: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return Promise.resolve({ error: "Enter a category name." });
        if (trimmed.length > 80) return Promise.resolve({ error: "That name is too long." });

        const nextOrder = categories.reduce((max, c) => Math.max(max, c.sort_order), -1) + 1;
        const optimistic: MenuCategoryWithItems = {
          id: `temp-${crypto.randomUUID()}`,
          location_id: locationId,
          name: trimmed,
          sort_order: nextOrder,
          created_at: new Date().toISOString(),
          items: [],
        };
        return createCategoryAndWrite(optimistic, {
          location_id: locationId,
          name: trimmed,
          sort_order: nextOrder,
        });
      },

      renameCategory: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return Promise.resolve({ error: "Enter a category name." });
        if (trimmed.length > 80) return Promise.resolve({ error: "That name is too long." });
        const category = categories.find((c) => c.id === id);
        if (!category) return Promise.resolve({ error: "That category no longer exists." });
        return renameCategoryAndWrite(category, trimmed);
      },

      // Deleting a category cascades at the database level (menu_items.
      // category_id is `on delete cascade`, supabase/migrations/
      // 20260807000100_schema.sql), which exists so an org can be wiped
      // cleanly -- not so a manager clicking one button mid-afternoon can
      // vanish a dozen priced items with no way back. So this layer
      // refuses the delete outright while items remain: the owner has to
      // move or delete every item out first, each of which is its own
      // reversible, visible action, rather than one click silently taking
      // the items with it.
      deleteCategory: (id) => {
        const category = categories.find((c) => c.id === id);
        if (!category) return Promise.resolve({ error: "That category no longer exists." });
        if (category.items.length > 0) {
          const n = category.items.length;
          return Promise.resolve({
            error: `"${category.name}" still has ${n} item${n === 1 ? "" : "s"}. Move or delete ${
              n === 1 ? "it" : "them"
            } first -- deleting a category deletes its items.`,
          });
        }
        return deleteCategoryAndWrite(category);
      },

      moveCategory: (id, direction) => {
        const index = categories.findIndex((c) => c.id === id);
        if (index === -1) return Promise.resolve();
        const swapIndex = direction === "up" ? index - 1 : index + 1;
        if (swapIndex < 0 || swapIndex >= categories.length) return Promise.resolve();
        return swapCategoriesAndWrite(categories[index], categories[swapIndex]);
      },

      createItem: (input) => {
        const name = input.name.trim();
        if (!name) return Promise.resolve({ error: "Enter the item's name." });
        if (name.length > 120) return Promise.resolve({ error: "That name is too long." });
        if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
          return Promise.resolve({ error: "Enter a valid price." });
        }
        const category = categories.find((c) => c.id === input.categoryId);
        if (!category) return Promise.resolve({ error: "Choose a category first." });

        const nextOrder = category.items.reduce((max, it) => Math.max(max, it.sort_order), -1) + 1;
        const optimistic: MenuItemRow = {
          id: `temp-${crypto.randomUUID()}`,
          category_id: input.categoryId,
          location_id: locationId,
          name,
          description: input.description,
          price_cents: input.priceCents,
          sold_out_until: null,
          pick_label: null,
          allergen_note: null,
          sort_order: nextOrder,
          updated_at: new Date().toISOString(),
        };
        return createItemAndWrite(optimistic, {
          category_id: input.categoryId,
          name,
          description: input.description,
          price_cents: input.priceCents,
          sort_order: nextOrder,
        });
      },

      updateItem: (id, patch) => {
        const previous = all.find((it) => it.id === id);
        if (!previous) return Promise.resolve({ error: "That item no longer exists." });

        const name = patch.name !== undefined ? patch.name.trim() : previous.name;
        if (!name) return Promise.resolve({ error: "Enter the item's name." });
        if (name.length > 120) return Promise.resolve({ error: "That name is too long." });
        if (
          patch.priceCents !== undefined &&
          (!Number.isInteger(patch.priceCents) || patch.priceCents < 0)
        ) {
          return Promise.resolve({ error: "Enter a valid price." });
        }

        let categoryId = previous.category_id;
        let sortOrder = previous.sort_order;
        if (patch.categoryId !== undefined && patch.categoryId !== previous.category_id) {
          const target = categories.find((c) => c.id === patch.categoryId);
          if (!target) return Promise.resolve({ error: "Choose a category first." });
          categoryId = patch.categoryId;
          sortOrder = target.items.reduce((max, it) => Math.max(max, it.sort_order), -1) + 1;
        }

        const next: MenuItemRow = {
          ...previous,
          name,
          price_cents: patch.priceCents ?? previous.price_cents,
          description: patch.description === undefined ? previous.description : patch.description,
          category_id: categoryId,
          sort_order: sortOrder,
        };
        return updateItemAndWrite(previous, next);
      },

      deleteItem: (id) => {
        const item = all.find((it) => it.id === id);
        if (!item) return Promise.resolve({ error: "That item no longer exists." });
        return deleteItemAndWrite(item);
      },

      moveItem: (id, direction) => {
        const item = all.find((it) => it.id === id);
        if (!item) return Promise.resolve();
        const siblings = categories.find((c) => c.id === item.category_id)?.items ?? [];
        const index = siblings.findIndex((it) => it.id === id);
        if (index === -1) return Promise.resolve();
        const swapIndex = direction === "up" ? index - 1 : index + 1;
        if (swapIndex < 0 || swapIndex >= siblings.length) return Promise.resolve();
        return swapItemsAndWrite(siblings[index], siblings[swapIndex]);
      },
    };
  }, [
    categories,
    lastChangeAt,
    error,
    write,
    locationId,
    createCategoryAndWrite,
    renameCategoryAndWrite,
    deleteCategoryAndWrite,
    swapCategoriesAndWrite,
    createItemAndWrite,
    updateItemAndWrite,
    setPickAndWrite,
    deleteItemAndWrite,
    swapItemsAndWrite,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMenu() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMenu must be used inside MenuProvider");
  return ctx;
}
