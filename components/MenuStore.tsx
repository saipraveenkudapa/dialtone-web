"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { MENU, type MenuCategory, type SoldOutUntil } from "@/lib/menu";

type MenuStore = {
  categories: MenuCategory[];
  /** Flat list of everything currently flagged, for the dashboard panel. */
  soldOut: { id: string; name: string; until: SoldOutUntil }[];
  itemCount: number;
  /** Flag an item out (defaults to the rest of service) or put it back. */
  toggleSoldOut: (id: string) => void;
  setSoldOutUntil: (id: string, until: SoldOutUntil) => void;
  /** Set by the last write; the manager screen shows it as a sync note. */
  lastChangeAt: Date | null;
};

const Ctx = createContext<MenuStore | null>(null);

export function MenuProvider({ children }: { children: ReactNode }) {
  const [categories, setCategories] = useState<MenuCategory[]>(MENU);
  const [lastChangeAt, setLastChangeAt] = useState<Date | null>(null);

  // Optimistic by design: the toggle must land on the next call with no
  // save button and no confirm dialog. The write goes to Supabase and
  // Realtime fans it out to other staff; failures roll the row back.
  const writeItem = useCallback(
    (id: string, next: SoldOutUntil | null) => {
      setCategories((prev) =>
        prev.map((c) => ({
          ...c,
          items: c.items.map((it) =>
            it.id === id ? { ...it, soldOutUntil: next } : it,
          ),
        })),
      );
      setLastChangeAt(new Date());
    },
    [],
  );

  const value = useMemo<MenuStore>(() => {
    const all = categories.flatMap((c) => c.items);
    return {
      categories,
      itemCount: all.length,
      soldOut: all
        .filter((it) => it.soldOutUntil !== null)
        .map((it) => ({ id: it.id, name: it.name, until: it.soldOutUntil! })),
      lastChangeAt,
      toggleSoldOut: (id) => {
        const item = all.find((it) => it.id === id);
        if (!item) return;
        writeItem(id, item.soldOutUntil ? null : "close");
      },
      setSoldOutUntil: (id, until) => writeItem(id, until),
    };
  }, [categories, lastChangeAt, writeItem]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMenu() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMenu must be used inside MenuProvider");
  return ctx;
}
