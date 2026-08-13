/* Parsing money and rates typed by a human, without ever routing the
 * value through a float multiplication -- `6.625 * 100` and
 * `19.99 * 100` both land on a value with binary floating-point error
 * (`662.49999999999989...`, `1998.9999999999998`) that a careless
 * `Math.round` can resolve the wrong way. Every parser here works on the
 * decimal string's digits directly with BigInt, so the result is exact
 * for any input that parses at all.
 *
 * Nothing here formats a stored value back for *display* -- lib/format.ts
 * and lib/menu.ts both already have a `money()` for that, and rendering
 * cents/100 with toFixed(2) has none of this file's precision concern
 * because it never re-enters storage. */

/** A plain non-negative decimal: optional whole part, optional
 *  `.` and fractional digits. No sign, no thousands separator, no
 *  scientific notation -- reject anything that isn't exactly this so a
 *  stray character never gets silently dropped. */
const DECIMAL = /^\d+(\.\d+)?$/;

/** The decimal string's exact value, scaled by `10**scale` and rounded
 *  half-away-from-zero to the nearest integer at that scale. Every digit
 *  the input carries takes part in the rounding decision -- there is no
 *  intermediate float. Returns null for anything that isn't a plain
 *  non-negative decimal. */
function parseScaledDecimal(raw: string, scale: number): number | null {
  const trimmed = raw.trim();
  if (!DECIMAL.test(trimmed)) return null;

  const [wholeStr, fracStr = ""] = trimmed.split(".");
  // The whole value, as an integer, expressed in units of 10**-fracLen
  // (e.g. "6.625" -> 6625, in units of thousandths).
  //
  // `BigInt(10) ** BigInt(n)` rather than a `10n` literal: this
  // project's tsconfig targets ES2017, and BigInt *literal syntax*
  // (TS2737) needs ES2020 -- the BigInt type itself is available
  // regardless, from the "esnext" lib entry, so calling the constructor
  // compiles fine at this target.
  const ten = BigInt(10);
  const two = BigInt(2);
  const units = BigInt(wholeStr + fracStr || "0");
  const fracLen = BigInt(fracStr.length);
  const scaleBig = BigInt(scale);

  // Rescale from 10**-fracLen to 10**-scale by multiplying up, then
  // divide back down with explicit rounding -- integer division alone
  // truncates, which would silently round every rate down.
  const numerator = units * ten ** scaleBig;
  const denominator = ten ** fracLen;
  let result = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * two >= denominator) result += BigInt(1);

  return Number(result);
}

/** Dollars, typed by a human, to integer cents. Exact -- refuses input
 *  finer than a cent (a $12.505 someone meant to type as $12.50 or
 *  $12.51 is not this parser's guess to make) rather than rounding it,
 *  because a menu price is quoted to a caller within seconds and a wrong
 *  one is money out of the owner's pocket. Returns null for anything
 *  that is not a plain non-negative amount with at most two decimal
 *  places -- empty string, a stray "$", a negative number, letters. */
export function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return parseScaledDecimal(trimmed, 2);
}

/** A sales tax rate, typed as a human percentage ("6.625"), to integer
 *  basis points (662.5 -> 663, since a database column can only ever
 *  hold a whole one). Unlike cents above, this rounds rather than
 *  refusing: a jurisdiction's real rate routinely does not land on a
 *  whole basis point (6.625% is a real California district rate), and
 *  the fix is not asking an owner to misstate their own tax rate to two
 *  decimal places -- it's storing the nearest basis point and saying so.
 *  See formatBasisPointsAsPercent for the other half of that: telling
 *  the owner what actually landed in the database. */
export function parsePercentToBasisPoints(raw: string): number | null {
  return parseScaledDecimal(raw, 2);
}

/** The stored basis points, read back as the percentage they actually
 *  represent -- e.g. 663 -> "6.63%". This is what a rate typed as
 *  "6.625" rounds to once it's basis points; showing it is how the owner
 *  finds out their rate got adjusted at all. */
export function formatBasisPointsAsPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
