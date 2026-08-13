"use client";

import { useCallback, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  ACCEPTED_TYPES_SENTENCE,
  MAX_MENU_FILES,
  MENU_UPLOAD_ACCEPT,
  checkMenuUpload,
  fileSize,
} from "@/lib/menu-imports/file";
import { uploadMenuFile } from "@/lib/menu-imports/upload";
import { extractionHasItems, extractionSummary } from "@/lib/menu-imports/extraction";
import {
  discardMenuImport,
  menuImportViewUrl,
  readMenuImports,
} from "@/app/menu-imports/actions";
import { dateTimeIn } from "@/lib/format";
import type { MenuImportRow } from "@/lib/supabase/types";

/** Upload a photo or PDF of a menu.
 *
 *  One component, two callers. The owner opens /dashboard/menu, where the
 *  restaurant already exists, and each file goes to storage as it is
 *  picked. The operator is on /admin/new, where it does not exist yet --
 *  there is no location id, and the first segment of every storage path
 *  is a location id, so there is nowhere to put the bytes. In that case
 *  the files wait in the browser and the form uploads them the moment
 *  Start returns an id, through the same `uploadMenuFile` this uses.
 *
 *  Nothing here reads a menu. A stored file is a pending row and a
 *  promise that a human will see what was read out of it before any
 *  price of theirs changes. */

type Entry =
  | { key: string; state: "staged"; file: File }
  | { key: string; state: "uploading"; name: string; size: number }
  | { key: string; state: "stored"; row: MenuImportRow }
  | { key: string; state: "rejected"; name: string; message: string };

export function MenuUpload({
  locationId,
  timezone,
  initialImports = [],
  onStagedFilesChange,
  disabled = false,
}: {
  /** null on the operator's create form: no restaurant yet, so files are
   *  held rather than sent. */
  locationId: string | null;
  timezone: string;
  initialImports?: MenuImportRow[];
  /** Must be stable across renders -- the form owns the staged files and
   *  this fires on every change to them. */
  onStagedFilesChange?: (files: File[]) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  // Everything uploaded in this sitting is one menu. The batch is what
  // extraction and review will work on; the rows are per file, so a
  // blurry third photo can be removed without touching the other two.
  const batchId = useRef<string>(crypto.randomUUID());

  const [entries, setEntries] = useState<Entry[]>(() =>
    initialImports.map((row) => ({ key: row.id, state: "stored" as const, row })),
  );
  const [links, setLinks] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const counted = entries.filter((e) => e.state !== "rejected").length;

  // Files uploaded together are read together -- a section that runs off
  // the bottom of one photo and onto the top of the next is one section,
  // and only a single read of the whole batch can see that. This list is
  // usually one id long: everything picked in this sitting. It can be
  // longer when the screen also shows a batch from an earlier visit that
  // was never read.
  const unread = [
    ...new Set(
      entries.flatMap((e) =>
        e.state === "stored" && e.row.status === "pending" ? [e.row.batch_id] : [],
      ),
    ),
  ];

  const publish = useCallback(
    (next: Entry[]) => {
      setEntries(next);
      onStagedFilesChange?.(
        next.flatMap((e) => (e.state === "staged" ? [e.file] : [])),
      );
    },
    [onStagedFilesChange],
  );

  async function send(key: string, file: File, id: string) {
    const result = await uploadMenuFile({ locationId: id, batchId: batchId.current, file });
    setEntries((prev) =>
      prev.map((e) =>
        e.key === key
          ? "menuImport" in result
            ? { key, state: "stored", row: result.menuImport }
            : { key, state: "rejected", name: file.name, message: result.error }
          : e,
      ),
    );
  }

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setNotice(null);

    const incoming = Array.from(list);
    let room = MAX_MENU_FILES - counted;
    const added: Entry[] = [];

    for (const file of incoming) {
      const key = crypto.randomUUID();
      const check = checkMenuUpload({
        fileName: file.name,
        contentType: file.type,
        size: file.size,
      });

      // The picker's `accept` and the bucket's own limits say the same
      // thing; this says it in words, before the upload, next to the file
      // it is about.
      if (!check.ok) {
        added.push({ key, state: "rejected", name: file.name, message: check.error });
        continue;
      }
      if (room <= 0) {
        setNotice(`One menu is at most ${MAX_MENU_FILES} files. The rest were not added.`);
        break;
      }
      room -= 1;

      if (locationId) {
        added.push({ key, state: "uploading", name: file.name, size: file.size });
        void send(key, file, locationId);
      } else {
        added.push({ key, state: "staged", file });
      }
    }

    publish([...added, ...entries]);
    // Let the same file be picked again after it was removed.
    if (inputRef.current) inputRef.current.value = "";
  }

  async function remove(entry: Entry) {
    if (entry.state === "uploading") return;

    if (entry.state === "stored" && locationId) {
      const result = await discardMenuImport({ locationId, importId: entry.row.id });
      if (result.error) {
        setEntries((prev) =>
          prev.map((e) =>
            e.key === entry.key
              ? { key: e.key, state: "rejected", name: nameOf(entry), message: result.error! }
              : e,
          ),
        );
        return;
      }
    }
    publish(entries.filter((e) => e.key !== entry.key));
  }

  /** Hand every unread batch on this screen to the reader, one call each.
   *
   *  Nothing a caller hears moves here. A finished read leaves the files
   *  where they are and the rows at 'needs_review', which is a promise
   *  that a person will see every price before the assistant quotes one.
   *  A read that fails leaves the rows pending, so the same photographs
   *  can be read again without uploading them twice. */
  async function read() {
    if (!locationId || unread.length === 0) return;
    setReading(true);
    setNotice(null);

    for (const batch of unread) {
      const result = await readMenuImports({ locationId, batchId: batch });
      if (result.error) {
        setNotice(result.error);
        continue;
      }
      const byId = new Map((result.menuImports ?? []).map((row) => [row.id, row]));
      setEntries((prev) =>
        prev.map((e) =>
          e.state === "stored" && byId.has(e.row.id)
            ? { ...e, row: byId.get(e.row.id)! }
            : e,
        ),
      );
    }

    setReading(false);
  }

  async function reveal(row: MenuImportRow) {
    if (!locationId) return;
    const result = await menuImportViewUrl({ locationId, importId: row.id });
    if (result.url) {
      setLinks((prev) => ({ ...prev, [row.id]: result.url! }));
      return;
    }
    setNotice(result.error ?? "Could not open that file.");
  }

  return (
    <section className="card blueprint setup-card menu-upload">
      <h2>Import from a photo or a PDF</h2>
      <p className="text-muted sub">
        Take a photo of each page, or upload the PDF. {ACCEPTED_TYPES_SENTENCE}, up to{" "}
        {MAX_MENU_FILES} files for one menu.
      </p>
      <p className="text-muted setup-note">
        Uploading changes nothing a caller hears. Each file is stored privately and waits for
        someone to read what was found in it and confirm every price before it reaches the menu
        the assistant quotes.
      </p>

      <div className="field upload-picker">
        <label htmlFor={inputId}>Menu files</label>
        <input
          id={inputId}
          ref={inputRef}
          className="input"
          type="file"
          multiple
          accept={MENU_UPLOAD_ACCEPT}
          disabled={disabled || counted >= MAX_MENU_FILES}
          onChange={(e) => addFiles(e.target.files)}
        />
      </div>

      {notice ? <p className="setup-error">{notice}</p> : null}

      {locationId && unread.length > 0 ? (
        <div className="upload-read">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={disabled || reading}
            onClick={() => void read()}
          >
            {reading ? "Reading…" : "Read these files"}
          </button>
          <span className="text-muted setup-note">
            Claude reads the prices, descriptions and any ingredients the menu prints, and
            leaves them here for you to check. Nothing reaches the assistant until you
            confirm it.
          </span>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className="text-muted empty-note">Nothing uploaded yet.</p>
      ) : (
        <ul className="upload-list">
          {entries.map((entry) => (
            <li key={entry.key} className="upload-row">
              <div className="upload-name">
                <span className="name">{nameOf(entry)}</span>
                <span className="text-muted upload-meta">{metaOf(entry, timezone)}</span>
                {entry.state === "rejected" ? (
                  <span className="setup-error upload-why">{entry.message}</span>
                ) : null}
                {entry.state === "stored" && links[entry.row.id] ? (
                  <a
                    className="upload-link"
                    href={links[entry.row.id]}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open {nameOf(entry)} — this link expires in five minutes
                  </a>
                ) : null}
              </div>

              <span className={statusTag(entry)}>{statusLabel(entry)}</span>

              <div className="upload-actions">
                {/* The one thing left to do with a file that has been
                    read. It points at the batch, not this row: the whole
                    menu was read in one call and is confirmed in one
                    transaction, so reviewing one photo of three is not a
                    thing anybody can do. */}
                {entry.state === "stored" &&
                locationId &&
                entry.row.status === "needs_review" &&
                extractionHasItems(entry.row.raw_extraction) ? (
                  <Link
                    href={`/dashboard/menu/imports/${entry.row.batch_id}`}
                    className="btn btn-primary"
                  >
                    Check what was read
                  </Link>
                ) : null}
                {entry.state === "stored" && locationId && !links[entry.row.id] ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void reveal(entry.row)}
                  >
                    View
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={disabled || entry.state === "uploading"}
                  onClick={() => void remove(entry)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function nameOf(entry: Entry): string {
  if (entry.state === "staged") return entry.file.name;
  if (entry.state === "stored") return entry.row.original_filename ?? "Menu file";
  return entry.name;
}

function metaOf(entry: Entry, timezone: string): string {
  if (entry.state === "staged") return fileSize(entry.file.size);
  if (entry.state === "uploading") return fileSize(entry.size);
  if (entry.state === "rejected") return "Not stored";
  const size = entry.row.byte_size ? `${fileSize(entry.row.byte_size)} · ` : "";
  const when = dateTimeIn(timezone, entry.row.created_at);
  // What was read, once something has been: "4 to check" is the only part
  // of this line anybody acts on, so it goes last, where the eye lands.
  const read = extractionSummary(entry.row.raw_extraction);
  return `${size}${when}${read ? ` · ${read}` : ""}`;
}

function statusLabel(entry: Entry): string {
  switch (entry.state) {
    case "staged":
      return "Uploads on Start";
    case "uploading":
      return "Uploading…";
    case "rejected":
      return "Not stored";
    default:
      return STORED_LABEL[entry.row.status];
  }
}

/** A stored file's status is the menu_imports status, said plainly. Only
 *  'pending' can happen today -- the rest arrive with extraction and
 *  review, and naming them here keeps this list honest when they do. */
const STORED_LABEL: Record<MenuImportRow["status"], string> = {
  pending: "Waiting to be read",
  needs_review: "Needs review",
  confirmed: "Confirmed",
  discarded: "Discarded",
};

function statusTag(entry: Entry): string {
  switch (entry.state) {
    case "staged":
      return "tag tag-outline";
    case "uploading":
      return "tag tag-neutral";
    case "rejected":
      return "tag tag-out";
    default:
      return "tag tag-accent-2";
  }
}
