import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { startOfDayUtc } from "@/lib/data";
import type {
  BookingRow,
  CallRow,
  LocationRow,
  OrderRow,
} from "@/lib/supabase/types";

export type PortfolioRow = {
  location: LocationRow & { org_name: string };
  answered: number;
  missed: number;
  orders: number;
  revenueCents: number;
  bookings: number;
  transferred: number;
  spendCents: number;
  lastCallAt: string | null;
  /** Live if the agent is answering: on, not killed, forwarding proven. */
  health: "live" | "kill-switch" | "not-live" | "no-forwarding";
};

/** Every restaurant on the platform, with today's numbers in each one's
 *  own timezone.
 *
 *  Reads with the service role, so this must only ever be called behind
 *  currentPlatformAdmin(). Two window queries rather than one per
 *  location: the set is small, and a 48-hour window comfortably covers
 *  "today" in any timezone. */
export async function getPortfolio(): Promise<PortfolioRow[]> {
  const supabase = supabaseAdmin();
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

  const [locations, calls, orders, bookings] = await Promise.all([
    supabase.from("locations").select("*, organizations(name)").order("name"),
    supabase
      .from("calls")
      .select(
        "location_id, started_at, answered_at, transferred_to_human, is_spam, telephony_cost_cents, llm_cost_cents",
      )
      .gte("started_at", since),
    supabase
      .from("orders")
      .select("location_id, total_cents, placed_at")
      .gte("placed_at", since),
    supabase
      .from("bookings")
      .select("location_id, created_at")
      .gte("created_at", since),
  ]);

  if (locations.error) throw locations.error;
  if (calls.error) throw calls.error;
  if (orders.error) throw orders.error;
  if (bookings.error) throw bookings.error;

  type CallSlice = Pick<
    CallRow,
    | "location_id"
    | "started_at"
    | "answered_at"
    | "transferred_to_human"
    | "is_spam"
    | "telephony_cost_cents"
    | "llm_cost_cents"
  >;

  const callRows = (calls.data ?? []) as CallSlice[];
  const orderRows = (orders.data ?? []) as Pick<
    OrderRow,
    "location_id" | "total_cents" | "placed_at"
  >[];
  const bookingRows = (bookings.data ?? []) as (Pick<BookingRow, "location_id"> & {
    created_at: string;
  })[];

  return ((locations.data ?? []) as (LocationRow & {
    organizations: { name: string } | null;
  })[]).map((location) => {
    const dayStart = startOfDayUtc(location.timezone);
    const today = (iso: string) => iso >= dayStart;

    const mine = callRows.filter((c) => c.location_id === location.id);
    const todays = mine.filter((c) => today(c.started_at));
    const myOrders = orderRows.filter(
      (o) => o.location_id === location.id && today(o.placed_at),
    );

    const lastCall = mine
      .map((c) => c.started_at)
      .sort()
      .at(-1);

    return {
      location: { ...location, org_name: location.organizations?.name ?? "" },
      answered: todays.filter((c) => c.answered_at !== null).length,
      // A call that reached us and was never answered is the failure this
      // product exists to prevent, so it gets its own column.
      missed: todays.filter((c) => c.answered_at === null && !c.is_spam).length,
      orders: myOrders.length,
      revenueCents: myOrders.reduce((sum, o) => sum + o.total_cents, 0),
      bookings: bookingRows.filter(
        (b) => b.location_id === location.id && today(b.created_at),
      ).length,
      transferred: todays.filter((c) => c.transferred_to_human).length,
      spendCents: todays.reduce(
        (sum, c) => sum + c.telephony_cost_cents + c.llm_cost_cents,
        0,
      ),
      lastCallAt: lastCall ?? null,
      health: !location.is_live
        ? "not-live"
        : location.kill_switch_on
          ? "kill-switch"
          : !location.forwarding_verified_at
            ? "no-forwarding"
            : "live",
    };
  });
}

export async function getAdminLocation(locationId: string) {
  const supabase = supabaseAdmin();

  const [location, calls, orders, soldOut] = await Promise.all([
    supabase
      .from("locations")
      .select("*, organizations(name, plan)")
      .eq("id", locationId)
      .maybeSingle(),
    supabase
      .from("calls")
      .select("*")
      .eq("location_id", locationId)
      .order("started_at", { ascending: false })
      .limit(20),
    supabase
      .from("orders")
      .select("*")
      .eq("location_id", locationId)
      .order("placed_at", { ascending: false })
      .limit(10),
    supabase
      .from("menu_items")
      .select("id, name, sold_out_until")
      .eq("location_id", locationId)
      .not("sold_out_until", "is", null),
  ]);

  if (location.error) throw location.error;
  if (!location.data) return null;

  return {
    location: location.data as LocationRow & {
      organizations: { name: string; plan: string } | null;
    },
    calls: (calls.data ?? []) as CallRow[],
    orders: (orders.data ?? []) as OrderRow[],
    soldOut: (soldOut.data ?? []) as {
      id: string;
      name: string;
      sold_out_until: "reopen" | "close";
    }[],
  };
}
