import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuImportRow } from "@/lib/supabase/types";
import type { MenuReadResult } from "@/lib/menu-imports/read";

/* The distance a model is allowed to move a price on its own.
 *
 * It is exactly one status: 'pending' to 'needs_review', with what was
 * read parked in raw_extraction. menu_items is not written here and this
 * fake refuses to be asked about it at all -- a query against that table
 * from this action would be the bug the whole feature exists to prevent,
 * so it throws rather than quietly succeeding.
 *
 * The other half is what happens when the read does not finish. Nothing
 * is written, the rows stay pending, and the same photographs can be read
 * again without being uploaded twice. */

const LOCATION = "a10c0000-0000-0000-0000-00000000000a";
const BATCH = "3f7c9a10-1111-4222-8333-444455556666";
const OTHER_BATCH = "4f7c9a10-1111-4222-8333-444455556666";
const OWNER = "11111111-1111-1111-1111-111111111111";

const PHOTO = `${LOCATION}/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.jpg`;
const BACK = `${LOCATION}/bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.jpg`;

const state = vi.hoisted(() => ({
  read: null as MenuReadResult | null,
  sawFiles: [] as { filename: string | null; mediaType: string; bytes: number }[],
  calls: 0,
}));

vi.mock("@/lib/menu-imports/read", () => ({
  readMenu: async (files: { filename: string | null; mediaType: string; bytes: number }[]) => {
    state.calls += 1;
    state.sawFiles = files;
    return state.read;
  },
}));

type Row = MenuImportRow;

let rows: Row[] = [];
let objects = new Map<string, Uint8Array>();
let removed: string[] = [];

const row = (over: Partial<Row> = {}): Row => ({
  id: "99999999-0000-4000-8000-000000000001",
  location_id: LOCATION,
  batch_id: BATCH,
  source_type: "image",
  source_path: PHOTO,
  original_filename: "menu-front.jpg",
  byte_size: 2_000_000,
  raw_extraction: {},
  status: "pending",
  uploaded_by: OWNER,
  confirmed_by: null,
  confirmed_at: null,
  created_at: "2026-08-13T00:00:00.000Z",
  ...over,
});

/** A PostgREST builder, only as far as this action uses one. Any table
 *  other than the two it is allowed to touch is an outright throw. */
class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: "select" | "update" | "delete" = "select";
  private filters: [string, unknown][] = [];
  private values: Record<string, unknown> | null = null;
  private ascending = true;

  constructor(private table: string) {
    if (table !== "menu_imports" && table !== "locations") {
      throw new Error(
        `reading a menu must not touch ${table} -- only a human confirming does`,
      );
    }
  }

  select() {
    return this;
  }
  update(values: Record<string, unknown>) {
    this.op = "update";
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
  order(_column: string, options?: { ascending?: boolean }) {
    this.ascending = options?.ascending ?? true;
    return this;
  }

  private matches(candidate: Row) {
    return this.filters.every(([column, value]) => (candidate as never as Record<string, unknown>)[column] === value);
  }

  private run() {
    if (this.table === "locations") {
      const id = this.filters.find(([column]) => column === "id")?.[1];
      return { data: id === LOCATION ? { id } : null, error: null };
    }

    const matched = rows.filter((candidate) => this.matches(candidate));

    if (this.op === "update") {
      const updated = matched.map((candidate) => {
        const next = { ...candidate, ...this.values } as Row;
        rows = rows.map((existing) => (existing.id === candidate.id ? next : existing));
        return next;
      });
      return { data: updated, error: null };
    }
    if (this.op === "delete") {
      rows = rows.filter((candidate) => !this.matches(candidate));
      return { data: null, error: null };
    }

    const sorted = [...matched].sort((a, b) =>
      this.ascending
        ? a.created_at.localeCompare(b.created_at)
        : b.created_at.localeCompare(a.created_at),
    );
    return { data: sorted, error: null };
  }

  private first() {
    const result = this.run();
    const data = Array.isArray(result.data) ? (result.data[0] ?? null) : result.data;
    return { ...result, data };
  }

  maybeSingle() {
    return Promise.resolve(this.first());
  }

  then<R1 = { data: unknown; error: unknown }, R2 = never>(
    resolve?: ((value: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
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
        download: async (path: string) => {
          const bytes = objects.get(path);
          if (!bytes) return { data: null, error: { message: "not found" } };
          return { data: new Blob([bytes as BlobPart]), error: null };
        },
        remove: async (paths: string[]) => {
          for (const path of paths) {
            removed.push(path);
            objects.delete(path);
          }
          return { data: null, error: null };
        },
      };
    },
  },
};

vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => fakeClient }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    throw new Error("the service-role client must not be reached for an owner's own menu");
  },
}));
vi.mock("@/lib/admin/auth", () => ({ currentPlatformAdmin: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { readMenuImports, discardMenuImport } = await import("@/app/menu-imports/actions");

const extraction = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  read_at: "2026-08-13T12:00:00.000Z",
  model: "claude-opus-5",
  file: { index: 0, filename: "menu-front.jpg", source_type: "image" },
  files: [{ index: 0, filename: "menu-front.jpg", source_type: "image" }],
  document: { kind: "menu", note: "Read cleanly.", language: "Italian" },
  categories: [
    {
      name: "Antipasti",
      name_confidence: "confident",
      items: [
        {
          name: "Bruschetta",
          name_confidence: "confident",
          price: { known: true, cents: 950, as_printed: "9.50", confidence: "confident" },
          description: null,
          ingredients: null,
          file_index: 0,
        },
      ],
    },
  ],
  totals: { items: 1, unsure_fields: 0, unknown_prices: 0 },
  ...over,
});

beforeEach(() => {
  rows = [row()];
  objects = new Map([[PHOTO, new Uint8Array([1, 2, 3])]]);
  removed = [];
  state.calls = 0;
  state.sawFiles = [];
  state.read = { ok: true, extractions: [extraction()] } as MenuReadResult;
});

describe("a menu that was read", () => {
  it("lands in raw_extraction at needs_review, and nowhere else", async () => {
    const result = await readMenuImports({ locationId: LOCATION, batchId: BATCH });

    expect(result.error).toBeUndefined();
    expect(rows[0].status).toBe("needs_review");
    expect(rows[0].raw_extraction).toEqual(extraction());
    // The row is not confirmed and has no signature on it: the CHECK on
    // this table would refuse that pairing anyway, and nothing here tries.
    expect(rows[0].confirmed_at).toBeNull();
    expect(rows[0].confirmed_by).toBeNull();
    expect(result.menuImports).toHaveLength(1);
  });

  it("reads every file of the batch in one call, oldest first", async () => {
    rows = [
      row({ id: "99999999-0000-4000-8000-000000000002", source_path: BACK, original_filename: "menu-back.jpg", created_at: "2026-08-13T00:05:00.000Z" }),
      row(),
    ];
    objects.set(BACK, new Uint8Array([4, 5]));
    state.read = {
      ok: true,
      extractions: [extraction(), extraction({ file: { index: 1, filename: "menu-back.jpg", source_type: "image" } })],
    } as MenuReadResult;

    await readMenuImports({ locationId: LOCATION, batchId: BATCH });

    expect(state.calls).toBe(1);
    expect(state.sawFiles.map((file) => file.filename)).toEqual([
      "menu-front.jpg",
      "menu-back.jpg",
    ]);
    // The bytes handed to the model are the stored object's, not the size
    // a browser once claimed.
    expect(state.sawFiles.map((file) => file.bytes)).toEqual([3, 2]);
    expect(state.sawFiles.map((file) => file.mediaType)).toEqual(["image/jpeg", "image/jpeg"]);
    expect(rows.every((r) => r.status === "needs_review")).toBe(true);
  });

  it("leaves another batch's files alone", async () => {
    rows = [row(), row({ id: "99999999-0000-4000-8000-000000000003", batch_id: OTHER_BATCH, source_path: BACK })];
    objects.set(BACK, new Uint8Array([4]));

    await readMenuImports({ locationId: LOCATION, batchId: BATCH });

    expect(state.sawFiles).toHaveLength(1);
    expect(rows.find((r) => r.batch_id === OTHER_BATCH)!.status).toBe("pending");
  });

  it("refuses to read the same photographs twice", async () => {
    await readMenuImports({ locationId: LOCATION, batchId: BATCH });
    const second = await readMenuImports({ locationId: LOCATION, batchId: BATCH });

    // The second click costs the restaurant nothing.
    expect(state.calls).toBe(1);
    expect(second.error).toMatch(/already been read/i);
  });
});

describe("a read that did not finish", () => {
  it("leaves the rows pending, so the same files can be read again", async () => {
    state.read = { ok: false, reason: "truncated", error: "This menu is longer than one read can hold." } as MenuReadResult;

    const result = await readMenuImports({ locationId: LOCATION, batchId: BATCH });

    expect(result.error).toMatch(/longer than one read/);
    expect(result.menuImports).toBeUndefined();
    expect(rows[0].status).toBe("pending");
    expect(rows[0].raw_extraction).toEqual({});
  });

  it("passes the missing-key sentence straight through to the person who can fix it", async () => {
    state.read = {
      ok: false,
      reason: "not_configured",
      error: "Reading a menu is not configured. Set ANTHROPIC_API_KEY in .env.local",
    } as MenuReadResult;

    const result = await readMenuImports({ locationId: LOCATION, batchId: BATCH });
    expect(result.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(rows[0].status).toBe("pending");
  });

  it("does not call the model at all when a file cannot be fetched", async () => {
    objects.delete(PHOTO);

    const result = await readMenuImports({ locationId: LOCATION, batchId: BATCH });

    expect(state.calls).toBe(0);
    expect(result.error).toMatch(/could not be opened/i);
    expect(rows[0].status).toBe("pending");
  });
});

describe("who may ask for a read", () => {
  it("refuses another restaurant's location without saying whether it exists", async () => {
    const result = await readMenuImports({
      locationId: "b20c0000-0000-0000-0000-00000000000b",
      batchId: BATCH,
    });
    expect(result.error).toBe("Not found.");
    expect(state.calls).toBe(0);
  });

  it("refuses a batch id that is not a uuid", async () => {
    const result = await readMenuImports({ locationId: LOCATION, batchId: "../../etc" });
    expect(result.error).toBe("Not found.");
    expect(state.calls).toBe(0);
  });

  it("refuses a row whose stored path points outside its own location", async () => {
    rows = [row({ source_path: "b20c0000-0000-0000-0000-00000000000b/x.jpg" })];
    const result = await readMenuImports({ locationId: LOCATION, batchId: BATCH });
    expect(result.error).toBe("Not found.");
    expect(state.calls).toBe(0);
  });
});

describe("removing a file after it has been read", () => {
  it("refuses once there is something a human could confirm", async () => {
    await readMenuImports({ locationId: LOCATION, batchId: BATCH });

    const result = await discardMenuImport({ locationId: LOCATION, importId: rows[0].id });

    expect(result.error).toMatch(/already been read/i);
    expect(rows).toHaveLength(1);
    expect(objects.has(PHOTO)).toBe(true);
  });

  it("still allows it when the read found nothing to confirm", async () => {
    // Otherwise a photograph of a parking receipt is stuck on the screen
    // for good: too read to delete, with nothing in it to review.
    state.read = {
      ok: true,
      extractions: [
        extraction({
          document: { kind: "not_a_menu", note: "This is a parking receipt.", language: null },
          categories: [],
          totals: { items: 0, unsure_fields: 0, unknown_prices: 0 },
        }),
      ],
    } as MenuReadResult;

    await readMenuImports({ locationId: LOCATION, batchId: BATCH });
    expect(rows[0].status).toBe("needs_review");

    const result = await discardMenuImport({ locationId: LOCATION, importId: rows[0].id });

    expect(result.error).toBeUndefined();
    expect(rows).toEqual([]);
    expect(removed).toEqual([PHOTO]);
  });
});
