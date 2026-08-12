export type PricedItem = {
  id: string;
  name: string;
  price_cents: number;
  sold_out_until: string | null;
};

const normalise = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

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

  const partial = items.filter((i) => normalise(i.name).includes(needle));
  return partial.length === 1 ? partial[0] : null;
}

/** Integer cents throughout. Tax is basis points so no float ever holds
 *  money. */
export function priceOrder(
  lines: { item: PricedItem; quantity: number }[],
  taxRateBps: number,
) {
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
