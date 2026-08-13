import type { MenuImportSourceType } from "@/lib/supabase/types";

/** What a menu upload is allowed to be, in one place.
 *
 *  These four constants are the same numbers three layers apart, and they
 *  have to agree: the bucket's own `allowed_mime_types` and
 *  `file_size_limit` (supabase/migrations/20260813130000_menu_uploads.sql),
 *  the server action that issues an upload ticket, and the file picker.
 *  Only the first of those is unbypassable, which is exactly why the
 *  other two read their limits from here rather than restating them. */

export const MENU_UPLOAD_BUCKET = "menu-uploads";

/** 10 MiB. Matches the bucket's file_size_limit. A phone photo of a menu
 *  is 2-6 MB; anything past this is not a menu. */
export const MAX_MENU_FILE_BYTES = 10 * 1024 * 1024;

/** One menu is often three photos, occasionally both sides of a folded
 *  card plus the specials board. Ten is generous and still bounds what a
 *  single extraction run has to read. */
export const MAX_MENU_FILES = 10;

/** 16 MiB across one menu, which the per-file limit above does not imply:
 *  ten files at ten megabytes each is a hundred, and the whole batch goes
 *  to the model in a single request whose body is base64 (four bytes on
 *  the wire for every three stored) and capped at 32 MB. Refusing here,
 *  by name, beats a 413 from an API the owner has never heard of. */
export const MAX_MENU_BATCH_BYTES = 16 * 1024 * 1024;

type UploadKind = { extension: string; sourceType: MenuImportSourceType };

/** Deliberately no HEIC. iPhones can produce it, but nothing downstream
 *  reads it, so accepting one would mean storing a file that fails at
 *  extraction time -- after the owner has walked away believing the menu
 *  is in. Rejecting it at the picker, by name, is the kinder failure. */
export const MENU_UPLOAD_TYPES: Record<string, UploadKind> = {
  "image/jpeg": { extension: "jpg", sourceType: "image" },
  "image/png": { extension: "png", sourceType: "image" },
  "image/webp": { extension: "webp", sourceType: "image" },
  "application/pdf": { extension: "pdf", sourceType: "pdf" },
};

/** The `accept` attribute, built from the same map the server enforces,
 *  so the picker can never offer something the upload will refuse. */
export const MENU_UPLOAD_ACCEPT = Object.keys(MENU_UPLOAD_TYPES).join(",");

export const ACCEPTED_TYPES_SENTENCE =
  "JPEG, PNG, WebP or PDF, up to 10 MB each";

/** Content types arrive as `image/jpeg` or `image/jpeg; charset=binary`,
 *  and browsers are inconsistent about case. */
export function normalizeContentType(contentType: string | null | undefined) {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

export function menuUploadKind(contentType: string | null | undefined): UploadKind | null {
  return MENU_UPLOAD_TYPES[normalizeContentType(contentType)] ?? null;
}

export type UploadCheck = { ok: true; kind: UploadKind } | { ok: false; error: string };

/** The one place that decides whether a file may be stored at all. Run in
 *  the browser so the owner hears about it before the upload, and run
 *  again on the server -- against the object Storage actually kept, not
 *  against what the browser claimed -- before any row is written. */
export function checkMenuUpload({
  fileName,
  contentType,
  size,
}: {
  fileName?: string;
  contentType: string | null | undefined;
  size: number;
}): UploadCheck {
  const kind = menuUploadKind(contentType);
  if (!kind) {
    const heic = /\.hei[cf]$/i.test(fileName ?? "") || /^image\/hei[cf]$/.test(normalizeContentType(contentType));
    if (heic) {
      return {
        ok: false,
        error:
          "That is an iPhone HEIC photo, which cannot be read. In Settings > Camera > Formats " +
          "choose Most Compatible, or share the photo as a JPEG, and upload it again.",
      };
    }
    return { ok: false, error: `That file is not ${ACCEPTED_TYPES_SENTENCE}.` };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: "That file is empty." };
  }
  if (size > MAX_MENU_FILE_BYTES) {
    return {
      ok: false,
      error: `That file is ${fileSize(size)}. The limit is ${fileSize(MAX_MENU_FILE_BYTES)} per file.`,
    };
  }
  return { ok: true, kind };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** `<location_id>/<uuid>.<ext>`.
 *
 *  The first segment is the tenant boundary the storage policies read, so
 *  it is a validated uuid or nothing. The rest is generated, never the
 *  name the file arrived with: a caller-supplied name is how a path
 *  escapes its folder, and two photos called IMG_0001.jpg would otherwise
 *  collide. */
export function menuUploadPath(locationId: string, objectId: string, contentType: string): string {
  if (!isUuid(locationId)) throw new Error("menuUploadPath: location id must be a uuid");
  if (!isUuid(objectId)) throw new Error("menuUploadPath: object id must be a uuid");
  const kind = menuUploadKind(contentType);
  if (!kind) throw new Error("menuUploadPath: unsupported content type");
  return `${locationId}/${objectId}.${kind.extension}`;
}

/** The content type of a stored object, read back from the extension the
 *  server itself put on the path. What the model has to be told a file is
 *  -- `image/jpeg` and `application/pdf` are different kinds of content
 *  block -- and the path is the only description of the bytes that this
 *  app wrote rather than took from a browser. */
export function menuUploadMediaType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  for (const [contentType, kind] of Object.entries(MENU_UPLOAD_TYPES)) {
    if (kind.extension === extension) return contentType;
  }
  return null;
}

/** Does this path sit inside this location's folder? Checked on the
 *  server before anything is signed, read or deleted, so a hand-written
 *  request cannot name another restaurant's file. */
export function isPathInLocation(path: string, locationId: string): boolean {
  if (!isUuid(locationId)) return false;
  const segments = path.split("/");
  return segments.length === 2 && segments[0] === locationId && segments[1].length > 0;
}

/** What a human called the file, kept only to show back to them. Never
 *  used to build a storage path. */
export function cleanFileName(name: string): string {
  const stripped = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return stripped.slice(0, 120);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}
