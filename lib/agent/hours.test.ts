import { describe, expect, it } from "vitest";
import { openAt, openState } from "./hours";

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

  it("after today's closing time, says when it opens tomorrow", () => {
    const state = openState({
      // 2026-08-12 (Wed) closes at 10:30 PM Los Angeles; this is 11:00 PM.
      now: new Date("2026-08-13T06:00:00Z"),
      timezone: tz,
      hours: week,
      holidays: [],
    });
    expect(state.open_now).toBe(false);
    expect(state.today).toBe("5:00 PM to 10:30 PM");
    expect(state.next_open).toBe("tomorrow at 5:00 PM");
  });

  it("on a run of closed weekdays, names the next open day", () => {
    const mondayAndTuesdayClosed = Array.from({ length: 7 }, (_, day) => ({
      day_of_week: day,
      open_time: "17:00:00",
      close_time: "22:30:00",
      is_closed: day === 1 || day === 2,
    }));
    const state = openState({
      now: new Date("2026-08-11T02:00:00Z"), // Monday 7pm Los Angeles
      timezone: tz,
      hours: mondayAndTuesdayClosed,
      holidays: [],
    });
    expect(state.open_now).toBe(false);
    expect(state.today).toBe("closed");
    expect(state.next_open).toBe("Wednesday at 5:00 PM");
  });

  it("skips a holiday closure while searching forward", () => {
    const state = openState({
      now: new Date("2026-08-11T02:00:00Z"), // Monday 7pm Los Angeles, closed
      timezone: tz,
      hours: week,
      // Tuesday (2026-08-11) would normally be the next open day; the
      // holiday closes it, so the search should skip to Wednesday.
      holidays: [{ date: "2026-08-11", is_closed: true, open_time: null, close_time: null }],
    });
    expect(state.open_now).toBe(false);
    expect(state.today).toBe("closed");
    expect(state.next_open).toBe("Wednesday at 5:00 PM");
  });

  it("returns null when nothing opens in the next seven days", () => {
    // Every weekday is closed, so the forward search exhausts all 7 days
    // without finding an opening. This is the case where the agent truly
    // has no answer for "when do you open" and must say so, not guess.
    const allClosed = Array.from({ length: 7 }, (_, day) => ({
      day_of_week: day,
      open_time: null,
      close_time: null,
      is_closed: true,
    }));
    const state = openState({
      now: new Date("2026-08-11T02:00:00Z"), // Monday 7pm Los Angeles (local date 2026-08-10)
      timezone: tz,
      hours: allClosed,
      holidays: [],
    });
    expect(state.open_now).toBe(false);
    expect(state.today).toBe("closed");
    expect(state.next_open).toBeNull();
  });

  it("lets a forward-search holiday open a day the weekday row marks closed", () => {
    // Every weekday row is closed, so on its own the search would never
    // find an opening. A holiday_hours row for 2026-08-12 (Wednesday) with
    // is_closed: false and explicit times must override that closed
    // weekday row and be the day next_open names.
    const allClosed = Array.from({ length: 7 }, (_, day) => ({
      day_of_week: day,
      open_time: null,
      close_time: null,
      is_closed: true,
    }));
    const state = openState({
      now: new Date("2026-08-11T02:00:00Z"), // Monday 7pm Los Angeles (local date 2026-08-10)
      timezone: tz,
      hours: allClosed,
      holidays: [
        { date: "2026-08-12", is_closed: false, open_time: "09:00:00", close_time: "14:00:00" },
      ],
    });
    expect(state.open_now).toBe(false);
    expect(state.today).toBe("closed");
    expect(state.next_open).toBe("Wednesday at 9:00 AM");
  });

  it("steps across the November DST fall-back without skipping or repeating a day", () => {
    // Only Sunday is open. 2026-10-26T19:00:00Z is Monday, 12:00 PM Los
    // Angeles (PDT) -- verified via Intl.DateTimeFormat, local date
    // 2026-10-26. The 7-day forward search (Tue Oct 27 .. Sun Nov 1) walks
    // straight through the Nov 1, 2026 fall-back transition (2am -> 1am
    // local). Because day-stepping is pure calendar-string arithmetic, not
    // wall-clock math, it must land on Sunday, Nov 1 -- not Saturday (a
    // repeat) or Monday, Nov 2 (a skip).
    const sundayOnly = Array.from({ length: 7 }, (_, day) => ({
      day_of_week: day,
      open_time: day === 0 ? "10:00:00" : null,
      close_time: day === 0 ? "14:00:00" : null,
      is_closed: day !== 0,
    }));
    const state = openState({
      now: new Date("2026-10-26T19:00:00Z"),
      timezone: tz,
      hours: sundayOnly,
      holidays: [],
    });
    expect(state.open_now).toBe(false);
    expect(state.today).toBe("closed");
    expect(state.next_open).toBe("Sunday at 10:00 AM");
  });
});

describe("openAt", () => {
  // The gate in front of create_reservation and place_order. Before it
  // existed, a 3 AM table and a 3 AM order were both taken, written and
  // confirmed -- the only thing checking the hours was a sentence in the
  // system prompt telling the model to.
  it("is open inside the window on an open day", () => {
    const verdict = openAt({
      at: new Date("2026-08-13T02:00:00Z"), // Wednesday 7:00 PM LA
      timezone: tz,
      hours: week,
      holidays: [],
    });
    expect(verdict).toEqual({ state: "open", hoursThatDay: "5:00 PM to 10:30 PM" });
  });

  it("is closed outside the window, and says what the hours were", () => {
    const verdict = openAt({
      at: new Date("2026-08-13T10:00:00Z"), // Thursday 3:00 AM LA
      timezone: tz,
      hours: week,
      holidays: [],
    });
    // The day's real hours ride along so the agent can offer them back
    // instead of only saying no.
    expect(verdict).toEqual({ state: "closed", hoursThatDay: "5:00 PM to 10:30 PM" });
  });

  it("is closed all day on a closed weekday", () => {
    const verdict = openAt({
      at: new Date("2026-08-11T02:00:00Z"), // Monday 7:00 PM LA
      timezone: tz,
      hours: week,
      holidays: [],
    });
    expect(verdict).toEqual({ state: "closed", hoursThatDay: "closed" });
  });

  it("lets a holiday override the weekday, both ways", () => {
    const closedHoliday = openAt({
      at: new Date("2026-08-13T02:00:00Z"), // Wednesday 7:00 PM LA
      timezone: tz,
      hours: week,
      holidays: [{ date: "2026-08-12", is_closed: true, open_time: null, close_time: null }],
    });
    expect(closedHoliday).toEqual({ state: "closed", hoursThatDay: "closed" });

    const openHoliday = openAt({
      at: new Date("2026-08-11T02:00:00Z"), // Monday 7:00 PM LA, normally shut
      timezone: tz,
      hours: week,
      holidays: [
        { date: "2026-08-10", is_closed: false, open_time: "18:00:00", close_time: "23:00:00" },
      ],
    });
    expect(openHoliday).toEqual({ state: "open", hoursThatDay: "6:00 PM to 11:00 PM" });
  });

  it("treats the boundary the same way a slot does: open at open, closed at close", () => {
    const atOpen = openAt({
      at: new Date("2026-08-13T00:00:00Z"), // 5:00 PM LA exactly
      timezone: tz,
      hours: week,
      holidays: [],
    });
    expect(atOpen.state).toBe("open");

    const atClose = openAt({
      at: new Date("2026-08-13T05:30:00Z"), // 10:30 PM LA exactly
      timezone: tz,
      hours: week,
      holidays: [],
    });
    expect(atClose.state).toBe("closed");
  });

  // The two cases that must never come back "closed". Both are failures
  // of the data, not statements about the restaurant, and answering
  // "closed" to either turns them into a location that can never take a
  // booking or an order again.
  it("says unknown, not closed, when the hours cross midnight", () => {
    const lateNight = week.map((day) => ({ ...day, open_time: "22:00:00", close_time: "02:00:00" }));
    const verdict = openAt({
      at: new Date("2026-08-13T08:00:00Z"), // 1:00 AM LA, genuinely open
      timezone: tz,
      hours: lateNight,
      holidays: [],
    });
    expect(verdict).toEqual({ state: "unknown", reason: "crosses_midnight" });
  });

  it("says unknown when no hours have ever been configured", () => {
    expect(openAt({ at: new Date(), timezone: tz, hours: [], holidays: [] })).toEqual({
      state: "unknown",
      reason: "no_hours_configured",
    });
  });

  it("still says closed for a day with no row when other days have one", () => {
    // A location with a Tuesday row and no Monday row is shut on Mondays.
    // That is a real answer about the restaurant, not missing setup.
    const tuesdayOnly = [week[2]];
    const verdict = openAt({
      at: new Date("2026-08-11T02:00:00Z"), // Monday 7:00 PM LA
      timezone: tz,
      hours: tuesdayOnly,
      holidays: [],
    });
    expect(verdict).toEqual({ state: "closed", hoursThatDay: "closed" });
  });

  it("says unknown for a holiday that is open with no times on it", () => {
    const verdict = openAt({
      at: new Date("2026-08-13T02:00:00Z"),
      timezone: tz,
      hours: week,
      holidays: [{ date: "2026-08-12", is_closed: false, open_time: null, close_time: null }],
    });
    expect(verdict).toEqual({ state: "unknown", reason: "no_hours_configured" });
  });
});
