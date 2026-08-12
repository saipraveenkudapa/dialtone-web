import { describe, expect, it } from "vitest";
import { agentOk, agentFail } from "./respond";

describe("agent responses", () => {
  it("wraps data in an ok envelope", async () => {
    const res = agentOk({ items: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, items: [] });
  });

  it("reports failure with a spoken-friendly message", async () => {
    const res = agentFail("Something went wrong", 500);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "Something went wrong" });
  });

  it("defaults a failure to 400", () => {
    expect(agentFail("nope").status).toBe(400);
  });
});
