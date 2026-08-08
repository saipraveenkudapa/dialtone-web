import type { SoldOutUntil } from "@/lib/supabase/types";

export type { SoldOutUntil };

/** How an item is flagged when it runs out.
 *  - "reopen": gone for now, back when the kitchen restocks at close
 *  - "close":  gone for the rest of tonight's service */
export const UNTIL_LABEL: Record<SoldOutUntil, string> = {
  reopen: "Back at close",
  close: "Out until close",
};

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
