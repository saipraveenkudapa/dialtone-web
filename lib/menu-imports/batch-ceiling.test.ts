import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuImportRow } from "@/lib/supabase/types";
import type { MenuReadResult } from "@/lib/menu-imports/read";
import { MAX_MENU_BATCH_BYTES, MAX_MENU_FILE_BYTES, MAX_MENU_FILES } from "@/lib/menu-imports/file";

/* A batch that will certainly be refused is refused before it is fetched.
 *
 * The ceiling is 16 MiB across one menu, and the two limits either side
 * of it do not imply it: ten files (MAX_MENU_FILES) of ten megabytes
 * (MAX_MENU_FILE_BYTES) are each individually allowed, and together they
 * are a hundred. Enforcing the ceiling only inside readMenu means that
 * hundred megabytes is downloaded into Buffers and turned into ~133 MB of
 * base64 strings -- all live at once, in one serverless invocation --
 * purely to be told no. The invocation runs out of memory before it gets
 * to say the sentence, and the owner sees a crash instead of "remove a
 * file".
 *
 * byte_size is already on every menu_imports row, written when the upload
 * was recorded. Summing it costs nothing. So these tests count downloads:
 * an over-ceiling batch must cost exactly zero of them, and no model call
 * either, while a batch that fits must still be read normally. */

const LOCATION = "a10c0000-0000-0000-0000-00000000000a";
const BATCH = "3f7c9a10-1111-4222-8333-444455556666";
const OWNER = "11111111-1111-1111-1111-111111111111";

const state = vi.hoisted(() => ({ read: null as MenuReadResult | null, calls: 0 }));

vi.mock("@/lib/menu-imports/read", () => ({
  readMenu: async () => {
    state.calls += 1;
    return state.read;
  },
}));

let rows: MenuImportRow[] = [];
let downloaded: string[] = [];

const path = (n: number) =>
  `${LOCATION}/aaaaaaaa-1111-4111-8111-${String(n).padStart(12, "0")}.jpg`;

const row = (n: number, byteSize: number | null): MenuImportRow => ({
  id: `99999999-0000-4000-8000-${String(n).padStart(12, "0")}`,
  location_id: LOCATION,
  batch_id: BATCH,
  source_type: "image",
  source_path: path(n),
  original_filename: `menu-${n}.jpg`,
  byte_size: byteSize,
  raw_extraction: {},
  status: "pending",
  uploaded_by: OWNER,
  confirmed_by: null,
  confirmed_at: null,
  created_at: `2026-08-13T00:00:${String(n).padStart(2, "0")}.000Z`,
});

/** A PostgREST builder, only as far as this action uses one. */
class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private op: "select" | "update" = "select";
  private filters: [string, unknown][] = [];
  private values: Record<string, unknown> | null = null;

  constructor(private table: string) {
    if (table !== "menu_imports" && table !== "locations") {
      throw new Error(`reading a menu must not touch ${table}`);
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
  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }
  order() {
    return this;
  }

  private matches(candidate: MenuImportRow) {
    return this.filters.every(
      ([column, value]) => (candidate as never as Record<string, unknown>)[column] === value,
    );
  }

  private run() {
    if (this.table === "locations") {
      const id = this.filters.find(([column]) => column === "id")?.[1];
      return { data: id === LOCATION ? { id } : null, error: null };
    }

    const matched = rows.filter((candidate) => this.matches(candidate));
    if (this.op === "update") {
      const updated = matched.map((candidate) => {
        const next = { ...candidate, ...this.values } as MenuImportRow;
        rows = rows.map((existing) => (existing.id === candidate.id ? next : existing));
        return next;
      });
      return { data: updated, error: null };
    }
    return { data: [...matched].sort((a, b) => a.created_at.localeCompare(b.created_at)), error: null };
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
    from: () => ({
      download: async (objectPath: string) => {
        downloaded.push(objectPath);
        // Deliberately tiny: this double could not hold the real hundred
        // megabytes, which is the whole point of not fetching them.
        return { data: new Blob([new Uint8Array([1, 2, 3]) as BlobPart]), error: null };
      },
    }),
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

const { readMenuImports } = await import("@/app/menu-imports/actions");

const extraction = () => ({
  schema_version: 1,
  read_at: "2026-08-13T12:00:00.000Z",
  model: "claude-opus-5",
  file: { index: 0, filename: "menu-1.jpg", source_type: "image" },
  files: [{ index: 0, filename: "menu-1.jpg", source_type: "image" }],
  document: { kind: "menu", note: "Read cleanly.", language: "Italian" },
  categories: [],
  totals: { items: 0, unsure_fields: 0, unknown_prices: 0 },
});

beforeEach(() => {
  rows = [];
  downloaded = [];
  state.calls = 0;
  state.read = { ok: true, extractions: [extraction()] } as MenuReadResult;
});

describe("a batch over the ceiling", () => {
  it("is refused without downloading a single file", async () => {
    rows = Array.from({ length: MAX_MENU_FILES }, (_, n) => row(n, MAX_MENU_FILE_BYTES));

    const result = await readMenuImports({ locationId: LOCATION, batchId: BATCH });

    expect(result.error).toMatch(/100 MB/);
    expect(result.error).toMatch(/Remove a file/);
    // The bug: without the check on byte_size, all ten of these are
    // fetched and base64'd before anything refuses them.
    expect(downloaded).toEqual([]);
    expect(state.calls).toBe(0);
  });

  it("leaves the rows pending, so a smaller batch can be read after", async () => {
    rows = [row(1, MAX_MENU_BATCH_BYTES), row(2, 1)];

    const result = await readMenuImports({ locationId: LOCATION, batchId: BATCH });

    expect(result.menuImports).toBeUndefined();
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => Object.keys(r.raw_extraction as object).length === 0)).toBe(true);
    expect(downloaded).toEqual([]);
  });

  it("is refused before another restaurant's row could even be considered", async () => {
    // Authorization still comes first: a size sentence must never be the
    // thing that answers a request for a file that is not the caller's.
    rows = [row(1, MAX_MENU_FILE_BYTES)];
    rows[0].source_path = "b20c0000-0000-0000-0000-00000000000b/x.jpg";

    const result = await readMenuImports({ locationId: LOCATION, batchId: BATCH });

    expect(result.error).toBe("Not found.");
    expect(downloaded).toEqual([]);
  });
});

describe("a batch that fits", () => {
  it("is still downloaded and read", async () => {
    rows = [row(1, 6_000_000), row(2, 6_000_000)];

    const result = await readMenuImports({ locationId: LOCATION, batchId: BATCH });

    expect(result.error).toBeUndefined();
    expect(downloaded).toEqual([path(1), path(2)]);
    expect(state.calls).toBe(1);
  });

  it("is not refused for a size the row does not carry", async () => {
    // byte_size is nullable. An unknown size is not evidence of a big
    // one, and readMenu weighs the real bytes a moment later.
    rows = [row(1, null), row(2, null)];

    const result = await readMenuImports({ locationId: LOCATION, batchId: BATCH });

    expect(result.error).toBeUndefined();
    expect(downloaded).toHaveLength(2);
    expect(state.calls).toBe(1);
  });
});
