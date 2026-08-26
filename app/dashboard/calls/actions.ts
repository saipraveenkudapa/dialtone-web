"use server";

import { supabaseServer } from "@/lib/supabase/server";
import { passwordIsStillTemporary } from "@/lib/auth/password-gate";

/** Staff notes on a call. Written with the user's own session, so RLS
 *  decides whether this call is theirs to annotate. */
export async function saveCallNotes(callId: string, notes: string) {
  // The middleware will not let this page load while the account is still
  // using the password its operator generated -- but this export is an
  // HTTP endpoint of its own, reachable by anyone holding its action id
  // without ever loading that page. That is precisely the hole /signup
  // left open, so the refusal lives in the thing that does the writing.
  if (await passwordIsStillTemporary()) {
    return { error: "Set your own password before changing anything here." };
  }

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
