import "server-only";

import { currentPlatformAdmin } from "@/lib/admin/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { startOfDayUtc } from "@/lib/data";
import type { TranscriptLine } from "@/lib/data";
import type {
  BookingRow,
  CallRow,
  LocationRow,
  OrderRow,
} from "@/lib/supabase/types";

/* The RFC shape, held here rather than imported from lib/admin/edit.ts.
   Two reasons. This module owns the service-role key, and the one thing
   a module holding that key must not do is depend on its caller having
   remembered to validate -- lib/admin/edit.ts says the same of itself.
   And edit.ts drags Vapi provisioning in behind it, which no read on
   this path needs.

   Not /^[0-9a-f-]{36}$/i, which happily accepts thirty-six dashes and
   reaches PostgREST as a malformed uuid cast.

   At the top of the module rather than beside its first user: every
   service-role reader here that takes an id has to spend it, and one
   sitting further down the file is one the next reader above it does
   not know exists. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The four words the portfolio's health badge understands. Changing one
 *  means changing app/admin/page.tsx's HEALTH_LABEL, which maps them by
 *  name. */
export type LocationHealth = "live" | "kill-switch" | "not-live" | "no-forwarding";

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
  /** One word for what a caller gets right now. See locationHealth. */
  health: LocationHealth;
};

/** What a caller dialling this restaurant gets, in one word.
 *
 *  "no-forwarding" is deliberately narrow. Forwarding only means
 *  anything when the restaurant has a line of its own that is being
 *  forwarded to us -- business_phone -- and somebody has to ring it once
 *  to prove the carrier did what it was told. A restaurant that simply
 *  publishes the Dialtone number forwards nothing, so there is nothing
 *  to prove, and it used to be demoted from "Answering" to "Forwarding
 *  unproven" forever for a step it could never take. It is answering;
 *  the badge now says so.
 *
 *  Unproven forwarding is a warning either way, never a reason a
 *  restaurant cannot be live -- lib/provisioning/go-live.ts draws the
 *  same line on the same column, and the two must agree. */
export function locationHealth(
  location: Pick<
    LocationRow,
    "is_live" | "kill_switch_on" | "business_phone" | "forwarding_verified_at"
  >,
): LocationHealth {
  if (!location.is_live) return "not-live";
  if (location.kill_switch_on) return "kill-switch";
  if (location.business_phone && !location.forwarding_verified_at) return "no-forwarding";
  return "live";
}

/** Every restaurant on the platform, with today's numbers in each one's
 *  own timezone.
 *
 *  AUTHORIZATION IS HERE, NOT IN THE LAYOUT. This reads with the service
 *  role, which bypasses RLS for every tenant on the platform, and the
 *  comment this replaced said it "must only ever be called behind
 *  currentPlatformAdmin()" while relying on app/admin/layout.tsx to be
 *  that caller. A layout is not an authorization boundary: Next does not
 *  re-render a layout segment the requester's own
 *  Next-Router-State-Tree header claims to already hold
 *  (renderComponentsOnThisLevel in next/dist/server/app-render/
 *  walk-tree-with-flight-router-state.js), and that header's shape is
 *  validated while its correspondence to the requested URL is not. So a
 *  cookieless request carrying `RSC: 1` and a hand-written state tree
 *  reached this function with the layout -- and therefore the check --
 *  never having run, and got back every restaurant's name, org,
 *  timezone, uuid, live state and spend. Measured against the running
 *  server: HTTP 200, 9,139 bytes, no "Sign out" and no `admin-who` in
 *  the payload, which is the proof the layout was skipped.
 *
 *  So the gate is the first statement, exactly as getAdminCall's is, and
 *  the layout's notFound() goes back to being what it is good at: the
 *  cosmetic 404 for a person who typed the URL.
 *
 *  Empty, not a throw. Every real caller here is operator staff, so the
 *  only reader of this branch is a request that had no business asking;
 *  the page already draws "No restaurants yet" for an empty list, which
 *  tells that request nothing at all. A throw would answer it with a
 *  stack trace and a 500 that confirms the route exists.
 *
 *  Two window queries rather than one per location: the set is small,
 *  and a 48-hour window comfortably covers "today" in any timezone. */
export async function getPortfolio(): Promise<PortfolioRow[]> {
  const admin = await currentPlatformAdmin();
  if (!admin) return [];

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
      health: locationHealth(location),
    };
  });
}

/** One restaurant's record and its recent history, for operator staff.
 *
 *  The gate and the id test are the first two statements for the same
 *  reason they are in getPortfolio and getAdminCall: this reads with the
 *  service role, and app/admin/layout.tsx's check protects a ROUTE, not
 *  a function -- a request whose Next-Router-State-Tree says it already
 *  holds the layout segment gets the page without it.
 *
 *  Nothing here used to be disclosed, and only by an accident of
 *  composition: app/admin/[locationId]/page.tsx awaits this in a
 *  Promise.all beside getGoLiveState, which has its own
 *  currentPlatformAdmin() check, so the page 404'd on that null before
 *  rendering. All four queries below had already run by then -- the
 *  location row, twenty calls with their callers' phone numbers, ten
 *  orders and the sold-out list. Delete the go-live panel, reorder the
 *  reads, or render anything before that null check, and they ship.
 *
 *  `locationId` is RFC-tested here rather than only in the page for the
 *  reason this module states about itself above: it holds the
 *  service-role key and does not get to trust its caller to have
 *  remembered.
 *
 *  Null for "not staff", "not a uuid" and "no such restaurant" alike --
 *  one refusal for all three, which the page turns into notFound(). */
export async function getAdminLocation(locationId: string) {
  const admin = await currentPlatformAdmin();
  if (!admin) return null;
  if (!UUID.test(locationId)) return null;

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

/* ── one call, for the operator ────────────────────────────────────── */

/** How long the operator's playback link is good for.
 *
 *  300 seconds, the same number lib/data.ts signs the owner's link with.
 *  Two callers, one lifetime: a link that outlived the other one would
 *  make the console the easiest place to lift a recording from. */
const RECORDING_URL_SECONDS = 300;

/** The columns a call detail screen wants and a call LIST does not.
 *
 *  All six are on `calls` already (supabase/migrations/
 *  20260807000100_schema.sql); `CallRow` is the shape every screen
 *  shares, and lib/data.ts's getCall widens it in exactly this way for
 *  the owner's copy of this screen. */
export type AdminCallRow = CallRow & {
  provider_call_id: string | null;
  dialed_number: string | null;
  recording_path: string | null;
  transcript: { lines?: TranscriptLine[] } | null;
  transcript_status: "pending" | "ready" | "failed" | "skipped" | null;
  notes: string | null;
};

export type AdminCall = {
  location: LocationRow & { organizations: { name: string } | null };
  call: AdminCallRow;
  /** Signed, private, and minted per render. Null when there is no
   *  recording, or when signing failed -- the screen says which. */
  recordingUrl: string | null;
};

/** One call at one restaurant, read for operator staff.
 *
 *  AUTHORIZATION. The gate is the first statement, before an argument is
 *  looked at, and it is here rather than only in the page: this function
 *  reads with the service role, which bypasses RLS on `calls` for every
 *  tenant on the platform, and app/admin/layout.tsx's check protects a
 *  ROUTE, not a function. Anything that ever imports this -- a future
 *  action, a route handler -- gets the check for free.
 *
 *  SCOPING. `location_id` is part of the WHERE clause, not checked after
 *  the fact, so a callId belonging to another restaurant comes back as
 *  no row and the page 404s. Both ids are RFC-validated above before
 *  either reaches Postgres.
 *
 *  Returns null for "not staff", "not a uuid", "no such restaurant" and
 *  "not this restaurant's call" alike -- the same refusal for all four,
 *  which is lib/admin/edit.ts's posture copied. */
export async function getAdminCall(
  locationId: string,
  callId: string,
): Promise<AdminCall | null> {
  const admin = await currentPlatformAdmin();
  if (!admin) return null;
  if (!UUID.test(locationId) || !UUID.test(callId)) return null;

  const supabase = supabaseAdmin();

  const [location, call] = await Promise.all([
    supabase
      .from("locations")
      .select("*, organizations(name)")
      .eq("id", locationId)
      .maybeSingle(),
    supabase
      .from("calls")
      .select("*")
      .eq("id", callId)
      .eq("location_id", locationId)
      .maybeSingle(),
  ]);

  // A read that FAILED is not a read that found nothing, and answering
  // an outage with 404 would send an operator hunting for a call that is
  // sitting right there. The boundary at app/admin/error.tsx offers a
  // retry, which is the right offer. The PostgrestError itself never
  // reaches the log or the response -- location id and SQLSTATE only.
  if (location.error) {
    console.error("[admin] could not read the restaurant", {
      location_id: locationId,
      code: location.error.code,
    });
    throw new Error("admin location read failed");
  }
  if (call.error) {
    console.error("[admin] could not read the call", {
      location_id: locationId,
      code: call.error.code,
    });
    throw new Error("admin call read failed");
  }

  if (!location.data || !call.data) return null;

  const row = call.data as AdminCallRow;

  return {
    location: location.data as LocationRow & {
      organizations: { name: string } | null;
    },
    call: row,
    recordingUrl: await signRecording(supabase, locationId, row.recording_path),
  };
}

/** A short-lived link to the audio, signed for operator staff.
 *
 *  This is the one thing on the operator's call screen that could NOT
 *  reuse lib/data.ts's getRecordingUrl, and the reason is the bucket's
 *  own policy rather than a preference. "staff read own recordings"
 *  scopes `call-recordings` to app.can_access_location(...) -- membership
 *  in the owning organization -- and operator staff are members of no
 *  customer organization on purpose. getRecordingUrl signs with the
 *  user's own session, so for an operator it returns null every time and
 *  the screen would say "no recording" about audio that is plainly
 *  there. supabase/migrations/20260813130000_menu_uploads.sql writes the
 *  same division down for menu uploads: the operator's path is the
 *  service role behind an explicit platform-admin check.
 *
 *  So the bucket stays private, nothing about it changes, and this is the
 *  same bucket, the same 300 seconds and the same private-only posture
 *  reached through the key this module already holds.
 *
 *  The path is not trusted blindly even though it came from the row we
 *  just scoped: the service role bypasses storage RLS too, so the tenant
 *  boundary that the owner's path got from a policy has to be asserted
 *  here in the open. Both writers store `<location_id>/<call_id>.<ext>`
 *  (app/api/vapi/webhook/route.ts, app/api/twilio/recording/route.ts). */
async function signRecording(
  supabase: ReturnType<typeof supabaseAdmin>,
  locationId: string,
  path: string | null,
): Promise<string | null> {
  if (!path) return null;
  if (!path.startsWith(`${locationId}/`)) {
    console.error("[admin] recording path is outside its location", {
      location_id: locationId,
    });
    return null;
  }

  const { data, error } = await supabase.storage
    .from("call-recordings")
    .createSignedUrl(path, RECORDING_URL_SECONDS);

  // Never the error object: a storage error echoes the object name, and
  // the name is the recording. Losing the link must not lose the call.
  if (error) {
    console.error("[admin] could not sign a recording url", {
      location_id: locationId,
    });
    return null;
  }
  return data.signedUrl;
}
