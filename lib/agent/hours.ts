export type HoursRow = {
  day_of_week: number;
  open_time: string | null;
  close_time: string | null;
  is_closed: boolean;
};

export type HolidayRow = {
  date: string;
  is_closed: boolean;
  open_time: string | null;
  close_time: string | null;
};

/** Wall-clock parts of `now` in the location's timezone. Doing this with
 *  Intl rather than date maths keeps it correct across DST, which matters
 *  because "are you open" is asked most on the evenings that shift. */
function localParts(now: Date, timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    dayOfWeek: days.indexOf(parts.weekday as string),
  };
}

const toMinutes = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};

const spoken = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
};

const dayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Adds whole calendar days to a "YYYY-MM-DD" date string. This is plain
 *  Gregorian calendar arithmetic on a date-only value, not wall-clock math,
 *  so it stays correct regardless of the location's DST transitions —
 *  Date.UTC is used purely as a neutral, DST-free calendar, never as an
 *  instant tied to any timezone. */
function addCalendarDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  const yyyy = next.getUTCFullYear();
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(next.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Day-of-week (0=Sun..6=Sat) for a "YYYY-MM-DD" date string, again using
 *  Date.UTC only as a calendar, not a timezone-bound instant. */
function calendarDayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Once today has no more opening left (already closed for the day, or
 *  closed entirely), search forward through the coming week — honouring
 *  holiday overrides and closed weekdays — for the next day the location
 *  opens. Returns a spoken phrase ("tomorrow at 5:00 PM", "Friday at 5:00
 *  PM") or null if nothing opens in the next 7 days. */
function findNextOpen(
  fromDate: string,
  hours: HoursRow[],
  holidays: HolidayRow[],
): string | null {
  for (let offset = 1; offset <= 7; offset++) {
    const date = addCalendarDays(fromDate, offset);
    const dayOfWeek = calendarDayOfWeek(date);
    const holiday = holidays.find((h) => h.date === date);
    const weekday = hours.find((h) => h.day_of_week === dayOfWeek);

    const isClosed = holiday ? holiday.is_closed : (weekday?.is_closed ?? true);
    const openTime = holiday ? holiday.open_time : (weekday?.open_time ?? null);

    if (!isClosed && openTime) {
      const label = offset === 1 ? "tomorrow" : dayNames[dayOfWeek];
      return `${label} at ${spoken(openTime)}`;
    }
  }
  return null;
}

/** The hours that apply on one local calendar date: the holiday override
 *  if there is one for that date, otherwise the weekday row, otherwise
 *  closed. A missing weekday row means closed on purpose -- a location
 *  that is shut on Mondays simply has no Monday row -- which is why the
 *  "we have no idea" case is decided by the caller (`openAt` below), not
 *  here. */
function hoursOnDate(
  date: string,
  dayOfWeek: number,
  hours: HoursRow[],
  holidays: HolidayRow[],
) {
  const holiday = holidays.find((h) => h.date === date);
  if (holiday) {
    return {
      is_closed: holiday.is_closed,
      open_time: holiday.open_time,
      close_time: holiday.close_time,
      source: "holiday" as const,
    };
  }
  const weekday = hours.find((h) => h.day_of_week === dayOfWeek);
  return {
    is_closed: weekday?.is_closed ?? true,
    open_time: weekday?.open_time ?? null,
    close_time: weekday?.close_time ?? null,
    source: weekday ? ("weekday" as const) : ("missing" as const),
  };
}

/** Is the location open at one particular instant?
 *
 *  Nothing on the booking or ordering path consulted the hours at all:
 *  `book_table`, `place_order`, and both routes in front of them would
 *  take, write, and confirm a 3 AM table or a 3 AM order, and the only
 *  thing standing in the way was a line of prose in the system prompt
 *  telling the model to check. This is what the routes can call instead.
 *
 *  Three states, not two, and the third is the important one. `openState`
 *  below answers "are you open right now" for a caller who asked, where
 *  guessing "closed" when the data cannot say is a harmless, visible
 *  wrong answer. Here the answer *refuses a booking or an order*, so the
 *  same guess would silently turn a data-representation problem into a
 *  restaurant that can never take one:
 *
 *   - a location whose hours cross midnight (open 22:00, close 02:00)
 *     cannot be represented at all -- see the known gap in
 *     docs/vapi-setup.md -- and `close <= open` reads as closed at every
 *     minute of every day. A late-night kitchen is exactly the kind that
 *     lives on phone orders, and refusing all of them, forever, silently,
 *     is far worse than the 3 AM order this check exists to stop;
 *   - a location that has never had its hours filled in has nothing to
 *     check against, and refusing every booking because a setup step was
 *     skipped is a worse failure than allowing one.
 *
 *  Both come back `unknown`, and the routes let an unknown through. This
 *  check can only refuse what the hours table can actually express. */
export type OpenAtVerdict =
  | { state: "open"; hoursThatDay: string }
  | { state: "closed"; hoursThatDay: string }
  | { state: "unknown"; reason: "no_hours_configured" | "crosses_midnight" };

export function openAt({
  at,
  timezone,
  hours,
  holidays,
}: {
  at: Date;
  timezone: string;
  hours: HoursRow[];
  holidays: HolidayRow[];
}): OpenAtVerdict {
  const local = localParts(at, timezone);
  const day = hoursOnDate(local.date, local.dayOfWeek, hours, holidays);

  // Nothing configured anywhere: no weekday row for this day AND no
  // weekday rows at all. A location with a Tuesday row and no Monday row
  // is closed on Mondays, which is a real answer; a location with no rows
  // at all has simply never been set up.
  if (day.source === "missing" && hours.length === 0) {
    return { state: "unknown", reason: "no_hours_configured" };
  }

  if (day.is_closed) return { state: "closed", hoursThatDay: "closed" };

  // An open day with a missing end (only reachable through a holiday
  // override -- the hours table's own check constraint forbids it) says
  // nothing about when.
  if (!day.open_time || !day.close_time) {
    return { state: "unknown", reason: "no_hours_configured" };
  }

  const opens = toMinutes(day.open_time);
  const closes = toMinutes(day.close_time);
  if (closes <= opens) return { state: "unknown", reason: "crosses_midnight" };

  const hoursThatDay = `${spoken(day.open_time)} to ${spoken(day.close_time)}`;
  return local.minutes >= opens && local.minutes < closes
    ? { state: "open", hoursThatDay }
    : { state: "closed", hoursThatDay };
}

export function openState({
  now,
  timezone,
  hours,
  holidays,
}: {
  now: Date;
  timezone: string;
  hours: HoursRow[];
  holidays: HolidayRow[];
}) {
  const local = localParts(now, timezone);

  const today = hoursOnDate(local.date, local.dayOfWeek, hours, holidays);

  if (today.is_closed || !today.open_time || !today.close_time) {
    return {
      open_now: false,
      today: "closed",
      next_open: findNextOpen(local.date, hours, holidays),
    };
  }

  const opens = toMinutes(today.open_time);
  const closes = toMinutes(today.close_time);
  const openNow = local.minutes >= opens && local.minutes < closes;

  return {
    open_now: openNow,
    today: `${spoken(today.open_time)} to ${spoken(today.close_time)}`,
    next_open: openNow
      ? null
      : local.minutes < opens
        ? `today at ${spoken(today.open_time)}`
        : findNextOpen(local.date, hours, holidays),
  };
}
