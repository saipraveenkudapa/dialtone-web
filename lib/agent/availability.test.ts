import { describe, expect, it } from "vitest";
import { seatsTaken, nearestTimes, isRequestInPast } from "./availability";

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
    // These two bookings also overlap EACH OTHER (2:00-3:30 vs
    // 2:30-4:00), so their peak concurrent demand really is the sum.
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

  it("takes the peak, not the sum, when overlapping bookings never coincide with each other", () => {
    // Request: 7:00-8:30 (90 min), starting at `slot`.
    // Booking A: 6:31-8:01, party 6 -- overlaps the request.
    // Booking B: 8:02-9:32, party 6 -- overlaps the request.
    // A and B never coincide (A turns over at 8:01, B doesn't start
    // until 8:02), so the real peak demand is 6, not 12. With 10 seats
    // and a party of 2, this must read as available.
    const taken = seatsTaken(
      [
        { requested_at: "2026-08-13T01:31:00Z", party_size: 6 }, // 6:31 PM
        { requested_at: "2026-08-13T03:02:00Z", party_size: 6 }, // 8:02 PM
      ],
      slot,
      90,
    );
    expect(taken).toBe(6);
    expect(taken + 2).toBeLessThanOrEqual(10);
  });

  it("adds up bookings that DO overlap each other", () => {
    // Booking A: 6:45-8:15, party 3. Booking B: 7:15-8:45, party 5.
    // A and B coincide from 7:15-8:15, so peak concurrent demand is 8.
    const taken = seatsTaken(
      [
        { requested_at: "2026-08-13T01:45:00Z", party_size: 3 }, // 6:45 PM
        { requested_at: "2026-08-13T02:15:00Z", party_size: 5 }, // 7:15 PM
      ],
      slot,
      90,
    );
    expect(taken).toBe(8);
  });

  it("offers nearby times in the location's timezone", () => {
    expect(nearestTimes(slot, "America/Los_Angeles", 2)).toEqual([
      "6:30 PM",
      "7:30 PM",
    ]);
  });

  it("qualifies an alternative that crosses midnight with a day word", () => {
    // 11:45 PM Los Angeles on 2026-08-13 (daylight time, UTC-7).
    const lateSlot = new Date("2026-08-14T06:45:00Z");
    const times = nearestTimes(lateSlot, "America/Los_Angeles", 6);
    // +90 minutes lands at 1:15 AM the next local calendar day.
    expect(times).toContain("tomorrow at 1:15 AM");
    // -30 minutes stays within the same local calendar day.
    expect(times).toContain("11:15 PM");
  });

  it("qualifies an alternative that crosses into the previous day with 'yesterday'", () => {
    // 12:15 AM Los Angeles on 2026-08-14 (daylight time, UTC-7).
    // Verified with Intl.DateTimeFormat: 2026-08-14T07:15:00Z is
    // "12:15 AM" on "2026-08-14" in America/Los_Angeles.
    const earlySlot = new Date("2026-08-14T07:15:00Z");
    const times = nearestTimes(earlySlot, "America/Los_Angeles", 2);
    // -30 minutes lands at 11:45 PM on the previous local calendar day
    // (2026-08-13), sorting before the +30 minute alternative.
    expect(times).toEqual(["yesterday at 11:45 PM", "12:45 AM"]);
  });

  describe("isRequestInPast", () => {
    const now = new Date("2026-08-13T02:00:00Z");

    it("rejects a time well in the past", () => {
      expect(
        isRequestInPast(new Date("2026-08-13T01:00:00Z"), now),
      ).toBe(true);
    });

    it("accepts a time in the future", () => {
      expect(
        isRequestInPast(new Date("2026-08-13T03:00:00Z"), now),
      ).toBe(false);
    });

    it("tolerates a small clock skew (a legitimate 'in five minutes' request)", () => {
      // Requested a moment that is 1 minute "in the past" relative to
      // `now`, within the default 2-minute tolerance for skew between
      // the voice platform's clock and this server's.
      expect(
        isRequestInPast(new Date("2026-08-13T01:59:00Z"), now),
      ).toBe(false);
    });

    it("rejects once past the tolerance window", () => {
      expect(
        isRequestInPast(new Date("2026-08-13T01:57:00Z"), now),
      ).toBe(true);
    });
  });
});
