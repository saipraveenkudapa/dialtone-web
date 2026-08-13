"use server";

/* Every write below runs with the signed-in user's own session
 * (supabaseServer(), never supabaseAdmin()) -- RLS is what decides
 * whether a location, an hours row, a category or an item belongs to an
 * organization this account is a member of, exactly the way
 * app/dashboard/messages/actions.ts already relies on: an id that
 * belongs to someone else's restaurant matches no row and changes
 * nothing, with no extra ownership check needed here to make that true.
 * The one exception is finishOnboarding's call to Vapi, which by its
 * nature needs a server-only secret (VAPI_PRIVATE_KEY) no amount of RLS
 * can stand in for -- see that function's own comment. */

import crypto from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { getOnboardingHours, getOnboardingLocation, getOwnOrgId } from "@/lib/onboarding/data";
import { WEEKDAYS } from "@/lib/onboarding/constants";
import { parseDollarsToCents, parsePercentToBasisPoints, formatBasisPointsAsPercent } from "@/lib/money";
import { normalizePhoneToE164 } from "@/lib/phone";
import { hashAgentSecret } from "@/lib/agent/auth";
import { buildGreeting, buildSystemPrompt } from "@/lib/agent/prompt";
import { openState } from "@/lib/agent/hours";
import { buildAssistantPayload, upsertAssistant, ProvisioningError } from "@/lib/vapi/provision";
import type { LocationRow, MenuCategoryRow, MenuItemRow } from "@/lib/supabase/types";

// Ranks below business < hours < money < menu, used to make every step's
// "advance the resume marker" a one-way ratchet: going back to fix an
// earlier step (the address had a typo, the tax rate was wrong) must
// never rewind where a page reload lands.
const STEP_RANK: Record<LocationRow["onboarding_step"], number> = {
  business: 0,
  hours: 1,
  money: 2,
  menu: 3,
};

function advance(
  current: LocationRow["onboarding_step"],
  next: LocationRow["onboarding_step"],
): LocationRow["onboarding_step"] {
  return STEP_RANK[next] > STEP_RANK[current] ? next : current;
}

// ── business ─────────────────────────────────────────────────────────

export type BusinessState = { error?: string; location?: LocationRow };

export async function saveBusinessStep(
  _prev: BusinessState,
  formData: FormData,
): Promise<BusinessState> {
  const name = String(formData.get("name") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "").trim();
  const businessPhone = String(formData.get("businessPhone") ?? "").trim();
  const fallbackNumberRaw = String(formData.get("fallbackNumber") ?? "").trim();

  if (!name) return { error: "Enter the restaurant's name." };
  if (name.length > 120) return { error: "That name is too long. Try something shorter." };
  if (!address) return { error: "Enter the restaurant's address." };
  if (!timezone) return { error: "Choose a timezone." };

  // Vapi's native transferCall destination -- what actually carries this
  // number the fallback goes to -- 400s on anything that isn't E.164
  // (proven live: "(510) 555-0199" straight through failed the finish
  // step with exactly that error). Normalizing here, once, means every
  // later step that reads fallback_human_number back out (the finish
  // step, docs/vapi-setup.md's own worked example) can trust it's
  // already in the one shape Vapi accepts.
  const fallbackNumber = normalizePhoneToE164(fallbackNumberRaw);
  if (!fallbackNumber) {
    return {
      error:
        "Enter a valid fallback number, e.g. (510) 555-0100 -- this is where catering and " +
        "allergy calls get transferred, and the assistant cannot be created without one.",
    };
  }

  const supabase = await supabaseServer();
  const existing = await getOnboardingLocation();

  const fields = {
    name,
    address,
    timezone,
    business_phone: businessPhone || null,
    fallback_human_number: fallbackNumber,
  };

  if (existing) {
    const { data, error } = await supabase
      .from("locations")
      .update({ ...fields, onboarding_step: advance(existing.onboarding_step, "hours") })
      .eq("id", existing.id)
      .select("*")
      .single();

    if (error) {
      console.error("[onboarding] business step update failed", { code: error.code });
      return { error: "Could not save. Try again." };
    }
    return { location: data as LocationRow };
  }

  const orgId = await getOwnOrgId();
  if (!orgId) {
    return { error: "This account has no restaurant organization yet. Sign out and sign up again." };
  }

  const { data, error } = await supabase
    .from("locations")
    .insert({ ...fields, org_id: orgId, onboarding_step: "hours" })
    .select("*")
    .single();

  if (error) {
    console.error("[onboarding] business step insert failed", { code: error.code });
    return { error: "Could not save. Try again." };
  }

  return { location: data as LocationRow };
}

// ── hours ────────────────────────────────────────────────────────────

export type HoursState = {
  error?: string;
  location?: LocationRow;
  hours?: { day_of_week: number; open_time: string | null; close_time: string | null; is_closed: boolean }[];
};

export async function saveHoursStep(_prev: HoursState, formData: FormData): Promise<HoursState> {
  const location = await getOnboardingLocation();
  if (!location) return { error: "Finish the business step first." };

  const rows: {
    location_id: string;
    day_of_week: number;
    open_time: string | null;
    close_time: string | null;
    is_closed: boolean;
  }[] = [];

  for (let day = 0; day < 7; day++) {
    const closed = formData.get(`day-${day}-closed`) === "on";
    const open = String(formData.get(`day-${day}-open`) ?? "").trim();
    const close = String(formData.get(`day-${day}-close`) ?? "").trim();

    if (closed) {
      rows.push({ location_id: location.id, day_of_week: day, open_time: null, close_time: null, is_closed: true });
      continue;
    }

    if (!open || !close) {
      return { error: `Set both an open and a close time for ${WEEKDAYS[day]}, or mark it closed.` };
    }
    if (close <= open) {
      return {
        error:
          `${WEEKDAYS[day]}'s close time must be after its open time. Hours that cross midnight ` +
          "are not supported yet -- use the latest closing time this system can represent for now.",
      };
    }
    rows.push({ location_id: location.id, day_of_week: day, open_time: open, close_time: close, is_closed: false });
  }

  const supabase = await supabaseServer();
  const { error } = await supabase
    .from("hours")
    .upsert(rows, { onConflict: "location_id,day_of_week" });

  if (error) {
    console.error("[onboarding] hours step failed", { code: error.code });
    return { error: "Could not save hours. Try again." };
  }

  const { data: updated, error: stepError } = await supabase
    .from("locations")
    .update({ onboarding_step: advance(location.onboarding_step, "money") })
    .eq("id", location.id)
    .select("*")
    .single();

  if (stepError) {
    console.error("[onboarding] hours step advance failed", { code: stepError.code });
    return { error: "Hours saved, but could not advance. Reload and continue from Money." };
  }

  return { location: updated as LocationRow, hours: rows };
}

// ── money & service ──────────────────────────────────────────────────

export type MoneyState = {
  error?: string;
  location?: LocationRow;
  storedTaxDisplay?: string;
};

export async function saveMoneyStep(_prev: MoneyState, formData: FormData): Promise<MoneyState> {
  const location = await getOnboardingLocation();
  if (!location) return { error: "Finish the business step first." };

  const taxPercentRaw = String(formData.get("taxPercent") ?? "").trim();
  const orderTypes = String(formData.get("orderTypes") ?? "").trim();
  const pickupPromise = Number(formData.get("pickupPromiseMinutes"));
  const deliveryPromise = Number(formData.get("deliveryPromiseMinutes"));
  const seats = Number(formData.get("seats"));
  const maxPartySize = Number(formData.get("maxPartySize"));
  const reservationSlotMinutes = Number(formData.get("reservationSlotMinutes"));

  const taxRateBps = parsePercentToBasisPoints(taxPercentRaw);
  if (taxRateBps === null) return { error: "Enter the sales tax rate as a plain percentage, e.g. 8.75." };
  if (taxRateBps < 0 || taxRateBps > 2000) {
    return { error: "Sales tax must be between 0% and 20%." };
  }

  if (!["pickup", "delivery", "both"].includes(orderTypes)) {
    return { error: "Choose pickup, delivery, or both." };
  }
  if (!Number.isInteger(pickupPromise) || pickupPromise < 5 || pickupPromise > 180) {
    return { error: "Pickup promise time must be between 5 and 180 minutes." };
  }
  if (!Number.isInteger(deliveryPromise) || deliveryPromise < 5 || deliveryPromise > 180) {
    return { error: "Delivery promise time must be between 5 and 180 minutes." };
  }
  if (!Number.isInteger(seats) || seats <= 0) {
    return { error: "Seats must be a whole number greater than 0." };
  }
  if (!Number.isInteger(maxPartySize) || maxPartySize < 1 || maxPartySize > 40) {
    return { error: "Max party size must be between 1 and 40." };
  }
  if (!Number.isInteger(reservationSlotMinutes) || reservationSlotMinutes < 30 || reservationSlotMinutes > 240) {
    return { error: "Reservation length must be between 30 and 240 minutes." };
  }

  const supabase = await supabaseServer();
  const { data, error } = await supabase
    .from("locations")
    .update({
      tax_rate_bps: taxRateBps,
      order_types: orderTypes,
      pickup_promise_minutes: pickupPromise,
      delivery_promise_minutes: deliveryPromise,
      seats,
      max_party_size: maxPartySize,
      reservation_slot_minutes: reservationSlotMinutes,
      onboarding_step: advance(location.onboarding_step, "menu"),
    })
    .eq("id", location.id)
    .select("*")
    .single();

  if (error) {
    console.error("[onboarding] money step failed", { code: error.code });
    return { error: "Could not save. Try again." };
  }

  return { location: data as LocationRow, storedTaxDisplay: formatBasisPointsAsPercent(taxRateBps) };
}

// ── menu ─────────────────────────────────────────────────────────────

export type MenuCategoryState = { error?: string; category?: MenuCategoryRow };

// addMenuCategory/addMenuItem below are called directly as plain async
// functions from components/onboarding/MenuStep.tsx, not through
// useActionState -- the menu step keeps its own local list (seeded once
// from the server, then updated as items are added or removed) rather
// than the single-form request/response shape useActionState assumes,
// so there's no `prevState` to thread through.
export async function addMenuCategory(formData: FormData): Promise<MenuCategoryState> {
  const location = await getOnboardingLocation();
  if (!location) return { error: "Finish the business step first." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Enter a category name." };
  if (name.length > 80) return { error: "That name is too long." };

  const supabase = await supabaseServer();
  const { count } = await supabase
    .from("menu_categories")
    .select("id", { count: "exact", head: true })
    .eq("location_id", location.id);

  const { data, error } = await supabase
    .from("menu_categories")
    .insert({ location_id: location.id, name, sort_order: count ?? 0 })
    .select("*")
    .single();

  if (error) {
    console.error("[onboarding] add category failed", { code: error.code });
    return { error: "Could not add that category. Try again." };
  }

  revalidatePath("/onboarding");
  return { category: data as MenuCategoryRow };
}

export type MenuItemState = {
  error?: string;
  item?: MenuItemRow;
  /** Exactly what got written, so the caller can show it back -- "Stored
   *  as $12.99 (1299 cents)" -- rather than trust that the form's own
   *  live preview matched what the server actually parsed. */
  storedCents?: number;
};

export async function addMenuItem(formData: FormData): Promise<MenuItemState> {
  const categoryId = String(formData.get("categoryId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const priceRaw = String(formData.get("priceDollars") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!categoryId) return { error: "Choose a category first." };
  if (!name) return { error: "Enter the item's name." };
  if (name.length > 120) return { error: "That name is too long." };

  const priceCents = parseDollarsToCents(priceRaw);
  if (priceCents === null) {
    return {
      error:
        `"${priceRaw}" is not a plain dollar amount with at most two decimal places -- ` +
        'try something like "12.99".',
    };
  }

  const supabase = await supabaseServer();
  const { count } = await supabase
    .from("menu_items")
    .select("id", { count: "exact", head: true })
    .eq("category_id", categoryId);

  const { data, error } = await supabase
    .from("menu_items")
    .insert({
      category_id: categoryId,
      name,
      description: description || null,
      price_cents: priceCents,
      sort_order: count ?? 0,
    })
    .select("*")
    .single();

  if (error) {
    // Most likely cause: categoryId belongs to a location this account
    // can't reach. RLS makes that indistinguishable from "no such
    // category," which is exactly right -- see this file's own header.
    console.error("[onboarding] add item failed", { code: error.code });
    return { error: "Could not add that item. Try again." };
  }

  revalidatePath("/onboarding");
  return { item: data as MenuItemRow, storedCents: priceCents };
}

export async function deleteMenuCategory(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;

  const supabase = await supabaseServer();
  const { error } = await supabase.from("menu_categories").delete().eq("id", id);
  if (error) console.error("[onboarding] delete category failed", { code: error.code });
  revalidatePath("/onboarding");
}

export async function deleteMenuItem(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;

  const supabase = await supabaseServer();
  const { error } = await supabase.from("menu_items").delete().eq("id", id);
  if (error) console.error("[onboarding] delete item failed", { code: error.code });
  revalidatePath("/onboarding");
}

// ── finish ───────────────────────────────────────────────────────────

export type FinishState = {
  error?: string;
  /** True once this location already finished onboarding in an earlier
   *  request -- a reload of this screen after the secret was already
   *  shown, not a failure. The plaintext cannot be recovered; there is
   *  nothing to show but where to go next. */
  alreadyDone?: boolean;
  ok?: true;
  /** Shown to the owner exactly once. Never stored -- see
   *  lib/agent/auth.ts's own header for why only the hash is kept. */
  secret?: string;
  assistantId?: string;
  fallbackNumber?: string;
};

/** The one step in this flow that is not just an RLS-guarded write.
 *
 *  Two things happen here that nothing else in the app does:
 *   1. A tool secret is minted and its hash (lib/agent/auth.ts's own
 *      hashAgentSecret, so this matches what every app/api/agent/*
 *      route checks a call against byte for byte) is written to this
 *      location's own row -- still through the user's session, since
 *      updating a column on a location you already own needs nothing
 *      more than the location_write policy already grants.
 *   2. Vapi's API is called to create or update this location's
 *      assistant. That -- and only that -- is why this function needs
 *      VAPI_PRIVATE_KEY, a secret no RLS policy could ever stand in for:
 *      it authorises against Vapi's account, not this database, and
 *      must never reach the browser.
 *
 *  Ordering matters: the Vapi call happens BEFORE agent_secret_hash is
 *  written, not after. If it fails, nothing here has been persisted --
 *  no half-set secret, no orphaned hash nobody's plaintext matches --
 *  and the owner can simply press "Finish" again, which mints a fresh
 *  secret and tries the whole thing again. Writing the hash first and
 *  the assistant second would risk the opposite: a saved hash for a
 *  secret that never made it into any Vapi tool's headers, silently
 *  401-ing every call forever until someone notices. */
export async function finishOnboarding(): Promise<FinishState> {
  const location = await getOnboardingLocation();
  if (!location) return { error: "Finish the earlier steps first." };

  if (location.agent_secret_hash) {
    return { alreadyDone: true };
  }

  if (!location.fallback_human_number) {
    return { error: "Set a fallback number on the Business step before finishing." };
  }

  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    console.error("[onboarding] VAPI_PRIVATE_KEY is not configured");
    return { error: "This deployment is not configured to create AI assistants yet. Ask an operator to set VAPI_PRIVATE_KEY." };
  }

  const supabase = await supabaseServer();
  const hours = await getOnboardingHours(location.id);
  const now = new Date();
  const state = openState({ now, timezone: location.timezone, hours, holidays: [] });

  const systemPrompt = buildSystemPrompt({ location, hoursToday: state.today, now });
  const greeting = buildGreeting(location);

  // Same `origin` header app/signup/actions.ts already trusts for its
  // confirmation link -- server-derived from the request, not a value a
  // human typed, so the loopback/https refusal
  // scripts/provision-vapi.mjs applies to its own CLI argument has
  // nothing to guard against here. See lib/vapi/provision.ts's header.
  const origin = (await headers()).get("origin") ?? "";
  const base = origin.replace(/\/+$/, "");

  const secret = crypto.randomBytes(32).toString("base64url");

  const payload = buildAssistantPayload({
    locationId: location.id,
    base,
    agentSecret: secret,
    config: {
      system_prompt: systemPrompt,
      greeting,
      fallback_number: location.fallback_human_number,
    },
  });

  let assistantId: string;
  try {
    const { assistant } = await upsertAssistant({ vapiKey, locationId: location.id, payload });
    assistantId = assistant.id;
  } catch (err) {
    console.error("[onboarding] vapi provisioning failed", err instanceof Error ? err.message : err);
    return {
      error:
        err instanceof ProvisioningError
          ? `Could not create the AI assistant: ${err.message}`
          : "Could not create the AI assistant. Try again.",
    };
  }

  const hash = hashAgentSecret(secret);
  const { error } = await supabase
    .from("locations")
    .update({ agent_secret_hash: hash, vapi_assistant_id: assistantId })
    .eq("id", location.id);

  if (error) {
    // The assistant now exists on Vapi carrying a secret whose hash
    // isn't saved yet -- every one of its tool calls will 401 until this
    // write succeeds. Nothing to do but say so and let them retry:
    // pressing Finish again mints a new secret, PATCHes the same
    // assistant (idempotent on metadata.dialtone_location_id) with it,
    // and tries this write again.
    console.error("[onboarding] could not save secret hash", { code: error.code });
    return { error: "The AI assistant was created, but saving its secret failed. Press Finish again." };
  }

  // Deliberately NO revalidatePath("/onboarding") here, unlike every
  // other action in this file. Next.js re-runs a revalidated route's
  // Server Component as part of reconciling this action's own response --
  // and app/onboarding/page.tsx's very first check is `if
  // (location?.agent_secret_hash) redirect("/dashboard")`. The secret
  // hash this function just wrote makes that check true, so revalidating
  // "/onboarding" here turns into the page redirecting itself away the
  // instant it's asked to re-render -- yanking the owner to /dashboard
  // before they have seen, let alone copied, the one-time secret sitting
  // in this response. Confirmed by instrumenting history.replaceState
  // during manual testing: the stray navigation fired with no click in
  // between, immediately after this action resolved, and went away the
  // moment this line did. The client already has everything it needs
  // from this function's return value without a server round trip; the
  // page reads fresh on whatever future navigation actually takes the
  // owner to /dashboard (the "Go to dashboard" link below).
  return {
    ok: true,
    secret,
    assistantId,
    fallbackNumber: location.fallback_human_number,
  };
}
