import { describe, expect, it } from "vitest";
import { seatsTaken, nearestTimes } from "./availability";

describe("availability", () => {
  const slot = new Date("2026-08-13T02:00:00Z"); // 7pm Los Angeles

  it("counts bookings overlapping the slot", () => {
    const taken = seatsTaken(
      [
        { requested_at: "2026-08-13T02:00:00Z", party_size: 4 },
        { requested_at: "2026-08-13T02:30:00Z", party_size: 2 },
      ],
      slot,
      90,
    );
    expect(taken).toBe(6);
  });

  it("ignores bookings that end before the slot starts", () => {
    const taken = seatsTaken(
      [{ requested_at: "2026-08-13T00:00:00Z", party_size: 4 }],
      slot,
      90,
    );
    expect(taken).toBe(0);
  });

  it("ignores bookings that start after the slot ends", () => {
    const taken = seatsTaken(
      [{ requested_at: "2026-08-13T04:00:00Z", party_size: 4 }],
      slot,
      90,
    );
    expect(taken).toBe(0);
  });

  it("offers nearby times in the location's timezone", () => {
    expect(nearestTimes(slot, "America/Los_Angeles", 2)).toEqual([
      "6:30 PM",
      "7:30 PM",
    ]);
  });
});
