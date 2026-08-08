/* Demo menu, lifted from the Dialtone mockup. Replaced by
   menu_categories / menu_items in Supabase — the shapes here are the
   contract the manager screen expects. */

/** How an item is flagged when it runs out.
 *  - "reopen": gone for now, back when the kitchen restocks at close
 *  - "close":  gone for the rest of tonight's service */
export type SoldOutUntil = "reopen" | "close";

export type MenuItem = {
  id: string;
  name: string;
  priceCents: number;
  /** null = available. The agent may only quote available items. */
  soldOutUntil: SoldOutUntil | null;
};

export type MenuCategory = {
  id: string;
  name: string;
  items: MenuItem[];
};

export const UNTIL_LABEL: Record<SoldOutUntil, string> = {
  reopen: "Back at close",
  close: "Out until close",
};

export const MENU: MenuCategory[] = [
  {
    id: "c1",
    name: "Antipasti",
    items: [
      { id: "i1", name: "Fritto Misto", priceCents: 1600, soldOutUntil: null },
      { id: "i2", name: "Burrata & Peach", priceCents: 1500, soldOutUntil: null },
      { id: "i3", name: "Meatballs al Forno", priceCents: 1400, soldOutUntil: null },
      { id: "i4", name: "Chicories, Anchovy", priceCents: 1200, soldOutUntil: null },
    ],
  },
  {
    id: "c2",
    name: "Pasta",
    items: [
      { id: "i5", name: "Bucatini Amatriciana", priceCents: 2400, soldOutUntil: null },
      { id: "i6", name: "Cacio e Pepe", priceCents: 2200, soldOutUntil: null },
      { id: "i7", name: "Squid Ink Tonnarelli", priceCents: 2900, soldOutUntil: "close" },
      { id: "i8", name: "Lasagne Verdi", priceCents: 2600, soldOutUntil: null },
      { id: "i9", name: "Gnocchi, Brown Butter", priceCents: 2300, soldOutUntil: null },
    ],
  },
  {
    id: "c3",
    name: "Secondi",
    items: [
      { id: "i10", name: "Branzino, Whole", priceCents: 3800, soldOutUntil: null },
      { id: "i11", name: "Pork Milanese", priceCents: 3200, soldOutUntil: null },
      { id: "i12", name: "Bistecca, 32oz", priceCents: 8800, soldOutUntil: "reopen" },
    ],
  },
  {
    id: "c4",
    name: "Dolci",
    items: [
      { id: "i13", name: "Olive Oil Cake", priceCents: 1100, soldOutUntil: null },
      { id: "i14", name: "Affogato", priceCents: 900, soldOutUntil: null },
    ],
  },
];
