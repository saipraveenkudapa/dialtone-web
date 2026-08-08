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
import type { MenuCategoryWithItems } from "@/lib/data";
import type { MenuItemRow, SoldOutUntil } from "@/lib/supabase/types";

type MenuStore = {
  categories: MenuCategoryWithItems[];
  soldOut: { id: string; name: string; until: SoldOutUntil }[];
  itemCount: number;
  toggleSoldOut: (id: string) => void;
  setSoldOutUntil: (id: string, until: SoldOutUntil) => void;
  lastChangeAt: Date | null;
  /** Set when a write failed and the row was rolled back. */
  error: string | null;
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

  // Another manager's toggle has to land here without a refresh, or two
  // people during a rush will fight over the same item.
  useEffect(() => {
    const supabase = supabaseBrowser();
    const channel = supabase
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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
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
    };
  }, [categories, lastChangeAt, error, write]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMenu() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMenu must be used inside MenuProvider");
  return ctx;
}
