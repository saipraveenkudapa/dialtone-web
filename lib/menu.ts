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


/* ── what the OWNER is told when a pick is refused ──────────────────
 *
 * Both rules belong to the database, and both are reached by the
 * restaurant's own screen: components/MenuStore.tsx writes pick_label as
 * the signed-in user through RLS, so menu_items_staff_pick_cap (23514)
 * and menu_items_one_chefs_special_idx (23505) are what actually stop
 * them -- exactly as they stop the operator's service-role write.
 *
 * NOT lib/admin/edit.ts's PICK_CAP_REACHED and ONE_CHEFS_SPECIAL, and
 * the difference is the reader. Those say "This restaurant already
 * has...", which is how somebody administering many restaurants refers
 * to one of them; said back to the owner of the only restaurant they
 * have, it reads like a message about somebody else's. The rules are the
 * same rules and the way out of each is the same way out, so only the
 * person is changed -- and the two stay two, because an owner who has
 * called a second dish the chef's special has not hit the cap and must
 * not be sent looking for it.
 *
 * The words the options wear are quoted from PICK_LABEL above, so an
 * owner reading "set it back to 'not a pick'" is reading the label of
 * the thing they are being asked to choose. */
export const PICK_CAP_REFUSAL =
  "You already have three picks. Set one of them back to “not a pick” on its row to free a " +
  "slot for this dish.";

export const ONE_CHEFS_SPECIAL_REFUSAL =
  "One of your dishes is already the chef’s special, and only one can be — the agent says “the " +
  "chef’s special”, and a kitchen has one. Set that dish to “best seller” or “not a pick” first.";

/** Neither rule, and deliberately not the database's own sentence. A
 *  PostgrestError's message, details and hint name columns, constraints
 *  and sometimes row values; only `code` is ever read here. */
export const PICK_WRITE_FAILED =
  "That did not save. Check the connection and choose again.";

/** The SQLSTATE, turned into the sentence that names the rule which
 *  actually stopped the write.
 *
 *  Mapped rather than counted. The console's own courtesy -- greying an
 *  option that is certain to be refused -- is drawn from rows this
 *  browser happens to hold, which two people editing at once can both
 *  pass; these are what is said when the database disagrees. */
export function pickRefusal(code: string | null | undefined): string {
  if (code === "23514") return PICK_CAP_REFUSAL;
  if (code === "23505") return ONE_CHEFS_SPECIAL_REFUSAL;
  return PICK_WRITE_FAILED;
}

/** The option the control was left on, in the column's vocabulary.
 *
 *  The <select> carries exactly three values -- the two labels and ""
 *  for not-a-pick -- so this is a narrowing and not a validation. It
 *  matters anyway: pick_label's own check constraint raises 23514, the
 *  CAP's SQLSTATE, so a value that is not one of the two would come back
 *  from Postgres wearing a sentence about a limit the owner has not
 *  reached. Nothing that is not one of the two kinds is a pick. */
export function pickLabelFromControl(value: string): PickLabel | null {
  return value === "best_seller" || value === "chefs_special" ? value : null;
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
