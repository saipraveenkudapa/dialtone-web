import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MenuImportRow } from "@/lib/supabase/types";

/* One stored object, one menu_imports row.
 *
 * The upload is three hops -- sign a path, PUT the bytes, record the row
 * -- and the last hop is the one that gets repeated. A slow response and
 * a client retry, an owner double-tapping "Upload", or a POST to the
 * action id written by hand all arrive as recordMenuImport called twice
 * with one path. A second row against that path is not a duplicate you
 * can shrug at:
 *
 *   * discardMenuImport removes the object first and the row second, so
 *     discarding either of the two leaves the other pointing at a file
 *     that is not there -- the exact state recordMenuImport's own comment
 *     says it will not write.
 *   * extraction reads pending rows. Two rows is two model calls on one
 *     photo, and the bill for that lands on the restaurant.
 *
 * The guarantee is the partial unique index on source_path
 * (supabase/migrations/20260813140000_menu_import_one_row_per_file.sql);
 * only the database can hold it under a race. These tests drive the
 * action against a database double that enforces that index, so both
 * halves are covered: the ordinary retry, and the race the lookup loses. */

const LOCATION = "a10c0000-0000-0000-0000-00000000000a";
const OTHER_LOCATION = "b20c0000-0000-0000-0000-00000000000b";
const BATCH = "3f7c9a10-1111-4222-8333-444455556666";
const OWNER = "11111111-1111-1111-1111-111111111111";

type StoredObject = { mimetype: string; size: number };

/** The bits of Postgres and Storage this action can observe: rows, the
 *  unique index over source_path, the objects in the bucket, and a log of
 *  every removal -- because "did anything delete a file another row still
 *  points at?" is the question these tests exist to ask. */
class FakeBackend {
  imports: MenuImportRow[] = [];
  objects = new Map<string, StoredObject>();
  removed: string[] = [];
  /** Stands in for another request committing between our lookup and our
   *  insert. Runs once, immediately before the insert lands. */
  raceBeforeInsert: (() => void) | null = null;
  private seq = 0;

  putObject(path: string, object: StoredObject = { mimetype: "image/jpeg", size: 2_000_000 }) {
    this.objects.set(path, object);
  }

  insert(values: Record<string, unknown>) {
    const race = this.raceBeforeInsert;
    if (race) {
      this.raceBeforeInsert = null;
      race();
    }

    const path = values.source_path as string | null;
    // create unique index ... on menu_imports (source_path) where source_path is not null
    if (path !== null && this.imports.some((row) => row.source_path === path)) {
      return {
        data: null,
        error: {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "menu_imports_source_path_key"',
        },
      };
    }

    // Real ids, because the action refuses anything that is not a uuid
    // before it looks a row up.
    const row = {
      id: `99999999-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
      raw_extraction: {},
      confirmed_by: null,
      confirmed_at: null,
      created_at: "2026-08-13T00:00:00.000Z",
      original_filename: null,
      byte_size: null,
      uploaded_by: null,
      ...values,
    } as MenuImportRow;
    this.imports.push(row);
    return { data: row, error: null };
  }

  /** The invariant the whole feature rests on, asserted as one sentence:
   *  every row that names a file names a file that is there, and no two
   *  rows name the same one. */
  orphanedRows() {
    return this.imports.filter(
      (row) => row.source_path !== null && !this.objects.has(row.source_path),
    );
  }

  pathsClaimedTwice() {
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const row of this.imports) {
      if (row.source_path === null) continue;
      if (seen.has(row.source_path)) twice.add(row.source_path);
      seen.add(row.source_path);
    }
    return [...twice];
  }
}

let backend: FakeBackend;

/** A PostgREST builder, only as far as this action uses one. */
class FakeQuery implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
  private op: "select" | "insert" | "delete" = "select";
  private filters: [string, unknown][] = [];
  private values: Record<string, unknown> | null = null;
  private counting = false;

  constructor(private table: string) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }) {
    if (options?.head) this.counting = true;
    return this;
  }

  insert(values: Record<string, unknown>) {
    this.op = "insert";
    this.values = values;
    return this;
  }

  delete() {
    this.op = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  private matches(row: Record<string, unknown>) {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  private run(): { data: unknown; error: unknown; count?: number } {
    if (this.table === "locations") {
      const id = this.filters.find(([column]) => column === "id")?.[1];
      return { data: id === LOCATION ? { id } : null, error: null };
    }
    if (this.table !== "menu_imports") throw new Error(`unexpected table ${this.table}`);

    if (this.op === "insert") return backend.insert(this.values ?? {});
    if (this.op === "delete") {
      backend.imports = backend.imports.filter((row) => !this.matches(row));
      return { data: null, error: null };
    }

    const rows = backend.imports.filter((row) => this.matches(row));
    if (this.counting) return { data: null, error: null, count: rows.length };
    return { data: rows, error: null };
  }

  private first() {
    const result = this.run();
    const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
    return { ...result, data };
  }

  maybeSingle() {
    return Promise.resolve(this.first());
  }

  /** PostgREST reports the insert's own failure here -- the unique
   *  violation included -- so the error must be passed through untouched;
   *  only a query that matched nothing gets the "no rows" code. */
  single() {
    const result = this.first();
    if (result.error) return Promise.resolve(result);
    if (!result.data) return Promise.resolve({ data: null, error: { code: "PGRST116" } });
    return Promise.resolve(result);
  }

  then<R1 = { data: unknown; error: unknown; count?: number }, R2 = never>(
    resolve?: ((value: { data: unknown; error: unknown; count?: number }) => R1 | PromiseLike<R1>) | null,
    reject?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(resolve, reject);
  }
}

const fakeClient = {
  auth: { getUser: async () => ({ data: { user: { id: OWNER } }, error: null }) },
  from: (table: string) => new FakeQuery(table),
  storage: {
    from: (bucket: string) => {
      if (bucket !== "menu-uploads") throw new Error(`unexpected bucket ${bucket}`);
      return {
        list: async (prefix: string, options?: { search?: string }) => {
          const name = options?.search ?? "";
          const object = backend.objects.get(`${prefix}/${name}`);
          return {
            data: object ? [{ name, metadata: { mimetype: object.mimetype, size: object.size } }] : [],
            error: null,
          };
        },
        remove: async (paths: string[]) => {
          for (const path of paths) {
            backend.removed.push(path);
            backend.objects.delete(path);
          }
          return { data: null, error: null };
        },
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed/${path}` }, error: null }),
      };
    },
  },
};

vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => fakeClient }));

// The owner is a member of this organization, so RLS answers for them and
// the service-role client has no business being reached at all.
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    throw new Error("the service-role client must not be reached for an owner's own upload");
  },
}));
vi.mock("@/lib/admin/auth", () => ({ currentPlatformAdmin: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { recordMenuImport, discardMenuImport } = await import("@/app/menu-imports/actions");

const PHOTO = `${LOCATION}/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jpg`;
const SECOND_PHOTO = `${LOCATION}/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.jpg`;

const record = (path: string, filename = "menu.jpg") =>
  recordMenuImport({ locationId: LOCATION, batchId: BATCH, path, originalFilename: filename });

beforeEach(() => {
  backend = new FakeBackend();
  backend.putObject(PHOTO);
});

describe("recording the same upload twice", () => {
  it("writes one row, and hands the second caller the row the first one wrote", async () => {
    const first = await record(PHOTO);
    const second = await record(PHOTO);

    expect(first.menuImport?.id).toBeTruthy();
    expect(second.menuImport?.id).toBe(first.menuImport?.id);
    expect(second.error).toBeUndefined();
    expect(backend.imports).toHaveLength(1);
    expect(backend.pathsClaimedTwice()).toEqual([]);
  });

  it("leaves the file where it is -- the first row still points at it", async () => {
    await record(PHOTO);
    await record(PHOTO);

    expect(backend.removed).toEqual([]);
    expect(backend.objects.has(PHOTO)).toBe(true);
    expect(backend.orphanedRows()).toEqual([]);
  });

  it("does not queue the same photo for extraction twice", async () => {
    await record(PHOTO);
    await record(PHOTO);
    await record(PHOTO);

    const pending = backend.imports.filter((row) => row.status === "pending");
    expect(pending).toHaveLength(1);
    // And the one row still names a file that is there: a refusal that
    // took the object away would be worse than the duplicate.
    expect(backend.orphanedRows()).toEqual([]);
  });

  it("discarding afterwards removes the file and every row that named it", async () => {
    const first = await record(PHOTO);
    await record(PHOTO);

    // Nothing has been discarded yet: one row, and the file it names is
    // still in the bucket.
    expect(backend.imports).toHaveLength(1);
    expect(backend.objects.has(PHOTO)).toBe(true);

    const discarded = await discardMenuImport({
      locationId: LOCATION,
      importId: first.menuImport!.id,
    });

    expect(discarded.error).toBeUndefined();
    expect(backend.objects.has(PHOTO)).toBe(false);
    // The bug this pins down: a second row surviving here would point at a
    // file that no longer exists, and the owner could neither view it nor
    // delete it.
    expect(backend.imports).toEqual([]);
    expect(backend.orphanedRows()).toEqual([]);
  });
});

describe("two calls racing for one path", () => {
  it("answers with the winner's row rather than deleting the file out from under it", async () => {
    // The competing insert commits after our lookup found nothing, so the
    // unique index is the only thing left to catch it.
    backend.raceBeforeInsert = () => {
      backend.insert({
        location_id: LOCATION,
        batch_id: BATCH,
        source_type: "image",
        source_path: PHOTO,
        status: "pending",
        original_filename: "menu.jpg",
        byte_size: 2_000_000,
        uploaded_by: OWNER,
      });
    };

    const result = await record(PHOTO);

    expect(result.error).toBeUndefined();
    expect(result.menuImport?.source_path).toBe(PHOTO);
    expect(backend.imports).toHaveLength(1);
    expect(backend.removed).toEqual([]);
    expect(backend.objects.has(PHOTO)).toBe(true);
  });
});

describe("what the duplicate check must not swallow", () => {
  it("still records a genuinely different file in the same batch", async () => {
    backend.putObject(SECOND_PHOTO);

    const first = await record(PHOTO);
    const second = await record(SECOND_PHOTO, "menu-back.jpg");

    expect(second.menuImport?.id).not.toBe(first.menuImport?.id);
    expect(backend.imports).toHaveLength(2);
    expect(backend.orphanedRows()).toEqual([]);
  });

  it("still refuses an eleventh file, and takes back the object nobody claimed", async () => {
    for (let i = 0; i < 10; i++) {
      const path = `${LOCATION}/cccccccc-3333-4333-8333-0000000000${String(i).padStart(2, "0")}.jpg`;
      backend.putObject(path);
      expect((await record(path)).menuImport).toBeTruthy();
    }

    const eleventh = `${LOCATION}/dddddddd-4444-4444-8444-dddddddddddd.jpg`;
    backend.putObject(eleventh);
    const refused = await record(eleventh);

    expect(refused.error).toContain("10 files");
    expect(backend.removed).toEqual([eleventh]);
    expect(backend.objects.has(eleventh)).toBe(false);
    expect(backend.orphanedRows()).toEqual([]);
  });

  it("still refuses a path outside the caller's own location", async () => {
    const stranger = `${OTHER_LOCATION}/eeeeeeee-5555-4555-8555-eeeeeeeeeeee.jpg`;
    backend.putObject(stranger);

    expect((await record(stranger)).error).toBe("Not found.");
    expect(backend.imports).toEqual([]);
    expect(backend.removed).toEqual([]);
  });
});

describe("the database, not the lookup, is the guarantee", () => {
  it("ships a unique index over source_path", () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          "../../supabase/migrations/20260813140000_menu_import_one_row_per_file.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    expect(sql).toMatch(/create unique index[\s\S]*menu_imports[\s\S]*\(source_path\)/i);
    // Partial: a 'url' import has no stored object, and any number of
    // those may exist.
    expect(sql).toMatch(/where source_path is not null/i);
  });
});
