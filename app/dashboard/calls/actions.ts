"use server";

import { supabaseServer } from "@/lib/supabase/server";

/** Staff notes on a call. Written with the user's own session, so RLS
 *  decides whether this call is theirs to annotate. */
export async function saveCallNotes(callId: string, notes: string) {
  const supabase = await supabaseServer();

  const { error } = await supabase
    .from("calls")
    .update({ notes: notes.slice(0, 2000) })
    .eq("id", callId);

  if (error) {
    console.error("[calls] could not save notes", error);
    return { error: "That did not save. Try again." };
  }

  // Deliberately no revalidatePath. Re-rendering this page mints a fresh
  // signed URL for the recording, which changes the <audio> src and
  // reloads the media -- so saving a note while listening would throw
  // away your position in the call. The client already holds the saved
  // text, and nothing else on the page depends on it.
  return { ok: true };
}
