import type { CallOutcome, OrderStatus } from "@/lib/supabase/types";

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const mmss = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export const OUTCOME_TAG: Record<CallOutcome, string> = {
  order: "tag tag-accent",
  booking: "tag tag-accent-2",
  question: "tag tag-neutral",
  transferred: "tag tag-outline",
  spam: "tag tag-neutral",
  abandoned: "tag tag-neutral",
};

/** An order's state, in the same four system tags every other state in
 *  this product is spent on.
 *
 *  Beside OUTCOME_TAG because it answers the same question one tab over.
 *  The console's Calls tab puts a call's outcome through OUTCOME_TAG and
 *  its status through `tag tag-neutral`; the Orders tab printed a bare
 *  word, so "how is a state shown" had two answers one press apart --
 *  inside the pass whose whole argument was that four states map onto
 *  four tags with the word inside the chip.
 *
 *  Six values onto four tags, and the grouping is the one /admin already
 *  uses for a restaurant's health: the settled good outcome takes accent,
 *  the ones still in flight are quiet, and the one that went wrong takes
 *  the negative chip. Closed union, so a status added to the schema fails
 *  to compile here rather than rendering as nothing. */
export const ORDER_TAG: Record<OrderStatus, string> = {
  new: "tag tag-neutral",
  confirmed: "tag tag-neutral",
  preparing: "tag tag-neutral",
  ready: "tag tag-accent",
  completed: "tag tag-accent",
  cancelled: "tag tag-out",
};

/** The columns of the Orders board, in the approved design's own order
 *  and with its own words -- design/Dialtone.html's Orders screen is
 *  three columns headed New, In the kitchen and Ready, each with a count
 *  beside the heading and a sentence for when it is empty.
 *
 *  Here rather than in the page for the same reason ORDER_TAG is: it is
 *  the vocabulary a status is READ in, and a second copy of it is how a
 *  status ends up meaning two things on two screens. */
export type OrderBoardColumn = "new" | "kitchen" | "ready";

export const ORDER_BOARD_COLUMNS: {
  key: OrderBoardColumn;
  name: string;
  emptyNote: string;
}[] = [
  { key: "new", name: "New", emptyNote: "Quiet for the moment." },
  { key: "kitchen", name: "In the kitchen", emptyNote: "Nothing here." },
  { key: "ready", name: "Ready", emptyNote: "Nothing here." },
];

/** Which column a status belongs in, and NULL for the two the approved
 *  board has no column for.
 *
 *  Six statuses onto three columns and a hole. 'new' and 'confirmed'
 *  share the first: both mean a ticket nobody has started cooking, and
 *  the board's first column is for exactly that. 'preparing' is the
 *  kitchen, 'ready' is the pass.
 *
 *  'completed' and 'cancelled' map to null ON PURPOSE, and the null is
 *  the point: it is a value the screen has to handle rather than a row
 *  that quietly evaporates. A board that silently dropped them would be
 *  this product's original sin -- an order taken and then hidden from
 *  the restaurant -- committed one status further along.
 *
 *  Closed union, like ORDER_TAG above: a seventh status added to the
 *  schema fails to compile here instead of rendering nowhere. */
export const ORDER_BOARD_COLUMN: Record<OrderStatus, OrderBoardColumn | null> = {
  new: "new",
  confirmed: "new",
  preparing: "kitchen",
  ready: "ready",
  completed: null,
  cancelled: null,
};

/** Clock time in the location's timezone, and NOTHING ELSE.
 *
 *  ONLY for a moment whose date the thing around it has already
 *  established -- the three rows of one call's timeline under a heading
 *  that carries the date, and nothing wider than that.
 *
 *  NOT for a row in a log. "11:09 AM" on its own does not say which
 *  11:09 AM, and the reader has no way to find out: a call from three
 *  days ago read exactly like one from this morning, in a console whose
 *  next panel said "0 answered today". Every log in this product is
 *  bounded by COUNT ("the last twenty", "the last ten") and not by age,
 *  so any row in one of them can be arbitrarily old. Use dateTimeIn. */
export function timeIn(timezone: string, iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(iso));
}

/** The whole instant, in the location's timezone. The database stores
 *  UTC; nobody at the restaurant thinks in it.
 *
 *  ABSOLUTE AND TOTAL, and both halves of that are load-bearing.
 *
 *  Absolute: no reference to "now", so this string is the same on a
 *  server render, on a client render, on a console tab an operator left
 *  open overnight, and in a screenshot pasted into a ticket next March.
 *  A relative form ("11:09 AM today") is only true at the moment it is
 *  computed. Server components here are per-request, so it would be
 *  right at first paint -- and then quietly wrong at 00:01, which is
 *  the original defect back again with a delay on it and no way for the
 *  reader to notice. The cost is that today's rows repeat today's date;
 *  that is noise, and noise that cannot go stale is the cheaper of the
 *  two failures for a log people read to answer "when did this happen".
 *
 *  Total: the YEAR is in it. Without it "Aug 14, 11:09 AM" identifies an
 *  instant only to within a year, and these logs are bounded by count
 *  rather than by age -- ten orders is months for a quiet restaurant --
 *  so a row old enough to collide is reachable in the ordinary product.
 *  Twelve more characters buys a string that can never be misread. */
export function dateTimeIn(timezone: string, iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(iso));
}

export function dateIn(timezone: string, date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  }).format(date);
}

/** Whether an instant has already gone by.
 *
 *  Beside `relative` and defaulted the same way, for the same two
 *  reasons: it is the same question about the same clock, and a caller
 *  that wants a fixed instant (a test, or a render that must measure
 *  every row against one moment) passes one. It lives here rather than
 *  in the one screen that asks it because `Date.now()` inside a
 *  component body is an impure call in a render -- react-hooks/purity
 *  rejects it -- and because "is this order past the time we promised
 *  it" is a question a second screen will ask. */
export function isPast(iso: string, now = Date.now()) {
  return new Date(iso).getTime() < now;
}

export function relative(iso: string, now = Date.now()) {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/* ── what a call's transcript column means, in words ────────────────── */

/** The four states `calls.transcript_status` can hold, said the way an
 *  operator or an owner would say them.
 *
 *  Here rather than on a page because both call screens read the same
 *  column and must not describe it differently -- an operator on the
 *  phone to a restaurant is looking at the same call the restaurant is.
 *  `null` is a row written before the column existed. */
const TRANSCRIPT_STATE: Record<string, string> = {
  ready: "ready",
  pending: "still being written",
  failed: "could not be taken",
  skipped: "not taken for this call",
};

export function transcriptState(status: string | null): string {
  if (!status) return "not recorded";
  return TRANSCRIPT_STATE[status] ?? status;
}

/** The extra sentence a call screen owes the reader, or null when the
 *  player's own line already says the true thing.
 *
 *  <CallPlayer> ends an empty transcript with "It appears once the call
 *  is processed", which is exactly right while the end-of-call report is
 *  still in flight and wrong once it has arrived without one. So this
 *  fires for `failed` and `skipped` and NOTHING ELSE.
 *
 *  NOT for 'pending', which is the schema default (20260807000100) and
 *  therefore the state of every call whose report has not landed --
 *  including one an operator is looking at while it is still up. Saying
 *  "nothing more will arrive" about a report that is on its way is a
 *  false statement on the one screen somebody opens to find out why a
 *  call looks wrong, and it contradicted the player's own sentence
 *  directly above it. Two sentences, both on screen, and they could not
 *  both be true.
 *
 *  Not for 'ready' or null either, and not for an enum value added
 *  later: a state this function does not recognise is not one it gets to
 *  make a promise about. */
export function transcriptNote(status: string | null): string | null {
  if (status !== "failed" && status !== "skipped") return null;
  return (
    `Transcript ${transcriptState(status)}. Nothing more will arrive for ` +
    `this call unless the end-of-call report is replayed.`
  );
}
