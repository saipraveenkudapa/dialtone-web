import { supabaseServer } from "@/lib/supabase/server";
import { MENU_UPLOAD_BUCKET } from "@/lib/menu-imports/file";
import { readExtraction } from "@/lib/menu-imports/review";
import { redactCardNumbers } from "@/lib/agent/redact";
import type { MenuExtraction } from "@/lib/menu-imports/extraction";
import type { OrderActorRole } from "@/lib/orders/history";
import type {
  BookingRow,
  CallRow,
  LocationRow,
  MenuCategoryRow,
  MenuImportRow,
  MenuItemRow,
  MessageRow,
  OrderItemRow,
  OrderRow,
  OrderStatus,
} from "@/lib/supabase/types";

export type MenuCategoryWithItems = MenuCategoryRow & { items: MenuItemRow[] };

/** The location the signed-in user is working in. RLS already limits this
 *  to their own organizations, so no org filter is needed here — and none
 *  would help if RLS were wrong. Multi-location picking comes later; for
 *  now it is the first location by name. */
export async function getCurrentLocation(): Promise<LocationRow | null> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("locations")
    .select("*")
    .order("name")
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as LocationRow | null;
}

export async function getMenu(locationId: string): Promise<MenuCategoryWithItems[]> {
  const supabase = await supabaseServer();

  const [categories, items] = await Promise.all([
    supabase
      .from("menu_categories")
      .select("*")
      .eq("location_id", locationId)
      .order("sort_order"),
    supabase
      .from("menu_items")
      .select("*")
      .eq("location_id", locationId)
      .order("sort_order"),
  ]);

  if (categories.error) throw categories.error;
  if (items.error) throw items.error;

  const byCategory = new Map<string, MenuItemRow[]>();
  for (const item of (items.data ?? []) as MenuItemRow[]) {
    const list = byCategory.get(item.category_id) ?? [];
    list.push(item);
    byCategory.set(item.category_id, list);
  }

  return ((categories.data ?? []) as MenuCategoryRow[]).map((c) => ({
    ...c,
    items: byCategory.get(c.id) ?? [],
  }));
}

/** Menu files uploaded and not yet turned into a menu.
 *
 *  RLS limits this to the caller's own restaurant, as it does everywhere
 *  else in this file. Newest first: the thing somebody is looking for is
 *  the thing they just uploaded. */
export async function getMenuImports(locationId: string): Promise<MenuImportRow[]> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("menu_imports")
    .select("*")
    .eq("location_id", locationId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw error;
  return (data ?? []) as MenuImportRow[];
}

/** One uploaded file of a batch, with a link to look at it.
 *
 *  `index` is the file's place in the read, taken from the row's own
 *  extraction rather than from the order rows came back in: every item
 *  says which file it was read from by that number, and "check this
 *  against the photo" has to point at the right photo. */
export type MenuImportFile = {
  index: number;
  row: MenuImportRow;
  url: string | null;
};

export type MenuImportBatch = {
  batchId: string;
  rows: MenuImportRow[];
  files: MenuImportFile[];
  /** The read, taken from whichever row of the batch carries it. Every
   *  row of a batch stores the same reading -- they differ only in which
   *  file each one is -- because a section that runs off the bottom of
   *  one photo onto the top of the next is one section. */
  extraction: MenuExtraction | null;
  status: MenuImportRow["status"];
};

/** How long a link to look at the uploaded menu is good for.
 *
 *  Longer than the five minutes everything else in this app signs for,
 *  and for a stated reason: this is the one screen where somebody sits
 *  with the photograph open, checking forty prices against it. A link
 *  that dies mid-review sends them back to the start. An hour is still
 *  short enough that a URL pasted into a group chat stops working. */
const REVIEW_URL_SECONDS = 3600;

/** One batch of uploaded files, ready to be reviewed.
 *
 *  Read on the user's own session, so RLS answers "someone else's import"
 *  and "no such import" the same way. Returns null for both. */
export async function getMenuImportBatch(
  locationId: string,
  batchId: string,
): Promise<MenuImportBatch | null> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("menu_imports")
    .select("*")
    .eq("location_id", locationId)
    .eq("batch_id", batchId)
    .order("created_at", { ascending: true });

  if (error) throw error;

  const rows = (data ?? []) as MenuImportRow[];
  if (rows.length === 0) return null;

  const extraction =
    rows.map((row) => readExtraction(row.raw_extraction)).find((e) => e !== null) ?? null;

  const files: MenuImportFile[] = await Promise.all(
    rows.map(async (row, position) => {
      const read = readExtraction(row.raw_extraction);
      const index = read?.file?.index ?? position;
      return { index, row, url: await getMenuUploadUrl(row.source_path) };
    }),
  );

  files.sort((a, b) => a.index - b.index);

  // The batch is as far along as its least-finished row. Rows of one
  // batch move together -- publishing confirms all of them in one
  // transaction -- so this only ever disagrees while something is wrong,
  // and then it disagrees on the safe side.
  const status = rows.some((row) => row.status === "needs_review")
    ? "needs_review"
    : rows.some((row) => row.status === "pending")
      ? "pending"
      : rows[0].status;

  return { batchId, rows, files, extraction, status };
}

async function getMenuUploadUrl(path: string | null): Promise<string | null> {
  if (!path) return null;

  const supabase = await supabaseServer();
  const { data, error } = await supabase.storage
    .from(MENU_UPLOAD_BUCKET)
    .createSignedUrl(path, REVIEW_URL_SECONDS);

  if (error) {
    console.error("[menu-imports] could not sign a review url", error);
    return null;
  }
  return data.signedUrl;
}

export async function getRecentCalls(locationId: string, limit = 25) {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("calls")
    .select("*")
    .eq("location_id", locationId)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as CallRow[];
}

/** A call the agent is on right now. Realtime keeps the dashboard honest;
 *  this is the value at first paint. */
export async function getLiveCall(locationId: string) {
  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("calls")
    .select("*")
    .eq("location_id", locationId)
    .in("status", ["ringing", "in_progress"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data as CallRow | null;
}

export type TodayStats = {
  answered: number;
  orders: number;
  ordersRevenueCents: number;
  bookings: number;
  covers: number;
  transferred: number;
  transferReasons: string[];
  spendCents: number;
};

/** Everything the Today page counts, from the start of the day in the
 *  location's own timezone — not the server's. */
export async function getTodayStats(
  locationId: string,
  timezone: string,
): Promise<TodayStats> {
  const supabase = await supabaseServer();
  const since = startOfDayUtc(timezone);

  const [calls, orders, bookings] = await Promise.all([
    supabase
      .from("calls")
      .select("outcome, answered_at, transferred_to_human, transfer_reason, telephony_cost_cents, llm_cost_cents")
      .eq("location_id", locationId)
      .gte("started_at", since),
    supabase
      .from("orders")
      .select("total_cents")
      .eq("location_id", locationId)
      .gte("placed_at", since),
    supabase
      .from("bookings")
      .select("party_size")
      .eq("location_id", locationId)
      .gte("created_at", since),
  ]);

  if (calls.error) throw calls.error;
  if (orders.error) throw orders.error;
  if (bookings.error) throw bookings.error;

  const callRows = (calls.data ?? []) as Pick<
    CallRow,
    "outcome" | "answered_at" | "transferred_to_human" | "transfer_reason" | "telephony_cost_cents" | "llm_cost_cents"
  >[];
  const orderRows = (orders.data ?? []) as Pick<OrderRow, "total_cents">[];
  const bookingRows = (bookings.data ?? []) as Pick<BookingRow, "party_size">[];

  return {
    answered: callRows.filter((c) => c.answered_at !== null).length,
    orders: orderRows.length,
    ordersRevenueCents: orderRows.reduce((sum, o) => sum + o.total_cents, 0),
    bookings: bookingRows.length,
    covers: bookingRows.reduce((sum, b) => sum + b.party_size, 0),
    transferred: callRows.filter((c) => c.transferred_to_human).length,
    transferReasons: callRows
      .filter((c) => c.transferred_to_human && c.transfer_reason)
      .map((c) => c.transfer_reason as string),
    spendCents: callRows.reduce(
      (sum, c) => sum + c.telephony_cost_cents + c.llm_cost_cents,
      0,
    ),
  };
}

/** Midnight today in the given IANA timezone, as an ISO string in UTC. */
export function startOfDayUtc(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const secondsIntoLocalDay =
    // Intl renders midnight as hour 24 in some locales/engines.
    (get("hour") % 24) * 3600 + get("minute") * 60 + get("second");

  return new Date(now.getTime() - secondsIntoLocalDay * 1000).toISOString();
}

export type TranscriptLine = { at: number; who: "caller" | "agent"; text: string };

/** One call, with whatever it produced. Returns null when the id is not
 *  visible to this user -- RLS makes "someone else's call" and "no such
 *  call" indistinguishable, which is what we want. */
export async function getCall(callId: string) {
  const supabase = await supabaseServer();

  const { data: call, error } = await supabase
    .from("calls")
    .select("*")
    .eq("id", callId)
    .maybeSingle();

  if (error) throw error;
  if (!call) return null;

  const [order, booking, messages] = await Promise.all([
    supabase
      .from("orders")
      .select("*, order_items(*)")
      .eq("call_id", callId)
      .maybeSingle(),
    supabase.from("bookings").select("*").eq("call_id", callId).maybeSingle(),
    // A list, not `.maybeSingle()` like the two above. Nothing stops one
    // call producing two messages -- a retried tool call leaves a second
    // copy on purpose (see the migration), and a caller can say one more
    // thing before hanging up -- and `.maybeSingle()` answers more than
    // one row with an error, which would turn a duplicate message into a
    // call page that will not open at all. Oldest first, the order they
    // were taken in.
    supabase
      .from("messages")
      .select("*")
      .eq("call_id", callId)
      .order("taken_at", { ascending: true }),
  ]);

  return {
    call: call as CallRow & {
      recording_path: string | null;
      transcript: { lines?: TranscriptLine[] } | null;
      notes: string | null;
      dialed_number: string | null;
    },
    order: order.data as
      | (OrderRow & { order_items: OrderItemRow[] })
      | null,
    booking: booking.data as BookingRow | null,
    messages: (messages.data ?? []) as MessageRow[],
  };
}

/** A short-lived link to the audio.
 *
 *  The bucket is private and there is no public URL: playback is always a
 *  URL that expires, so a link pasted into a group chat stops working.
 *  Generated with the user's own session, so storage RLS decides -- the
 *  service role is not involved. */
export async function getRecordingUrl(path: string | null) {
  if (!path) return null;

  const supabase = await supabaseServer();
  const { data, error } = await supabase.storage
    .from("call-recordings")
    .createSignedUrl(path, 300);

  if (error) {
    console.error("[calls] could not sign recording url", error);
    return null;
  }
  return data.signedUrl;
}

export type CallFilter =
  | "all"
  | "orders"
  | "bookings"
  | "transferred"
  | "missed"
  | "spam";

export const CALL_FILTERS: { key: CallFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "orders", label: "Orders" },
  { key: "bookings", label: "Bookings" },
  { key: "transferred", label: "Sent to a human" },
  { key: "missed", label: "Missed" },
  { key: "spam", label: "Spam" },
];

export const CALLS_PER_PAGE = 50;

/** One page of the call log, plus what each call produced.
 *
 *  Counting and filtering happen in Postgres rather than in the page, so
 *  the log stays honest once a busy restaurant has thousands of calls. */
export async function getCallsPage(
  locationId: string,
  { filter = "all", page = 1 }: { filter?: CallFilter; page?: number } = {},
) {
  const supabase = await supabaseServer();

  const applyFilter = <T extends { eq: unknown; is: unknown }>(query: T): T => {
    let q = query as unknown as {
      eq: (c: string, v: unknown) => unknown;
      is: (c: string, v: unknown) => unknown;
    };
    if (filter === "orders") q = q.eq("outcome", "order") as typeof q;
    if (filter === "bookings") q = q.eq("outcome", "booking") as typeof q;
    if (filter === "transferred") q = q.eq("transferred_to_human", true) as typeof q;
    // Missed is the number this product is judged on: it reached us and
    // nobody picked up. Robocalls are not missed business.
    if (filter === "missed") {
      q = q.is("answered_at", null) as typeof q;
      q = q.eq("is_spam", false) as typeof q;
    }
    if (filter === "spam") q = q.eq("is_spam", true) as typeof q;
    return q as unknown as T;
  };

  // Count first. PostgREST rejects a range whose offset is past the end
  // of the result set (PGRST103) rather than returning an empty page, so
  // asking for page 9 of a 2-page log would be a 500 -- and a stale
  // bookmark or an edited URL is enough to hit it.
  const { count, error: countError } = await applyFilter(
    supabase
      .from("calls")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId),
  );

  if (countError) throw countError;

  const total = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / CALLS_PER_PAGE));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const from = (safePage - 1) * CALLS_PER_PAGE;

  const { data, error } = await applyFilter(
    supabase.from("calls").select("*").eq("location_id", locationId),
  )
    .order("started_at", { ascending: false })
    .range(from, from + CALLS_PER_PAGE - 1);

  if (error) throw error;

  const calls = (data ?? []) as CallRow[];
  const ids = calls.map((c) => c.id);

  // What came of each call, fetched in three queries rather than one per
  // row. Messages are here for the same reason they are a column on this
  // screen at all: an order and a booking are finished business, while a
  // message is somebody still waiting for the phone to ring, and the log
  // is where staff look first.
  const [orders, bookings, messages] = ids.length
    ? await Promise.all([
        supabase
          .from("orders")
          .select("call_id, order_number, total_cents")
          .in("call_id", ids),
        supabase
          .from("bookings")
          .select("call_id, party_size, requested_at")
          .in("call_id", ids),
        supabase.from("messages").select("call_id, handled").in("call_id", ids),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  const orderByCall = new Map(
    ((orders.data ?? []) as {
      call_id: string;
      order_number: number;
      total_cents: number;
    }[]).map((o) => [o.call_id, o]),
  );
  const bookingByCall = new Map(
    ((bookings.data ?? []) as {
      call_id: string;
      party_size: number;
      requested_at: string;
    }[]).map((b) => [b.call_id, b]),
  );

  // A call can leave more than one message (a retried tool call, or a
  // caller who says one more thing), so this counts rather than keeping
  // the last one -- and counts the unhandled ones separately, because
  // that is the only number the log needs to shout about.
  const messageByCall = new Map<string, { total: number; open: number }>();
  for (const m of (messages.data ?? []) as { call_id: string; handled: boolean }[]) {
    const seen = messageByCall.get(m.call_id) ?? { total: 0, open: 0 };
    messageByCall.set(m.call_id, {
      total: seen.total + 1,
      open: seen.open + (m.handled ? 0 : 1),
    });
  }

  return {
    calls,
    total,
    page: safePage,
    pageCount,
    orderByCall,
    bookingByCall,
    messageByCall,
  };
}

export type MessageFilter = "open" | "all";

export const MESSAGE_FILTERS: { key: MessageFilter; label: string }[] = [
  { key: "open", label: "Needs a callback" },
  { key: "all", label: "All" },
];

export const MESSAGES_PER_PAGE = 50;

/** The message book, read by location rather than by call.
 *
 *  `getCall` reads messages too, but only ever `.eq("call_id", callId)`,
 *  and for a long time that was the only reader in the product. A
 *  message is allowed to have no call: the tool call can arrive before
 *  the telephony webhook has written the `calls` row, so
 *  app/api/agent/message/route.ts writes `call_id: null` on purpose
 *  rather than refusing to take the message, and the foreign key is ON
 *  DELETE SET NULL so a message outlives the call it was taken on. Every
 *  one of those rows satisfied `messages_open_idx` -- "who is still
 *  waiting for a callback?" -- and appeared on no screen in the product.
 *  A caller who was told somebody would ring them back, and nobody could
 *  even find out they had rung, is the exact loss this feature exists to
 *  prevent.
 *
 *  So this asks the question the table was built to answer, filtered
 *  only by the restaurant and by whether anyone has dealt with it.
 *  Nothing here mentions `call_id`. RLS scopes the read to locations the
 *  signed-in user belongs to; the explicit `location_id` filter is what
 *  picks one of theirs, exactly as `getCallsPage` does. */
export async function getMessagesPage(
  locationId: string,
  { filter = "open", page = 1 }: { filter?: MessageFilter; page?: number } = {},
) {
  const supabase = await supabaseServer();

  // Counting twice on purpose: `total` is what this page is showing,
  // `open` is what the restaurant still owes somebody, and the header
  // says both whichever filter is on. Both are head requests -- no rows
  // cross the wire.
  const [counted, openCounted] = await Promise.all([
    filter === "open"
      ? supabase
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("location_id", locationId)
          .eq("handled", false)
      : supabase
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("location_id", locationId),
    supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId)
      .eq("handled", false),
  ]);

  if (counted.error) throw counted.error;
  if (openCounted.error) throw openCounted.error;

  // Same guard as the call log: PostgREST answers a range past the end of
  // the result set with PGRST103 rather than an empty page, and a stale
  // bookmark is enough to ask for one.
  const total = counted.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / MESSAGES_PER_PAGE));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const from = (safePage - 1) * MESSAGES_PER_PAGE;

  let rows = supabase.from("messages").select("*").eq("location_id", locationId);
  if (filter === "open") rows = rows.eq("handled", false);

  const { data, error } = await rows
    .order("taken_at", { ascending: false })
    .range(from, from + MESSAGES_PER_PAGE - 1);

  if (error) throw error;

  return {
    messages: (data ?? []) as MessageRow[],
    total,
    openTotal: openCounted.count ?? 0,
    page: safePage,
    pageCount,
  };
}

/* ── the orders board ────────────────────────────────────────────────
   The restaurant's own read of `orders`, for the screen a cook stands in
   front of. Everything that read this table before belonged to somebody
   else: the operator console's tab (lib/admin/data.ts, service role, ten
   rows, four columns), the Today counters, and the single order hanging
   off one call. None of them answers "what do I have to make, and by
   when", which is the only question this one exists for.

   On the signed-in user's session like every other read in this file, so
   RLS's `orders_rw` / `order_items_rw` decide what comes back. The
   explicit location filter picks one of the restaurants they belong to,
   exactly as getCallsPage and getMessagesPage do. */

/** How many orders the board carries.
 *
 *  A KITCHEN DOES NOT NEED EVERY ORDER EVER, and this is the number that
 *  says so. Fifty is more than a whole evening of phone orders at a busy
 *  restaurant -- MAX_ORDER_LINES is 40 lines on ONE order, and a
 *  location taking fifty calls that all end in an order is a very good
 *  night -- so a cook reading this board in service sees the whole of
 *  service on it. Beyond that it is history, and history is not what a
 *  pass is for.
 *
 *  Bounded by COUNT rather than by age, like every other log in this
 *  product (see dateTimeIn in lib/format.ts, which is why every time on
 *  this screen carries its date). Bounding by age would be the wrong
 *  cut here for a specific reason: nothing in the product moves an order
 *  out of 'new' yet, so "today's orders" and "the orders still to make"
 *  are not the same set, and the second one is the kitchen's question.
 *
 *  It is also a cap on the page's weight: fifty orders with their lines
 *  is one round trip and a few hundred rows, and it cannot grow with a
 *  restaurant's age. */
export const ORDERS_ON_THE_BOARD = 50;

/** One line of a ticket: what to make, how many, what it costs, and what
 *  the caller asked to be done differently to it. */
export type BoardLine = {
  id: string;
  name: string;
  quantity: number;
  /** The whole line -- the snapshot price times the quantity -- in
   *  integer cents, never a float and never formatted here. */
  totalCents: number;
  note: string | null;
};

/** One order, shaped for the people who have to cook it. */
export type BoardOrder = {
  id: string;
  orderNumber: number;
  /** The call it was taken on, when there still is one. `orders.call_id`
   *  is ON DELETE SET NULL, so an order outlives its call. */
  callId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  type: "pickup" | "delivery";
  status: OrderStatus;
  totalCents: number;
  placedAt: string;
  promisedAt: string | null;
  /** Where a delivery is going, scrubbed. Null on a pickup. */
  address: string | null;
  lines: BoardLine[];
};

/** What the caller asked for on one line, as a cook would read it.
 *
 *  `order_items.modifiers` is a jsonb array. `place_order` writes either
 *  `[]` or a one-element array holding the spoken note
 *  (20260812000650_place_order_item_notes.sql), and that migration
 *  deliberately left room for priced modifier OBJECTS to arrive in the
 *  same column later. So: strings are the note, anything else is not
 *  rendered as one -- an object printed at a pass is noise on a ticket,
 *  and guessing at its shape here would be inventing a sentence the
 *  caller never said.
 *
 *  Scrubbed through lib/agent/redact.ts on the way out. The write path
 *  already does this, and that is not enough: RLS's `order_items_rw`
 *  lets any member of the organization write this column directly, so
 *  the tool call is not the only way text gets in. Nothing this product
 *  renders may contain a card number, and the last read before the
 *  screen is the last place that promise can be kept. */
function itemNote(modifiers: unknown): string | null {
  if (!Array.isArray(modifiers)) return null;

  const said = modifiers
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (said.length === 0) return null;
  return redactCardNumbers(said.join(" · "));
}

/** The newest orders for one restaurant, with their lines.
 *
 *  Newest first, because the ticket that just landed is the one nobody
 *  has read yet. One round trip: the lines come back embedded rather
 *  than as a query per order.
 *
 *  Every status comes back, including the two the board has no column
 *  for -- the SCREEN decides what to do about a completed or cancelled
 *  order, and it can only be honest about them if the read does not
 *  quietly drop them first. */
export async function getOrdersBoard(locationId: string): Promise<BoardOrder[]> {
  const supabase = await supabaseServer();

  const { data, error } = await supabase
    .from("orders")
    .select("*, order_items(*)")
    .eq("location_id", locationId)
    .order("placed_at", { ascending: false })
    .limit(ORDERS_ON_THE_BOARD);

  // Thrown, not swallowed: an empty board and a failed read look
  // identical on screen, and one of them means "you have no orders"
  // while the other means "we cannot tell you".
  if (error) throw error;

  const rows = (data ?? []) as (OrderRow & { order_items: OrderItemRow[] })[];

  return rows.map(toBoardOrder);
}

/** One `orders` row with its lines, as a screen reads it.
 *
 *  Lifted out of getOrdersBoard when getOrderRecord needed the identical
 *  thing, and shared rather than copied for one reason above all the
 *  others: EVERY REDACTION DECISION IN THIS PRODUCT IS IN HERE. Which of
 *  the four caller-spoken fields is scrubbed, which one deliberately is
 *  not, and why, is an argument that took a whole pass to settle
 *  (lib/orders/board.test.ts pins both halves of it). A second copy of
 *  this mapping is how one screen keeps that promise and the next one
 *  quietly stops keeping it. */
function toBoardOrder(row: OrderRow & { order_items: OrderItemRow[] }): BoardOrder {
  return {
    id: row.id,
    orderNumber: row.order_number,
    callId: row.call_id,
    // Scrubbed like the item note and the address below, and for the
    // same reason: `place_order` writes `btrim(p_customer_name)` straight
    // off the tool call, `orders_rw` lets any member of the organization
    // write the column directly, and the constraint is absolute. No name
    // anybody is called reaches the thirteen consecutive digits
    // CARD_NUMBER_RUN matches at, so there is no real name this damages.
    customerName:
      row.customer_name === null ? null : redactCardNumbers(row.customer_name),
    // NOT SCRUBBED, deliberately, and this is the line a later pass will
    // try to make consistent with the one above. lib/agent/redact.ts says
    // redactCardNumbers is "exactly wrong for a field whose entire value
    // is the digits -- a callback number": an overseas caller's number
    // reaches the 13-digit floor easily ("011 44 20 7946 0958" is
    // fifteen), and running this field through the scrubber would not
    // clean it, it would delete the only way the restaurant can ring them
    // back. Ringing people back is half of why the number is on the
    // ticket, so it goes out whole.
    customerPhone: row.customer_phone,
    type: row.type,
    status: row.status,
    totalCents: row.total_cents,
    placedAt: row.placed_at,
    promisedAt: row.promised_at,
    // `orders.notes` IS the delivery address (see OrderRow). Scrubbed
    // for the same reason an item note is, and with more cause: this is
    // the one caller-spoken string `place_order` stores exactly as it
    // arrives, with no redactCardNumbers anywhere on the write path.
    address: row.notes === null ? null : redactCardNumbers(row.notes),
    // The order the lines come back in is the order they were inserted
    // in, which `place_order` takes care to make the order the caller
    // said them in. There is no sort column on order_items to ask for.
    lines: (row.order_items ?? []).map((item) => ({
      id: item.id,
      name: item.name_snapshot,
      quantity: item.quantity,
      totalCents: item.price_cents_snapshot * item.quantity,
      note: itemNote(item.modifiers),
    })),
  };
}

/* ── the orders the board is finished with ───────────────────────────
   THE OTHER HALF OF THE SAME TABLE, and the half nobody could see.

   getOrdersBoard above is a pass: fifty rows, every status, and the
   SCREEN drops the two the approved board has no column for. So the
   moment a cook presses "Picked up" the order leaves the restaurant's
   world -- every line of it, the money on it, the caller who is owed
   it -- and the board's whole trace of it is one sentence saying how
   many it is not showing. There was no screen anywhere that listed a
   finished order again, and none at all that read `order_status_events`,
   which has recorded who moved what and when since the schema's first
   migration.

   Everything below reads on the SIGNED-IN USER's session like the rest
   of this file, so RLS decides. `orders_rw` and `order_items_rw` scope
   the order and its lines; `order_status_events_read`
   (20260807000200_rls.sql) scopes the log through its `orders` join --
   `using (exists (select 1 from orders o where o.id = order_id and
   app.can_access_location(o.location_id)))` -- so an owner may read the
   log of their own orders and of no others. `membership_read_own` is
   what makes the roles readable. No service role, no platform-admin
   gate, no second key. */

/** How many finished orders one page carries.
 *
 *  Fifty, the same as CALLS_PER_PAGE and MESSAGES_PER_PAGE, because it
 *  is the same screen furniture answering the same question and a reader
 *  who has learned one pager has learned all three.
 *
 *  IT IS NOT ORDERS_ON_THE_BOARD AND MUST NOT BECOME IT. That constant
 *  is a statement about a kitchen -- fifty is more than a whole evening
 *  of phone orders, so a cook reading the board in service sees the
 *  whole of service on it -- and it is a CEILING: the board never asks
 *  for a fifty-first row. This one is a window onto something with no
 *  ceiling at all. A restaurant taking sixty orders a night writes
 *  roughly 420 a week, 1,800 a month and 22,000 a year, and none of them
 *  ever leaves the table. */
export const ORDERS_PER_HISTORY_PAGE = 50;

/** The two statuses the approved board has no column for.
 *
 *  Stated once, read by the query and by the screen's own sentences.
 *  History is deliberately NOT "every order": a live ticket belongs to
 *  the pass, and a second screen that also renders it is a second answer
 *  to "what is the kitchen doing", which is the disagreement the board
 *  exists to end. */
export const ORDER_HISTORY_STATUSES: readonly OrderStatus[] = ["completed", "cancelled"];

/** How far back one page of history reaches.
 *
 *  A BOARD CAN BE BOUNDED BY COUNT AND A HISTORY CANNOT, and this is the
 *  whole of the scale decision. Bounding by count -- "the last fifty
 *  finished orders" -- is not a window anybody can ask a question of:
 *  "what did we take last Tuesday" has no answer in it. Bounding by
 *  nothing is a select that grows with the restaurant until the page
 *  times out, and it does that first for the busiest customer on the
 *  platform.
 *
 *  So: a window chosen HERE, and a page of fifty inside it. The window
 *  is what keeps the ordinary read cheap -- the default asks Postgres
 *  about a week of orders rather than about a decade of them -- and the
 *  pager is what keeps even the widest one bounded, because "Everything"
 *  removes the date filter and not the fifty-row range.
 *
 *  Both halves ride the index the schema already has:
 *  `orders_location_status_idx on orders (location_id, status, placed_at
 *  desc)` (20260807000100_schema.sql) is exactly `where location_id = ?
 *  and status in (...) order by placed_at desc`, so no migration is
 *  needed for this read and the page's cost does not grow with the
 *  table. What does grow is the exact COUNT behind the pager, which is
 *  linear in the rows the window matches -- which is the second reason
 *  the default is a week and not everything. */
export type OrderHistoryWindow = "today" | "week" | "month" | "all";

/** The options, in the order they are drawn, with the number of LOCAL
 *  DAYS each reaches back over. `null` is the one with no floor. */
export const ORDER_HISTORY_WINDOWS: {
  key: OrderHistoryWindow;
  label: string;
  days: number | null;
}[] = [
  { key: "today", label: "Today", days: 1 },
  { key: "week", label: "Last 7 days", days: 7 },
  { key: "month", label: "Last 30 days", days: 30 },
  { key: "all", label: "Everything", days: null },
];

/** What the screen reads when the URL asks for nothing.
 *
 *  A week rather than today, because an owner opens this after service
 *  or the morning after and "today" is thin at both of those moments;
 *  and a week rather than everything, because the default is the read
 *  that runs on every visit and the default should be the cheap one. */
export const DEFAULT_ORDER_HISTORY_WINDOW: OrderHistoryWindow = "week";

/** The instant a window opens, or null for the one that has no floor.
 *
 *  CUT ON THE RESTAURANT'S CLOCK AND NOT ON UTC, which is the only way
 *  this can be right. A New York restaurant serving until 10pm writes
 *  `placed_at` values that are already tomorrow in UTC; a "Today" cut at
 *  UTC midnight drops the busiest two hours of last night out of today's
 *  history while the staff who cooked it are still in the building.
 *  Built on the same startOfDayUtc the Today counters use, so the two
 *  screens cannot come to disagree about when a restaurant's day starts.
 *
 *  `days` counts whole local days INCLUDING today, so "Last 7 days"
 *  opens at midnight six days ago: a week of service, not eight.
 *
 *  Across a daylight-saving change the arithmetic can land on the local
 *  day before the one it aimed at, because it steps back in fixed
 *  24-hour hops through a day that was 23 or 25 hours long. That is
 *  bounded at one day, it happens twice a year, and it errs by showing
 *  ONE MORE day of finished orders rather than one fewer -- the right
 *  direction for the only failure a history screen must not have, which
 *  is an order that is not on it. */
export function orderHistoryWindowStart(
  timezone: string,
  window: OrderHistoryWindow,
  now = new Date(),
): string | null {
  const days = ORDER_HISTORY_WINDOWS.find((w) => w.key === window)?.days ?? null;
  if (days === null) return null;

  return startOfDayUtc(timezone, new Date(now.getTime() - (days - 1) * 86_400_000));
}

/** One row of the history list.
 *
 *  Deliberately NOT a BoardOrder. A list of fifty finished orders does
 *  not need fifty embedded line sets -- that is a few hundred rows over
 *  the wire to render a column nobody is reading -- and the lines are
 *  exactly what the one-order screen is for. */
export type HistoryOrder = {
  id: string;
  orderNumber: number;
  customerName: string | null;
  type: "pickup" | "delivery";
  status: OrderStatus;
  totalCents: number;
  placedAt: string;
};

/** One page of the orders this restaurant has finished with.
 *
 *  Counting and filtering happen in Postgres rather than in the page, so
 *  the history stays honest -- and stays the same weight -- once a busy
 *  restaurant has tens of thousands of orders. Same shape, and the same
 *  reasons, as getCallsPage and getMessagesPage next door. */
export async function getOrderHistoryPage(
  locationId: string,
  {
    timezone,
    window = DEFAULT_ORDER_HISTORY_WINDOW,
    page = 1,
    now = new Date(),
  }: {
    timezone: string;
    window?: OrderHistoryWindow;
    page?: number;
    now?: Date;
  },
) {
  const supabase = await supabaseServer();
  const since = orderHistoryWindowStart(timezone, window, now);

  /* The window and the statuses, applied identically to the count and to
     the page. Written once so the pager can never end up counting a
     different set of orders than the one it is paging through. */
  const scoped = <T extends { eq: unknown; in: unknown; gte: unknown }>(query: T): T => {
    let q = query as unknown as {
      eq: (c: string, v: unknown) => unknown;
      in: (c: string, v: unknown[]) => unknown;
      gte: (c: string, v: unknown) => unknown;
    };
    q = q.eq("location_id", locationId) as typeof q;
    q = q.in("status", [...ORDER_HISTORY_STATUSES]) as typeof q;
    if (since !== null) q = q.gte("placed_at", since) as typeof q;
    return q as unknown as T;
  };

  // Count first, in a head request -- no rows cross the wire. PostgREST
  // rejects a range whose offset is past the end of the result set
  // (PGRST103) rather than returning an empty page, so asking for page 9
  // of a 2-page history would be a 500, and a stale bookmark or an
  // edited URL is enough to hit it.
  const { count, error: countError } = await scoped(
    supabase.from("orders").select("id", { count: "exact", head: true }),
  );

  if (countError) throw countError;

  const total = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / ORDERS_PER_HISTORY_PAGE));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const from = (safePage - 1) * ORDERS_PER_HISTORY_PAGE;

  const { data, error } = await scoped(
    supabase
      .from("orders")
      .select("id, order_number, customer_name, type, status, total_cents, placed_at"),
  )
    .order("placed_at", { ascending: false })
    .range(from, from + ORDERS_PER_HISTORY_PAGE - 1);

  // Thrown, not swallowed, for the same reason getOrdersBoard throws: an
  // empty history and a failed read look identical on screen, and one of
  // them means "you have taken no orders" while the other means "we
  // cannot tell you".
  if (error) throw error;

  const rows = (data ?? []) as Pick<
    OrderRow,
    "id" | "order_number" | "customer_name" | "type" | "status" | "total_cents" | "placed_at"
  >[];

  return {
    orders: rows.map((row) => ({
      id: row.id,
      orderNumber: row.order_number,
      // Scrubbed here for the identical reason toBoardOrder scrubs it:
      // the write path is not the only way text reaches this column, and
      // the last read before a screen is the last place the promise that
      // nothing renders a card number can be kept.
      customerName:
        row.customer_name === null ? null : redactCardNumbers(row.customer_name),
      type: row.type,
      status: row.status,
      totalCents: row.total_cents,
      placedAt: row.placed_at,
    })) satisfies HistoryOrder[],
    total,
    page: safePage,
    pageCount,
    since,
  };
}

/** One logged status change, as a screen reads it.
 *
 *  `from` is null on the row app.log_order_status writes AFTER INSERT --
 *  the order arriving. `changedBy` is a uuid or null and is NEVER
 *  rendered as either: see orderEventActor in lib/orders/history.ts. */
export type OrderStatusEvent = {
  id: string;
  from: OrderStatus | null;
  to: OrderStatus;
  changedBy: string | null;
  changedAt: string;
};

/** One order, everything about it, and everything that happened to it. */
export type OrderRecord = {
  order: BoardOrder;
  /** Oldest first: a timeline is read forwards. */
  events: OrderStatusEvent[];
  /** Every uuid this organization can put a role to, which is the whole
   *  of what the log can say about who somebody was. */
  actors: Record<string, OrderActorRole>;
  /** The signed-in user, so the timeline can say "you". Null when the
   *  session could not be resolved -- never a reason to guess. */
  viewerId: string | null;
};

/** One order in full, with its status log.
 *
 *  Returns null when the id is not this restaurant's or does not exist.
 *  RLS already makes another organization's order invisible; the
 *  explicit `location_id` filter is what picks one of the restaurants
 *  this user belongs to, exactly as getOrdersBoard does -- and it is
 *  what stops an order from a sister location being rendered against
 *  THIS location's clock, which is the one thing on this page that would
 *  be wrong rather than merely absent.
 *
 *  Two round trips, in that order and not in parallel: nothing else is
 *  asked of the database until the order itself has come back visible.
 *
 *  `completed_at` is deliberately not read. The column exists and
 *  app/dashboard/orders/actions.ts deliberately does not write it -- the
 *  log is the record of when an order finished -- so putting it on this
 *  screen would be publishing a null beside a timeline that has the
 *  answer, and inviting somebody to "fix" it by writing a second one. */
export async function getOrderRecord(
  locationId: string,
  orgId: string,
  orderId: string,
): Promise<OrderRecord | null> {
  const supabase = await supabaseServer();

  const { data: row, error } = await supabase
    .from("orders")
    .select("*, order_items(*)")
    .eq("id", orderId)
    .eq("location_id", locationId)
    .maybeSingle();

  if (error) throw error;
  if (!row) return null;

  const [events, members, session] = await Promise.all([
    // Only this order's log. `order_status_events` carries no
    // location_id -- its RLS policy joins through `orders` -- so this
    // filter is what keeps one order's page from being every order's.
    supabase
      .from("order_status_events")
      .select("id, from_status, to_status, changed_by, changed_at")
      .eq("order_id", orderId)
      .order("changed_at", { ascending: true }),
    // The roles, which are the whole of what this screen can say about
    // a colleague. Readable on the owner's own session under RLS's
    // membership_read_own; the explicit org filter is what keeps a
    // multi-org account from mixing two restaurants' staff.
    supabase.from("memberships").select("user_id, role").eq("org_id", orgId),
    supabase.auth.getUser(),
  ]);

  if (events.error) throw events.error;
  // Thrown too. A roles map that came back empty because the read failed
  // would silently retitle every colleague on the timeline as somebody
  // who has left the restaurant, which is a false statement about a
  // named person rather than a missing one.
  if (members.error) throw members.error;

  const actors: Record<string, OrderActorRole> = {};
  for (const m of (members.data ?? []) as { user_id: string; role: OrderActorRole }[]) {
    actors[m.user_id] = m.role;
  }

  return {
    order: toBoardOrder(row as OrderRow & { order_items: OrderItemRow[] }),
    events: ((events.data ?? []) as {
      id: string;
      from_status: OrderStatus | null;
      to_status: OrderStatus;
      changed_by: string | null;
      changed_at: string;
    }[]).map((e) => ({
      id: e.id,
      from: e.from_status,
      to: e.to_status,
      changedBy: e.changed_by,
      changedAt: e.changed_at,
    })),
    actors,
    viewerId: session.data.user?.id ?? null,
  };
}
