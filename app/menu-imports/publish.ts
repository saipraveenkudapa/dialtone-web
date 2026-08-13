"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { isUuid } from "@/lib/menu-imports/file";
import {
  isPublishMode,
  publishArrays,
  type PublishItem,
  type PublishMode,
} from "@/lib/menu-imports/review";

/** Putting a reviewed menu live.
 *
 *  This file is deliberately its own file, and deliberately does not
 *  import lib/supabase/admin. Every other menu-import action shares a
 *  `reach()` that falls back to the service role for operator staff
 *  (app/menu-imports/actions.ts) -- correct for uploading a photograph on
 *  behalf of a restaurant that was created ninety seconds ago, and wrong
 *  for this. A price goes live because somebody whose money it is signed
 *  for it, so this path runs on the user's own session and nothing else:
 *  RLS decides what they can see, and publish_menu_import re-asks the
 *  same question with app.can_access_location before it writes. The
 *  service role is not merely unused here -- Postgres refuses it EXECUTE
 *  on that function (20260813170000_publish_menu_import.sql).
 *
 *  This is a live HTTP endpoint the moment it exists, so the list it is
 *  handed is checked here rather than trusted: `publishArrays` refuses an
 *  unconfirmed line whatever the button on the screen was doing. */

const REFUSED = "Not found.";

export type PublishOutcome = {
  mode: PublishMode;
  itemsCreated: number;
  categoriesCreated: number;
  itemsRemoved: number;
  categoriesRemoved: number;
};

/** What the database says when it will not publish, said to a person.
 *  Everything below `nothing_to_publish` should have been caught by
 *  `publishArrays` before the call; they are named anyway, because a
 *  refusal nobody wrote a sentence for is a spinner that never stops. */
const REASONS: Record<string, string> = {
  not_found: REFUSED,
  invalid_mode: "Choose whether to add to the menu or replace it.",
  no_items: "There is nothing to publish.",
  too_many: "That is more than one menu can hold. Publish it in parts.",
  mismatched_items: "That list did not arrive intact. Reload the page and try again.",
  bad_category: "One of the sections has no name.",
  bad_item: "One of the items has no name.",
  bad_description: "One of the descriptions is too long.",
  bad_price: "One of the prices is not an amount that can be quoted.",
  bad_category_index: "That list did not arrive intact. Reload the page and try again.",
  nothing_to_publish:
    "This import is not waiting for review any more — somebody has already published or " +
    "discarded it. Reload the page to see where the menu stands.",
};

export async function publishMenuImport(input: {
  locationId: string;
  batchId: string;
  mode: PublishMode;
  items: PublishItem[];
}): Promise<{ published?: PublishOutcome; error?: string }> {
  if (!isUuid(input.locationId) || !isUuid(input.batchId)) return { error: REFUSED };
  if (!isPublishMode(input.mode)) {
    return { error: "Choose whether to add to the menu or replace it." };
  }
  if (!Array.isArray(input.items)) return { error: REFUSED };

  // The gate, on the server. Also the one place dollars become cents.
  const checked = publishArrays(input.items);
  if (!checked.ok) return { error: checked.error };

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: REFUSED };

  const { data, error } = await supabase.rpc("publish_menu_import", {
    p_location_id: input.locationId,
    p_batch_id: input.batchId,
    p_mode: input.mode,
    p_category_names: checked.arrays.categoryNames,
    p_item_category: checked.arrays.itemCategory,
    p_item_names: checked.arrays.itemNames,
    p_item_prices_cents: checked.arrays.itemPricesCents,
    p_item_descriptions: checked.arrays.itemDescriptions,
  });

  if (error) {
    console.error("[menu-imports] could not publish", error);
    return { error: "The menu could not be published just now. Try again." };
  }

  // The function `returns table`, so PostgREST hands back an array of one.
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        published: boolean;
        reason: string | null;
        categories_created: number;
        items_created: number;
        categories_removed: number;
        items_removed: number;
      }
    | undefined;

  if (!row) return { error: "The menu could not be published just now. Try again." };

  if (!row.published) {
    return { error: REASONS[row.reason ?? ""] ?? "That menu could not be published." };
  }

  // Every screen that quotes the menu, and the count on the menu page.
  //
  // Worth knowing what this does to the screen that called it: any
  // revalidate inside a server action also refreshes the route the
  // action was called from, so the review page re-renders as the server
  // sees it now -- confirmed -- and replaces the review in place. That
  // is why the confirmed branch of app/dashboard/menu/imports/[batchId]
  // is written as the moment after publishing rather than as a shrug at
  // somebody who arrived late. The client's own panel is the fallback
  // for a refresh that does not land.
  revalidatePath("/dashboard/menu");
  revalidatePath("/dashboard/menu/live");
  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/menu/imports/${input.batchId}`);

  return {
    published: {
      mode: input.mode,
      itemsCreated: row.items_created,
      categoriesCreated: row.categories_created,
      itemsRemoved: row.items_removed,
      categoriesRemoved: row.categories_removed,
    },
  };
}
