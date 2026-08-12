import { supabaseServer } from "@/lib/supabase/server";
import type {
  BookingRow,
  CallRow,
  LocationRow,
  MenuCategoryRow,
  MenuItemRow,
  OrderItemRow,
  OrderRow,
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

  const [order, booking] = await Promise.all([
    supabase
      .from("orders")
      .select("*, order_items(*)")
      .eq("call_id", callId)
      .maybeSingle(),
    supabase.from("bookings").select("*").eq("call_id", callId).maybeSingle(),
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
