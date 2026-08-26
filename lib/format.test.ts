import { afterEach, describe, expect, it, vi } from "vitest";
import { dateTimeIn, timeIn } from "./format";

/* A2 -- "a time with no date".
 *
 * The property under test is not "dateTimeIn emits this string". It is:
 * THE RENDERED STRING IDENTIFIES THE INSTANT. Two rows that are not the
 * same moment must not read the same, and one row must not change what
 * it says depending on when it is read. Every case below is one way the
 * old output failed that, or one way the new output could.
 */

/* ICU has moved the space before AM/PM between a normal space and
 * U+202F NARROW NO-BREAK SPACE across releases (and the repo's Node is
 * not pinned). Comparing raw would make these tests a test of the
 * platform's whitespace. Normalise it -- and ONLY it -- so the
 * assertions stay about month, day, year and clock. */
const norm = (s: string) => s.replace(/ | /g, " ");

const LA = "America/Los_Angeles";
/* UTC+12/+13. Chosen because it puts the local date AHEAD of the UTC
 * date, where America/Los_Angeles puts it behind -- the bug is
 * symmetric and one side of it is not a test. */
const NZ = "Pacific/Auckland";

afterEach(() => {
  vi.useRealTimers();
});

describe("dateTimeIn -- the whole instant", () => {
  it("carries month, day, year and clock time", () => {
    // 2026-08-14T18:09:00Z is 11:09 in the morning in California (PDT, UTC-7).
    expect(norm(dateTimeIn(LA, "2026-08-14T18:09:00Z"))).toBe("Aug 14, 2026, 11:09 AM");
  });

  it("distinguishes today from yesterday at the same clock time", () => {
    // The reported defect, exactly: a call from three days ago rendering
    // as a bare "11:09 AM" beside a dashboard reading "0 answered today".
    const today = dateTimeIn(LA, "2026-08-17T18:09:00Z");
    const yesterday = dateTimeIn(LA, "2026-08-16T18:09:00Z");
    const threeDaysAgo = dateTimeIn(LA, "2026-08-14T18:09:00Z");

    expect(norm(today)).toBe("Aug 17, 2026, 11:09 AM");
    expect(norm(yesterday)).toBe("Aug 16, 2026, 11:09 AM");
    expect(new Set([today, yesterday, threeDaysAgo]).size).toBe(3);
  });

  it("distinguishes the same date and clock time in a different year", () => {
    // Without `year` these two are the same string. The logs in this
    // product are bounded by COUNT ("the last twenty", "the last ten"),
    // never by age, so a row this old is reachable in ordinary use.
    const thisYear = dateTimeIn(LA, "2026-08-14T18:09:00Z");
    const lastYear = dateTimeIn(LA, "2025-08-14T18:09:00Z");

    expect(norm(thisYear)).toBe("Aug 14, 2026, 11:09 AM");
    expect(norm(lastYear)).toBe("Aug 14, 2025, 11:09 AM");
    expect(thisYear).not.toBe(lastYear);
  });

  it("shows the LOCAL date when it differs from the UTC date, in both directions", () => {
    // One instant, three clocks, three different calendar days. The date
    // is worth nothing if it is the wrong one -- and a date bug is far
    // harder to see than the missing date it replaced.
    const instant = "2026-08-14T16:00:00Z";

    // Auckland is UTC+12 in August: already the 15th, early morning.
    expect(norm(dateTimeIn(NZ, instant))).toBe("Aug 15, 2026, 4:00 AM");
    expect(norm(dateTimeIn("UTC", instant))).toBe("Aug 14, 2026, 4:00 PM");
    expect(norm(dateTimeIn(LA, instant))).toBe("Aug 14, 2026, 9:00 AM");

    // ...and the mirror image: an instant whose UTC date is one day
    // AHEAD of the restaurant's. 04:30Z on the 15th is still the
    // evening of the 14th in California.
    expect(norm(dateTimeIn(LA, "2026-08-15T04:30:00Z"))).toBe("Aug 14, 2026, 9:30 PM");
    expect(norm(dateTimeIn("UTC", "2026-08-15T04:30:00Z"))).toBe("Aug 15, 2026, 4:30 AM");
  });

  it("does not depend on the clock, so a server render and a client render agree", () => {
    // The reason this formatter is absolute and says no "today". A
    // relative form would be computed once on the server and again in
    // the browser -- and again after midnight in a console tab an
    // operator left open. Same input, same output, whenever it is
    // called: no hydration mismatch is possible, and no row can go
    // stale where it sits.
    const iso = "2026-08-14T18:09:00Z";

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T18:10:00Z")); // one minute later
    const rightAfter = dateTimeIn(LA, iso);
    vi.setSystemTime(new Date("2026-08-15T07:00:00Z")); // past local midnight
    const nextDay = dateTimeIn(LA, iso);
    vi.setSystemTime(new Date("2027-03-01T00:00:00Z")); // next year
    const nextYear = dateTimeIn(LA, iso);
    vi.useRealTimers();
    const now = dateTimeIn(LA, iso);

    expect(new Set([rightAfter, nextDay, nextYear, now]).size).toBe(1);
    expect(norm(rightAfter)).toBe("Aug 14, 2026, 11:09 AM");
  });

  it("crosses a DST boundary in the location's own clock", () => {
    // US DST ends 2026-11-01. Both instants are 09:30 in California --
    // one at UTC-7, one at UTC-8 -- so a formatter that did its own
    // offset arithmetic instead of asking Intl would print one of them
    // an hour out and put it on the wrong side of a day boundary at the
    // edges.
    expect(norm(dateTimeIn(LA, "2026-10-31T16:30:00Z"))).toBe("Oct 31, 2026, 9:30 AM");
    expect(norm(dateTimeIn(LA, "2026-11-01T17:30:00Z"))).toBe("Nov 1, 2026, 9:30 AM");
  });
});

describe("timeIn -- why the log rows moved off it", () => {
  it("is blind to the day, which is the whole of the defect", () => {
    // Not a complaint about timeIn: this is what it is for, under a
    // heading that has already said the date. It is a regression guard
    // on the reason no log row may use it. If someone reverts a row to
    // timeIn, these two calls are what they are reverting to.
    const today = timeIn(LA, "2026-08-17T18:09:00Z");
    const threeDaysAgo = timeIn(LA, "2026-08-14T18:09:00Z");

    expect(norm(today)).toBe("11:09 AM");
    expect(today).toBe(threeDaysAgo); // indistinguishable -- A2
  });

  it("is blind to the year too", () => {
    expect(timeIn(LA, "2026-08-14T18:09:00Z")).toBe(timeIn(LA, "2019-08-14T18:09:00Z"));
  });
});
