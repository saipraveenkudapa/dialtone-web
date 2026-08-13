"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { passwordIsStillTemporary } from "@/lib/auth/password-gate";

/** Mark a message dealt with, or put it back on the pile.
 *
 *  Written with the user's own session, never the service role, so RLS
 *  decides whether this message belongs to a restaurant they work at --
 *  which is the whole authorisation check, and has to be, because a
 *  server function is reachable by a direct POST and not only by the
 *  button that renders above it. An id from another restaurant matches
 *  no row and changes nothing.
 *
 *  `handled_at` moves with `handled` because the table refuses any other
 *  combination (`messages_handled_consistent`): one fact, recorded once,
 *  so "still waiting" can never disagree with "waiting since". */
export async function setMessageHandled(formData: FormData) {
  // Same reason as saveCallNotes: middleware gates the page, not the
  // endpoint. An account still carrying the password its operator read
  // off a screen writes nothing anywhere until it has its own.
  if (await passwordIsStillTemporary()) return;

  const id = String(formData.get("id") ?? "");
  const handled = formData.get("handled") === "true";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return;

  const supabase = await supabaseServer();

  const { error } = await supabase
    .from("messages")
    .update({ handled, handled_at: handled ? new Date().toISOString() : null })
    .eq("id", id);

  if (error) {
    // The SQLSTATE only. A PostgrestError's `details` carries Postgres'
    // "Failing row contains (...)", which for this table is the caller's
    // name, their number and the words they said.
    console.error("[messages] could not update handled", { code: error.code });
    return;
  }

  // Unlike the call page there is nothing here whose re-render costs
  // anything (no signed recording URL to remint), and the whole point of
  // the screen is which messages are still open -- so it has to repaint.
  revalidatePath("/dashboard/messages");
  revalidatePath("/dashboard/calls");
}
