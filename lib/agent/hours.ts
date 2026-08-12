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
    return { open_now: false, today: "closed", next_open: null as string | null };
  }

  const opens = toMinutes(today.open_time);
  const closes = toMinutes(today.close_time);
  const openNow = local.minutes >= opens && local.minutes < closes;

  return {
    open_now: openNow,
    today: `${spoken(today.open_time)} to ${spoken(today.close_time)}`,
    next_open:
      openNow || local.minutes >= closes
        ? null
        : `today at ${spoken(today.open_time)}`,
  };
}
