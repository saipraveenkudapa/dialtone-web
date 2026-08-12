import { describe, expect, it } from "vitest";
import { openState } from "./hours";

const week = Array.from({ length: 7 }, (_, day) => ({
  day_of_week: day,
  open_time: "17:00:00",
  close_time: "22:30:00",
  is_closed: day === 1,
}));

const tz = "America/Los_Angeles";

describe("open state", () => {
  it("is open inside the window", () => {
    // 2026-08-12 is a Wednesday; 19:00 Los Angeles is 02:00 UTC next day.
    const state = openState({
      now: new Date("2026-08-13T02:00:00Z"),
      timezone: tz,
      hours: week,
      holidays: [],
    });
    expect(state.open_now).toBe(true);
    expect(state.today).toBe("5:00 PM to 10:30 PM");
  });

  it("is closed before opening and says when it opens", () => {
    const state = openState({
      now: new Date("2026-08-12T19:00:00Z"), // 12:00 PM Los Angeles
      timezone: tz,
      hours: week,
      holidays: [],
    });
    expect(state.open_now).toBe(false);
    expect(state.next_open).toBe("today at 5:00 PM");
  });

  it("honours a closed weekday", () => {
    const state = openState({
      now: new Date("2026-08-11T02:00:00Z"), // Monday 7pm Los Angeles
      timezone: tz,
      hours: week,
      holidays: [],
    });
    expect(state.open_now).toBe(false);
    expect(state.today).toBe("closed");
  });

  it("lets a holiday override the weekday", () => {
    const state = openState({
      now: new Date("2026-08-13T02:00:00Z"),
      timezone: tz,
      hours: week,
      holidays: [{ date: "2026-08-12", is_closed: true, open_time: null, close_time: null }],
    });
    expect(state.open_now).toBe(false);
    expect(state.today).toBe("closed");
  });
});
