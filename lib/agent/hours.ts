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

  const holiday = holidays.find((h) => h.date === local.date);
  const weekday = hours.find((h) => h.day_of_week === local.dayOfWeek);

  const today = holiday
    ? {
        is_closed: holiday.is_closed,
        open_time: holiday.open_time,
        close_time: holiday.close_time,
      }
    : {
        is_closed: weekday?.is_closed ?? true,
        open_time: weekday?.open_time ?? null,
        close_time: weekday?.close_time ?? null,
      };

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
