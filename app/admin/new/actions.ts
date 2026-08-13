"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { currentPlatformAdmin } from "@/lib/admin/auth";
import { createRestaurant } from "@/lib/provisioning/create-restaurant";
import type { RestaurantDraft } from "@/lib/provisioning/draft";
import type { CreatedRestaurant } from "@/lib/provisioning/create-restaurant";

export type CreateRestaurantState = {
  error?: string;
  restaurant?: CreatedRestaurant;
};

/** "Start": the operator's one action that makes a restaurant real.
 *
 *  The authorization check is the first thing this does, and it is the
 *  real one -- not the fact that /admin/new is only linked from a page
 *  behind AdminLayout. A "use server" export is a live HTTP endpoint the
 *  moment it exists: anyone who can find its action id can POST to it,
 *  with whatever body they like, without ever loading the page that
 *  renders the button. So the check lives here, in the thing that does
 *  the writing.
 *
 *  It is checked twice on purpose. lib/provisioning/create-restaurant.ts
 *  re-runs currentPlatformAdmin() before it touches the service-role
 *  key, so the module that holds the tenancy-bypassing credential does
 *  not depend on its caller having remembered. Two cheap round trips
 *  against a wrong answer that would hand a stranger an organization is
 *  a trade worth making.
 *
 *  The returned password is rendered once by the client component that
 *  called this and never sent again -- see this action's own return
 *  type, and note that nothing here writes it to a log line. */
export async function createRestaurantAction(
  draft: RestaurantDraft,
): Promise<CreateRestaurantState> {
  const admin = await currentPlatformAdmin();
  if (!admin) {
    // Deliberately the same words a 404 would use. A restaurant owner
    // who fires this action learns nothing about what it is or wants.
    return { error: "Not found." };
  }

  // Server-derived from the request, not typed by a human -- the same
  // `origin` the login flow already trusts for its magic-link
  // redirect. Every Vapi tool's server.url is built from it, so a
  // caller-supplied value here would point this location's tools at
  // somebody else's server.
  const origin = (await headers()).get("origin") ?? "";
  const base = origin.replace(/\/+$/, "");

  const result = await createRestaurant(draft, { base });

  if (!result.ok) return { error: result.error };

  // The portfolio table on /admin is a Server Component read; without
  // this the operator lands back on a cached list that does not have the
  // restaurant they just made. Deliberately not revalidating the route
  // this action was called from: /admin/new's own render must not be
  // able to replace the screen showing the one-time password.
  revalidatePath("/admin");

  return { restaurant: result.restaurant };
}
