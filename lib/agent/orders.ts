export type PricedItem = {
  id: string;
  name: string;
  price_cents: number;
  sold_out_until: string | null;
};

const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

const wordsOf = (value: string) => normalise(value).split(" ").filter(Boolean);

/** Word-aware "contains": every word the caller said must be the start of
 *  some word in the item name.
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
  return needleWords.every((nw) => itemWords.some((iw) => iw.startsWith(nw)));
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

/** Integer cents throughout. Tax is basis points so no float ever holds
 *  money.
 *
 *  Every line's quantity must be a positive integer. A caller never
 *  speaks "negative one tacos" or "one and a half tacos" -- a value like
 *  that reaching here means the order-taking step upstream is broken,
 *  and the two silent alternatives are both worse than refusing: letting
 *  a negative quantity through would quietly shrink the subtotal, and
 *  letting a fractional one through would produce fractional
 *  `subtotal_cents`, breaking the integer-cents invariant this file
 *  exists to protect. So this throws rather than clamps or drops the
 *  line, the same way `app/api/agent/reservation/route.ts` rejects a bad
 *  `party_size` instead of guessing one -- the tool-endpoint route
 *  calling this is expected to catch it and answer with a speakable
 *  `agentFail`, never a stack trace, per `lib/agent/respond.ts`. */
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
