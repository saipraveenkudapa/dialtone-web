import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk, agentUnauthorised } from "@/lib/agent/respond";
import { parseToolCall } from "@/lib/agent/vapi";
import { shapeMenu, suggestAlternative } from "@/lib/agent/menu";
import type { MenuCategoryRow, MenuItemRow } from "@/lib/supabase/types";

/** get_menu. Called live on every call that mentions food, never cached
 *  into the prompt. This endpoint is the only reason the agent cannot
 *  invent an item or a price. */
export async function POST(request: Request) {
  // Parsed before the secret lookup, because the unauthorised branch now
  // needs the toolCallId too -- and `request.json()` may only be consumed
  // once, so this is the single read. `null` rather than `{}` is the
  // honest "no readable body"; parseToolCall branch A handles it.
  const call = parseToolCall(await request.json().catch(() => null));

  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentUnauthorised(call.toolCallId);

  const supabase = supabaseAdmin();
  const [categories, items] = await Promise.all([
    supabase
      .from("menu_categories")
      .select("*")
      .eq("location_id", location.id)
      .order("sort_order"),
    supabase
      .from("menu_items")
      .select("*")
      .eq("location_id", location.id)
      .order("sort_order"),
  ]);

  if (categories.error || items.error) {
    // Location and SQLSTATE only -- see app/api/agent/order/route.ts for
    // why a raw PostgrestError is never written down on an agent path.
    console.error("[agent] menu read failed", {
      location_id: location.id,
      code: (categories.error ?? items.error)?.code ?? null,
    });
    return agentFail("I can't pull the menu up right now.", call.toolCallId);
  }

  const byCategory = new Map<string, MenuItemRow[]>();
  for (const item of (items.data ?? []) as MenuItemRow[]) {
    const list = byCategory.get(item.category_id) ?? [];
    list.push(item);
    byCategory.set(item.category_id, list);
  }

  const menu = shapeMenu(
    ((categories.data ?? []) as MenuCategoryRow[]).map((c) => ({
      ...c,
      items: byCategory.get(c.id) ?? [],
    })),
  );

  // The model's arguments live inside the tool call, never at the top
  // level of the body -- see lib/agent/vapi.ts.
  // `suggestAlternative` already treats a non-string as no item at all,
  // which is what an absent optional argument arrives as.
  const alternative = suggestAlternative(menu, call.args.item);

  return agentOk({ ...menu, alternative }, call.toolCallId);
}
