import { redactCardNumbers } from "@/lib/agent/redact";

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

/** Does this menu item answer what the caller said? The predicate above,
 *  exported so there is exactly one definition of "the caller said this
 *  item" in the codebase.
 *
 *  `suggestAlternative` (lib/agent/menu.ts) needed an exact, whole-name
 *  match -- "Buffalo Wings", said perfectly -- while this file matched a
 *  spoken word against the name's words. Two matchers for one question
 *  drift, and these had: a caller who said "wings" got an order line
 *  (`matchItem` below finds Buffalo Wings) but no alternative when it was
 *  sold out, because nothing on the menu is literally called "wings". The
 *  prompt's "offer the closest thing that is available" then had nothing
 *  behind it at the one moment it exists for. */
export function matchesSpokenName(itemName: string, spoken: string) {
  const needleWords = wordsOf(spoken);
  if (needleWords.length === 0) return false;
  return wordAwareMatch(itemName, needleWords);
}

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

  const partial = items.filter((i) => matchesSpokenName(i.name, needle));
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
 *  NOT on the write path any more. `place_order` used to price here and
 *  send the totals to the database; since the order and its items have to
 *  commit together, the arithmetic moved into
 *  supabase/migrations/20260812000400_place_order.sql, where it is done
 *  over `numeric` from prices the function reads itself. This is now the
 *  tested statement of that same rule -- subtotal, then
 *  `round(subtotal * bps / 10000)`, both non-negative so Postgres'
 *  round-half-away-from-zero and JavaScript's round-half-up agree -- and
 *  the thing that would fail if the rule were ever changed in one place
 *  and not the other.
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

/** Upper bounds on what one phone call may order.
 *
 *  There was no bound at all: `normaliseQuantity` accepts any positive
 *  integer, so "fifty thousand" -- which is what a transcript reads when
 *  someone says "fifteen" down a bad line -- priced, wrote, and printed
 *  as a five-figure ticket, and a caller could put an unbounded number of
 *  lines on one order. Both of those are a bounded, speakable refusal
 *  rather than an order nobody can cook.
 *
 *  40 lines and 50 of any one item is far beyond a real phone order and
 *  still bounds the subtotal, the ticket, and the SMS to something a pass
 *  can read. Anything genuinely bigger is catering, which is a
 *  conversation with a human, not a tool call. These must stay in step
 *  with c_max_lines / c_max_qty in
 *  supabase/migrations/20260812000400_place_order.sql, which is the
 *  authority -- these two exist so the caller hears a sentence instead of
 *  an error. */
export const MAX_ORDER_LINES = 40;
export const MAX_ITEM_QUANTITY = 50;

/** How long a spoken change to one item may be.
 *
 *  "No onions", "sauce on the side, well done" -- a real modification is
 *  a handful of words. Anything past this is a transcript that ran away,
 *  and it has to be bounded for the same reasons the quantity is: it is
 *  written to a column, printed on a ticket a cook reads at a pass, and
 *  put in the body of an SMS. Kept in step with c_max_note_length in
 *  supabase/migrations/20260812000650_place_order_item_notes.sql, which
 *  is the authority; this one exists so the caller hears a sentence
 *  instead of an error. */
export const MAX_ITEM_NOTE_LENGTH = 200;

export type ItemNoteResult = { ok: true; note: string | null } | { ok: false };

/** What the caller wants done differently to one item, or nothing.
 *
 *  Free text by design: we do not price modifiers (see the gap in
 *  docs/vapi-setup.md), so this is a message to the kitchen, not a menu
 *  decision. It still gets cleaned up on the way in:
 *
 *   - a non-string is refused, not ignored. Ignoring is what this whole
 *     change exists to stop -- a modification the caller heard confirmed
 *     back and the kitchen never saw. A number or an object here means
 *     the tool call is malformed, and the agent should ask again rather
 *     than cook the wrong food.
 *   - whitespace, including newlines, collapses to single spaces. A
 *     newline would break the kitchen ticket's line-per-item layout
 *     (lib/agent/notify.ts) into something a pass cannot read.
 *   - card-like digit runs are redacted, because this is a new free-text
 *     write path for words a caller actually said, and it egresses
 *     further than any other one: to a column, to the ticket, and out to
 *     Twilio in the SMS body. `redactCardNumbers` (lib/agent/redact.ts)
 *     is meant to be the one place that promise is kept.
 *   - absent, null, or blank after all that is simply no note. */
export function normaliseItemNote(value: unknown): ItemNoteResult {
  if (value === undefined || value === null) return { ok: true, note: null };
  if (typeof value !== "string") return { ok: false };

  const cleaned = redactCardNumbers(value.replace(/\s+/g, " ").trim());
  if (cleaned === "") return { ok: true, note: null };
  if (cleaned.length > MAX_ITEM_NOTE_LENGTH) return { ok: false };
  return { ok: true, note: cleaned };
}

export type OrderType = "pickup" | "delivery";

/** What the caller's `type` actually means, or null if it cannot be told.
 *
 *  This used to be `body.type === "delivery" ? "delivery" : "pickup"`,
 *  which is wrong twice over. "Delivery" or "DELIVERY" -- either of which
 *  a model may emit for an enum it was told about in prose -- silently
 *  became a PICKUP order, and with it the address was silently dropped,
 *  so a caller who asked for delivery was told to come and collect. And
 *  any unrecognised value at all took the same silent path.
 *
 *  So: case- and whitespace-insensitive, and an unrecognised value is
 *  null (the route refuses and asks) rather than a guess. Deliberately no
 *  synonym list -- "takeaway", "collection", "drop off" are not accepted,
 *  because inventing a mapping from words nobody has agreed on is the
 *  same guessing this exists to stop. An absent value is the one thing
 *  that still defaults, to pickup: omitting the field is how the tool
 *  contract says "the ordinary case", and every pickup order would
 *  otherwise need a redundant question. */
export function normaliseOrderType(value: unknown): OrderType | null {
  if (value === undefined || value === null) return "pickup";
  if (typeof value !== "string") return null;
  const normalised = value.trim().toLowerCase();
  if (normalised === "") return "pickup";
  if (normalised === "pickup" || normalised === "delivery") return normalised;
  return null;
}

export type OrderLine = { item: PricedItem; quantity: number; note: string | null };

export type RequestedItem = { name?: string; quantity?: unknown; note?: unknown };

export type OrderLinesResult =
  | { ok: true; lines: OrderLine[] }
  | {
      ok: false;
      reason:
        | "unknown_item"
        | "sold_out"
        | "bad_quantity"
        | "bad_note"
        | "too_many_items"
        | "too_many_of_item";
      item: string | undefined;
    };

/** Turn what a caller asked for into priced-and-ready order lines, or the
 *  reason it cannot be done yet. This is the place `place_order`
 *  (`app/api/agent/order/route.ts`) delegates to for every requested
 *  item, pulled out so the three ways one can fail to become a line can
 *  be tested without a database:
 *
 *  - "unknown_item": nothing on the menu matches (`matchItem`).
 *  - "sold_out": it matches, but is flagged out right now. Re-checked
 *    here even though `get_menu` already reported it -- a manager can
 *    flag an item out from the dashboard while this very call is still
 *    in progress, and this is the last checkpoint before the order is
 *    written.
 *  - "bad_quantity": `normaliseQuantity` could not make sense of the
 *    quantity at all (missing, "two", fractional, zero, negative...).
 *  - "bad_note": the change asked for on that item was not text, or was
 *    longer than a spoken modification can plausibly be
 *    (`MAX_ITEM_NOTE_LENGTH`).
 *  - "too_many_items" / "too_many_of_item": more lines, or more of one
 *    line, than a phone order is allowed to be (`MAX_ORDER_LINES`,
 *    `MAX_ITEM_QUANTITY`).
 *
 *  "unknown_item" and "sold_out" are ordinary outcomes the agent speaks
 *  to the caller (`agentOk({placed: false, reason, item})`), the same
 *  way a full house is an ordinary outcome for a booking.
 *  "bad_quantity" and "bad_note" are not menu decisions -- they mean the
 *  request itself could not be understood, so the route is expected to
 *  treat them like a missing name or phone number and answer with
 *  `agentFail` instead. Because every
 *  quantity that reaches a returned line has already passed
 *  `normaliseQuantity`, `priceOrder`'s own invariant-guard throw is
 *  unreachable for lines built here. */
export function buildOrderLines(menu: PricedItem[], requested: RequestedItem[]): OrderLinesResult {
  if (requested.length > MAX_ORDER_LINES) {
    return { ok: false, reason: "too_many_items", item: undefined };
  }

  const lines: OrderLine[] = [];

  for (const requestedItem of requested) {
    const match = matchItem(menu, requestedItem.name ?? "");
    if (!match) {
      return { ok: false, reason: "unknown_item", item: requestedItem.name };
    }
    if (match.sold_out_until !== null) {
      return { ok: false, reason: "sold_out", item: match.name };
    }
    const quantity = normaliseQuantity(requestedItem.quantity ?? 1);
    if (quantity === null) {
      return { ok: false, reason: "bad_quantity", item: requestedItem.name };
    }
    // Refused rather than dropped. A change the caller heard confirmed
    // back ("got it, no onions") and the kitchen never saw is the exact
    // failure this field was added for; silently discarding one that
    // arrived in the wrong shape would reintroduce it one level down.
    const note = normaliseItemNote(requestedItem.note);
    if (!note.ok) {
      return { ok: false, reason: "bad_note", item: match.name };
    }
    // Named with the item the caller actually asked for, so the refusal
    // can say which one was too many rather than "that".
    if (quantity > MAX_ITEM_QUANTITY) {
      return { ok: false, reason: "too_many_of_item", item: match.name };
    }
    lines.push({ item: match, quantity, note: note.note });
  }

  return { ok: true, lines };
}
