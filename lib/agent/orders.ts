export type PricedItem = {
  id: string;
  name: string;
  price_cents: number;
  sold_out_until: string | null;
};

const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

const wordsOf = (value: string) => normalise(value).split(" ").filter(Boolean);

/** Needle words shorter than this must match a menu word exactly; at this
 *  length or above they may still prefix-match a menu word.
 *
 *  Prefix matching alone still lets a short spoken word collide with an
 *  unrelated longer word that happens to start the same way -- "ham"
 *  prefixes "hamburger", "pie" prefixes "pierogi" -- so a caller asking
 *  for a ham sandwich could be handed a burger with no error. Four
 *  letters is long enough that a genuine abbreviation ("marg" for
 *  "Margherita") rarely also happens to spell the start of some other
 *  word on the menu, whereas three-letter (or shorter) words collide
 *  often enough that they should only match a menu word outright -- an
 *  item actually called "Ham & Cheese" still matches "ham" because that
 *  IS one of its words, not merely a prefix of one. */
const MIN_PREFIX_MATCH_LENGTH = 4;

/** Word-aware "contains": every word the caller said must be the start of
 *  some word in the item name (exactly, if the caller's word is short --
 *  see `MIN_PREFIX_MATCH_LENGTH`).
 *
 *  Plain substring matching (`itemName.includes(needle)`) crosses word
 *  boundaries -- "cola" is a substring of "chocolate", "apple" is a
 *  substring of "pineapple", "melon" is a substring of "watermelon" --
 *  so a caller asking for a cola could be handed a chocolate cake with
 *  no error and no ambiguity, because that spoken word happens to match
 *  exactly one item. Comparing whole words closes that off while still
 *  letting a caller say a prefix of a word ("marg" for "Margherita") or
 *  a leading word of a multi-word name ("bucatini" for "Bucatini
 *  Amatriciana"), both of which are things real callers do. */
const wordAwareMatch = (itemName: string, needleWords: string[]) => {
  const itemWords = wordsOf(itemName);
  return needleWords.every((nw) =>
    itemWords.some((iw) => (nw.length < MIN_PREFIX_MATCH_LENGTH ? iw === nw : iw.startsWith(nw))),
  );
};

/** Find the one item a caller meant.
 *
 *  Returns null when two items could match rather than picking one: a
 *  wrong item on the ticket is worse than one more question, and the
 *  agent is told to transfer when it cannot find something. */
export function matchItem(items: PricedItem[], spoken: string) {
  const needle = normalise(spoken);
  if (!needle) return null;

  const exact = items.filter((i) => normalise(i.name) === needle);
  if (exact.length === 1) return exact[0];

  const needleWords = wordsOf(needle);
  const partial = items.filter((i) => wordAwareMatch(i.name, needleWords));
  return partial.length === 1 ? partial[0] : null;
}

/** Validate a spoken quantity BEFORE calling `priceOrder`. This is the
 *  intended entry point for a route -- run every quantity through this
 *  first and answer with `agentFail(...)` (see `lib/agent/respond.ts`,
 *  `app/api/agent/reservation/route.ts` for the house pattern of
 *  validating up front rather than wrapping calls in try/catch) when it
 *  returns null. No route under `app/api/agent/` catches exceptions --
 *  an unwrapped throw reaching Next.js becomes a framework 500 instead
 *  of `{ok:false,error}`, and `Error.message` is not text you want a
 *  phone agent reading aloud to a caller.
 *
 *  A caller never speaks "negative one tacos" or "one and a half tacos",
 *  so this accepts only what a spoken count can plausibly be: a finite,
 *  whole number of at least one, given either as a number or a numeric
 *  string (tool-call payloads sometimes carry numbers as strings, the
 *  same loose typing `party_size` gets in the reservation route). Any
 *  other shape -- zero, negative, fractional, NaN, "two", missing,
 *  wrong type -- returns null instead of throwing. */
export function normaliseQuantity(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
}

/** Integer cents throughout. Tax is basis points so no float ever holds
 *  money.
 *
 *  Every line's quantity must be a positive integer. Routes should never
 *  reach this with a bad quantity -- `normaliseQuantity` above is the
 *  validating entry point they are expected to call first and turn a
 *  null into a speakable `agentFail`. This check is what is left after
 *  that: a last-resort invariant guard, not the primary defense, so that
 *  a caller of this function who skips validation can never silently
 *  corrupt the money math. Letting a negative quantity through would
 *  quietly shrink the subtotal, and letting a fractional one through
 *  would produce fractional `subtotal_cents`, breaking the
 *  integer-cents invariant this file exists to protect -- so this
 *  throws rather than clamps or drops the line, the same way
 *  `app/api/agent/reservation/route.ts` rejects a bad `party_size`
 *  instead of guessing one. */
export function priceOrder(
  lines: { item: PricedItem; quantity: number }[],
  taxRateBps: number,
) {
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new Error(
        `invalid quantity ${line.quantity} for "${line.item.name}": quantity must be a positive integer`,
      );
    }
  }

  const subtotal = lines.reduce(
    (sum, line) => sum + line.item.price_cents * line.quantity,
    0,
  );
  const tax = Math.round((subtotal * taxRateBps) / 10_000);
  return {
    subtotal_cents: subtotal,
    tax_cents: tax,
    total_cents: subtotal + tax,
  };
}
