import { supabaseBrowser } from "@/lib/supabase/client";
import { MENU_UPLOAD_BUCKET, checkMenuUpload } from "@/lib/menu-imports/file";
import {
  createMenuUploadTicket,
  recordMenuImport,
} from "@/app/menu-imports/actions";
import type { MenuImportRow } from "@/lib/supabase/types";

export type UploadOutcome =
  | { menuImport: MenuImportRow }
  | { error: string };

/** One file, from a file picker to a pending menu_imports row.
 *
 *  Three hops on purpose. The server names the path and issues a one-shot
 *  token; the browser sends the bytes straight to Storage, because a
 *  three-photo menu is larger than a serverless request body; the server
 *  then reads the stored object back and writes the row. Both surfaces
 *  that upload -- the owner's dashboard and the operator's create form --
 *  call this, so there is one upload path to get right. */
export async function uploadMenuFile({
  locationId,
  batchId,
  file,
}: {
  locationId: string;
  batchId: string;
  file: File;
}): Promise<UploadOutcome> {
  const check = checkMenuUpload({
    fileName: file.name,
    contentType: file.type,
    size: file.size,
  });
  if (!check.ok) return { error: check.error };

  const ticket = await createMenuUploadTicket({
    locationId,
    contentType: file.type,
    size: file.size,
  });
  if (!ticket.ticket) return { error: ticket.error ?? "Could not start that upload." };

  const { error } = await supabaseBrowser()
    .storage.from(MENU_UPLOAD_BUCKET)
    .uploadToSignedUrl(ticket.ticket.path, ticket.ticket.token, file, {
      contentType: file.type,
    });

  if (error) {
    // The bucket refuses an oversized or wrong-typed body whatever the
    // browser claimed, so this is also where a doctored request lands.
    return { error: "That file did not upload. Check the connection and try again." };
  }

  const recorded = await recordMenuImport({
    locationId,
    batchId,
    path: ticket.ticket.path,
    originalFilename: file.name,
  });
  if (!recorded.menuImport) {
    return { error: recorded.error ?? "That upload could not be saved." };
  }

  return { menuImport: recorded.menuImport };
}
