import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentSecretFromRequest, locationForSecret } from "@/lib/agent/auth";
import { agentFail, agentOk } from "@/lib/agent/respond";
import { shapeMenu, suggestAlternative } from "@/lib/agent/menu";
import type { MenuCategoryRow, MenuItemRow } from "@/lib/supabase/types";

/** get_menu. Called live on every call that mentions food, never cached
 *  into the prompt. This endpoint is the only reason the agent cannot
 *  invent an item or a price. */
export async function POST(request: Request) {
  const location = await locationForSecret(agentSecretFromRequest(request));
  if (!location) return agentFail("Not authorised", 401);

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
    console.error("[agent] menu read failed", categories.error ?? items.error);
    return agentFail("I can't pull the menu up right now.", 500);
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

  const body = (await request.json().catch(() => ({}))) as { item?: string };
  const alternative = body.item ? suggestAlternative(menu, body.item) : null;

  return agentOk({ ...menu, alternative });
}
