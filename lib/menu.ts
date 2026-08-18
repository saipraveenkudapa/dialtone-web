import type { PickLabel, SoldOutUntil } from "@/lib/supabase/types";

export type { PickLabel, SoldOutUntil };

/** How an item is flagged when it runs out.
 *  - "reopen": gone for now, back when the kitchen restocks at close
 *  - "close":  gone for the rest of tonight's service */
export const UNTIL_LABEL: Record<SoldOutUntil, string> = {
  reopen: "Back at close",
  close: "Out until close",
};

/** What the OPERATOR calls each kind of pick, in a list of choices.
 *
 *  Deliberately not lib/agent/menu.ts's PICK_PHRASE. That one is the
 *  half-sentence the agent speaks -- it carries its own article, because
 *  the prompt builds "it is ..." in front of it, and it is said in the
 *  caller's language. This one is a label on an English-only console, so
 *  it wears neither. Two audiences, two strings, one column. */
export const PICK_LABEL: Record<PickLabel, string> = {
  best_seller: "Best seller",
  chefs_special: "Chef’s special",
};

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
