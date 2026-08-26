import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishItem } from "@/lib/menu-imports/review";

/* Putting a reviewed menu live.
 *
 * The action is a live HTTP endpoint, so the list it is handed is a
 * request body, not the screen's state. These tests are mostly about what
 * never reaches the database: an unconfirmed line, a price that is not an
 * amount, a caller who is not signed in. And about what never happens at
 * all -- this path reads no extraction and holds no service-role key, so
 * a query against any table from here is an outright throw. */

const LOCATION = "a10c0000-0000-0000-0000-00000000000a";
const BATCH = "3f7c9a10-1111-4222-8333-444455556666";
const OWNER = "11111111-1111-1111-1111-111111111111";

type RpcCall = { name: string; args: Record<string, unknown> };

const state = vi.hoisted(() => ({
  user: { id: "11111111-1111-1111-1111-111111111111" } as { id: string } | null,
  rpc: [] as RpcCall[],
  result: null as unknown,
  rpcError: null as unknown,
  revalidated: [] as string[],
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    state.revalidated.push(path);
  },
}));

/** The service role has no business in this path -- and Postgres agrees:
 *  it holds no EXECUTE on publish_menu_import. Importing it here at all
 *  is a failure. */
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => {
    throw new Error("publishing a menu must never use the service role");
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) => {
      throw new Error(
        `publishing must not read ${table} -- every price comes from the person, not a row`,
      );
    },
    storage: {
      from: () => {
        throw new Error("publishing does not touch storage");
      },
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpc.push({ name, args });
      return { data: state.result, error: state.rpcError };
    },
  }),
}));

const { publishMenuImport } = await import("@/app/menu-imports/publish");

const published = (over: Record<string, unknown> = {}) => [
  {
    published: true,
    reason: null,
    categories_created: 2,
    items_created: 3,
    categories_removed: 0,
    items_removed: 0,
    ...over,
  },
];

const line = (over: Partial<PublishItem> = {}): PublishItem => ({
  category: "Antipasti",
  name: "Bruschetta",
  price: "9.00",
  description: "Tomato and basil",
  confirmed: true,
  ...over,
});

beforeEach(() => {
  state.user = { id: OWNER };
  state.rpc = [];
  state.result = published();
  state.rpcError = null;
  state.revalidated = [];
});

describe("publishMenuImport", () => {
  it("sends the person's own values, with prices as integer cents", async () => {
    const result = await publishMenuImport({
      locationId: LOCATION,
      batchId: BATCH,
      mode: "add",
      items: [
        line(),
        line({ category: "Pizze", name: "Margherita", price: "16.5", description: "" }),
        line({ category: "pizze", name: "Diavola", price: "18" }),
      ],
    });

    expect(result.error).toBeUndefined();
    expect(result.published).toEqual({
      mode: "add",
      itemsCreated: 3,
      categoriesCreated: 2,
      itemsRemoved: 0,
      categoriesRemoved: 0,
    });

    expect(state.rpc).toHaveLength(1);
    expect(state.rpc[0].name).toBe("publish_menu_import");
    expect(state.rpc[0].args).toEqual({
      p_location_id: LOCATION,
      p_batch_id: BATCH,
      p_mode: "add",
      p_category_names: ["Antipasti", "Pizze"],
      p_item_category: [0, 1, 1],
      p_item_names: ["Bruschetta", "Margherita", "Diavola"],
      p_item_prices_cents: [900, 1650, 1800],
      p_item_descriptions: ["Tomato and basil", "", "Tomato and basil"],
    });
  });

  it("refuses the publish when one item is unconfirmed, without calling the database", async () => {
    const result = await publishMenuImport({
      locationId: LOCATION,
      batchId: BATCH,
      mode: "add",
      items: [line(), line({ name: "Olive", confirmed: false })],
    });

    expect(result.published).toBeUndefined();
    expect(result.error).toContain("Olive");
    expect(state.rpc).toHaveLength(0);
  });

  it("refuses a price that is not a plain amount, without calling the database", async () => {
    for (const price of ["", "market price", "10-14", "$12", "12.505"]) {
      state.rpc = [];
      const result = await publishMenuImport({
        locationId: LOCATION,
        batchId: BATCH,
        mode: "add",
        items: [line({ price })],
      });
      expect(result.error, `price ${JSON.stringify(price)}`).toBeTruthy();
      expect(state.rpc).toHaveLength(0);
    }
  });

  it("refuses a caller who is not signed in", async () => {
    state.user = null;
    const result = await publishMenuImport({
      locationId: LOCATION,
      batchId: BATCH,
      mode: "add",
      items: [line()],
    });
    expect(result.error).toBe("Not found.");
    expect(state.rpc).toHaveLength(0);
  });

  it("refuses ids that are not uuids and a mode it does not have", async () => {
    const bad = [
      { locationId: "not-a-uuid", batchId: BATCH, mode: "add" as const },
      { locationId: LOCATION, batchId: "../secrets", mode: "add" as const },
      { locationId: LOCATION, batchId: BATCH, mode: "wipe" as unknown as "add" },
    ];
    for (const input of bad) {
      state.rpc = [];
      const result = await publishMenuImport({ ...input, items: [line()] });
      expect(result.error).toBeTruthy();
      expect(state.rpc).toHaveLength(0);
    }
  });

  it("says in words when the import is no longer waiting on anybody", async () => {
    state.result = published({ published: false, reason: "nothing_to_publish" });
    const result = await publishMenuImport({
      locationId: LOCATION,
      batchId: BATCH,
      mode: "add",
      items: [line()],
    });
    expect(result.published).toBeUndefined();
    expect(result.error).toContain("already published or discarded");
  });

  it("does not claim success when the call itself failed", async () => {
    state.result = null;
    state.rpcError = { message: "boom" };
    const result = await publishMenuImport({
      locationId: LOCATION,
      batchId: BATCH,
      mode: "add",
      items: [line()],
    });
    expect(result.published).toBeUndefined();
    expect(result.error).toMatch(/could not be published/);
  });

  it("reports what replacing removed, so the screen can say it", async () => {
    state.result = published({ items_removed: 14, categories_removed: 4 });
    const result = await publishMenuImport({
      locationId: LOCATION,
      batchId: BATCH,
      mode: "replace",
      items: [line()],
    });
    expect(state.rpc[0].args.p_mode).toBe("replace");
    expect(result.published?.itemsRemoved).toBe(14);
    expect(result.published?.categoriesRemoved).toBe(4);
  });

  it("refreshes every screen that quotes the menu", async () => {
    await publishMenuImport({
      locationId: LOCATION,
      batchId: BATCH,
      mode: "add",
      items: [line()],
    });
    expect(state.revalidated).toContain("/dashboard/menu");
    expect(state.revalidated).toContain("/dashboard/menu/live");
  });
});

describe("the shape of the publish path", () => {
  /* Both of these are about what the module may reach for at all, which
     no amount of exercising the function can catch: the day somebody adds
     a service-role fallback "just for the operator", every test above
     still passes. The comments explaining why it is absent obviously
     mention it, so they are stripped first -- what is asserted on is the
     code. */
  const code = readFileSync(
    fileURLToPath(new URL("../../app/menu-imports/publish.ts", import.meta.url)),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("holds no service-role client", () => {
    expect(code).not.toContain("supabase/admin");
    expect(code).not.toContain("supabaseAdmin");
    expect(code).not.toContain("SERVICE_ROLE");
  });

  it("never reads what the model extracted", () => {
    expect(code).not.toContain("raw_extraction");
    expect(code).not.toContain("menu_imports");
  });
});
