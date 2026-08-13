"use server";

import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { currentPlatformAdmin } from "@/lib/admin/auth";
import {
  MAX_MENU_FILES,
  MENU_UPLOAD_BUCKET,
  checkMenuUpload,
  cleanFileName,
  isPathInLocation,
  isUuid,
  menuUploadPath,
} from "@/lib/menu-imports/file";
import type { MenuImportRow } from "@/lib/supabase/types";

/** Storing a photo of a menu, and nothing more.
 *
 *  These actions end with a file in a private bucket and a menu_imports
 *  row in 'pending'. No model is called here and no price is written
 *  anywhere a caller can hear it -- a wrong price read down the phone
 *  comes out of the restaurant's pocket, so extraction and confirmation
 *  are separate, later, human-gated steps against these same rows.
 *
 *  Two principals upload: the owner, from /dashboard/menu, and the
 *  operator, from /admin/new while creating the restaurant. The owner is
 *  a member of the organization, so RLS and the storage policies decide
 *  for them and this file does nothing clever. The operator is not a
 *  member of anybody's organization -- they are staff -- so their branch
 *  uses the service role behind an explicit currentPlatformAdmin()
 *  check, the same posture create-restaurant already takes. Which
 *  principal is which is decided once, in `reach()`.
 *
 *  Every export here is a live HTTP endpoint the moment it exists, so
 *  each one re-derives its own authorization from the session rather
 *  than trusting an id the caller sent. */

/** The client whose writes are allowed for this location: the user's own
 *  session (RLS decides) or, for operator staff, the service role. The
 *  two are the same shape, which is what lets every action below be
 *  written once. */
type Db = ReturnType<typeof supabaseAdmin>;

type Reach = { db: Db; userId: string };

/** Who is asking, and may they touch this location at all?
 *
 *  Membership is asked of the database, not of a claim in the request:
 *  the `locations` read below runs on the user's own session, so a row
 *  comes back only if RLS says it may. */
async function reach(locationId: string): Promise<Reach | null> {
  if (!isUuid(locationId)) return null;

  const user = await supabaseServer();
  const {
    data: { user: signedIn },
  } = await user.auth.getUser();
  if (!signedIn) return null;

  const { data: location } = await user
    .from("locations")
    .select("id")
    .eq("id", locationId)
    .maybeSingle();

  if (location) return { db: user as unknown as Db, userId: signedIn.id };

  const operator = await currentPlatformAdmin();
  if (!operator) return null;

  // The operator reaches a location they are not a member of. That is the
  // whole job on /admin/new -- they created it seconds ago -- but it
  // bypasses RLS, so it happens only after the check above said "staff".
  const admin = supabaseAdmin();
  const { data: exists } = await admin
    .from("locations")
    .select("id")
    .eq("id", locationId)
    .maybeSingle();
  if (!exists) return null;

  return { db: admin, userId: operator.userId };
}

/** The words every refusal here uses. A stranger who guesses an action id
 *  and a location uuid learns nothing about either. */
const REFUSED = "Not found.";

export type UploadTicket = { path: string; token: string };

/** Step one: the server decides the path and hands back a one-shot
 *  upload token; the browser sends the bytes straight to Storage.
 *
 *  The bytes deliberately do not pass through this app. A three-photo
 *  menu is tens of megabytes and a serverless request body is not, so
 *  proxying them would fail on exactly the upload this feature exists
 *  for. What the server keeps is what matters: it names the path, and
 *  the path's first segment -- the tenant boundary -- is a location the
 *  caller has just been proven to reach. */
export async function createMenuUploadTicket(input: {
  locationId: string;
  contentType: string;
  size: number;
}): Promise<{ ticket?: UploadTicket; error?: string }> {
  const who = await reach(input.locationId);
  if (!who) return { error: REFUSED };

  // First of the three refusals a too-big or unreadable file meets. The
  // last one is the bucket itself, which cannot be talked out of it.
  const check = checkMenuUpload({ contentType: input.contentType, size: input.size });
  if (!check.ok) return { error: check.error };

  const path = menuUploadPath(input.locationId, crypto.randomUUID(), input.contentType);

  const { data, error } = await who.db.storage
    .from(MENU_UPLOAD_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data) {
    console.error("[menu-imports] could not sign an upload", error);
    return { error: "Could not start that upload. Try again." };
  }

  return { ticket: { path: data.path, token: data.token } };
}

/** Step two: the file is in the bucket -- record it as a pending import.
 *
 *  The size and type written here are read back from Storage, not taken
 *  from the browser that just claimed them. An object that is not there,
 *  or that is bigger or of a different type than the bucket should have
 *  allowed, is deleted rather than recorded: a menu_imports row pointing
 *  at a file nobody can read is worse than no row. */
export async function recordMenuImport(input: {
  locationId: string;
  batchId: string;
  path: string;
  originalFilename: string;
}): Promise<{ menuImport?: MenuImportRow; error?: string }> {
  const who = await reach(input.locationId);
  if (!who) return { error: REFUSED };

  if (!isPathInLocation(input.path, input.locationId) || !isUuid(input.batchId)) {
    return { error: REFUSED };
  }

  const objectName = input.path.slice(input.locationId.length + 1);
  const { data: listed, error: listError } = await who.db.storage
    .from(MENU_UPLOAD_BUCKET)
    .list(input.locationId, { limit: 1, search: objectName });

  if (listError) {
    console.error("[menu-imports] could not read back the upload", listError);
    return { error: "Could not confirm that upload. Try again." };
  }

  const object = (listed ?? []).find((o) => o.name === objectName);
  if (!object) return { error: "That upload did not finish. Try again." };

  const stored = checkMenuUpload({
    fileName: input.originalFilename,
    contentType: object.metadata?.mimetype as string | undefined,
    size: Number(object.metadata?.size ?? 0),
  });
  if (!stored.ok) {
    await who.db.storage.from(MENU_UPLOAD_BUCKET).remove([input.path]);
    return { error: stored.error };
  }

  // Ten files is the ceiling on one menu, counted server-side over the
  // rows that already exist rather than over what the browser is showing.
  const { count } = await who.db
    .from("menu_imports")
    .select("id", { count: "exact", head: true })
    .eq("location_id", input.locationId)
    .eq("batch_id", input.batchId);

  if ((count ?? 0) >= MAX_MENU_FILES) {
    await who.db.storage.from(MENU_UPLOAD_BUCKET).remove([input.path]);
    return { error: `That is more than ${MAX_MENU_FILES} files for one menu.` };
  }

  const { data, error } = await who.db
    .from("menu_imports")
    .insert({
      location_id: input.locationId,
      batch_id: input.batchId,
      source_type: stored.kind.sourceType,
      source_path: input.path,
      original_filename: cleanFileName(input.originalFilename),
      byte_size: Number(object.metadata?.size ?? 0),
      uploaded_by: who.userId,
      status: "pending",
    })
    .select("*")
    .single();

  if (error || !data) {
    console.error("[menu-imports] could not record the upload", error);
    // The row is what makes the file findable. Without one the object is
    // litter in a private bucket, so take it back out.
    await who.db.storage.from(MENU_UPLOAD_BUCKET).remove([input.path]);
    return { error: "Could not save that upload. Try again." };
  }

  revalidatePath("/dashboard/menu");
  return { menuImport: data as MenuImportRow };
}

/** Remove an upload before anything has been extracted from it.
 *
 *  The file goes with the row. A 'discarded' row is for a menu somebody
 *  read and rejected; this is the blurry photo nobody has spent a model
 *  call on yet, and keeping a row whose source_path points at a deleted
 *  object would just be a lie in the table. Refuses once extraction has
 *  produced anything, which is the moment there is something to audit. */
export async function discardMenuImport(input: {
  locationId: string;
  importId: string;
}): Promise<{ error?: string }> {
  const who = await reach(input.locationId);
  if (!who) return { error: REFUSED };
  if (!isUuid(input.importId)) return { error: REFUSED };

  const { data: row } = await who.db
    .from("menu_imports")
    .select("id, location_id, source_path, status")
    .eq("id", input.importId)
    .eq("location_id", input.locationId)
    .maybeSingle();

  if (!row) return { error: REFUSED };
  if ((row as MenuImportRow).status !== "pending") {
    return { error: "That import has already been read. Review it instead." };
  }

  const path = (row as MenuImportRow).source_path;
  if (path && isPathInLocation(path, input.locationId)) {
    const { error: removeError } = await who.db.storage
      .from(MENU_UPLOAD_BUCKET)
      .remove([path]);
    // Losing the object but keeping the row would leave the owner staring
    // at a file they cannot delete. Stop here instead.
    if (removeError) {
      console.error("[menu-imports] could not remove the file", removeError);
      return { error: "Could not remove that file. Try again." };
    }
  }

  const { error } = await who.db
    .from("menu_imports")
    .delete()
    .eq("id", input.importId)
    .eq("location_id", input.locationId);

  if (error) {
    console.error("[menu-imports] could not delete the import row", error);
    return { error: "Could not remove that upload. Try again." };
  }

  revalidatePath("/dashboard/menu");
  return {};
}

/** A link to look at what was uploaded, good for five minutes.
 *
 *  The bucket is private and has no public URL, so this is the only way
 *  to see the file -- and the link stops working, which is the point. */
export async function menuImportViewUrl(input: {
  locationId: string;
  importId: string;
}): Promise<{ url?: string; error?: string }> {
  const who = await reach(input.locationId);
  if (!who) return { error: REFUSED };
  if (!isUuid(input.importId)) return { error: REFUSED };

  const { data: row } = await who.db
    .from("menu_imports")
    .select("source_path")
    .eq("id", input.importId)
    .eq("location_id", input.locationId)
    .maybeSingle();

  const path = (row as { source_path: string | null } | null)?.source_path;
  if (!path || !isPathInLocation(path, input.locationId)) return { error: REFUSED };

  const { data, error } = await who.db.storage
    .from(MENU_UPLOAD_BUCKET)
    .createSignedUrl(path, 300);

  if (error || !data) {
    console.error("[menu-imports] could not sign a view url", error);
    return { error: "Could not open that file. Try again." };
  }
  return { url: data.signedUrl };
}
