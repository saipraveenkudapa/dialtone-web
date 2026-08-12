/** Seats already promised during a slot.
 *
 *  A table is held for the whole slot, so any booking whose own slot
 *  overlaps this one competes for the same seats -- but two such bookings
 *  only compete with EACH OTHER if their own slots overlap one another.
 *  Two bookings that both overlap the requested slot but never coincide
 *  (one turns the table before the other sits down) never actually need
 *  the same seats at the same instant, so summing their party sizes would
 *  undercount how many tables are truly free.
 *
 *  Instead this computes peak concurrent occupancy: the largest number of
 *  seats occupied at any single instant during the requested slot. That
 *  is done with a standard sweep over each booking's start/end events --
 *  walk the events in time order, add a party when its booking starts,
 *  remove it when the booking ends, and track the running total's
 *  maximum. Bookings are half-open intervals `[start, end)`, matching the
 *  overlap test below (a table that turns over at 8:01 is free again
 *  starting at 8:01), so when a start and an end land on the exact same
 *  instant the end is applied first -- otherwise the departing party
 *  would be double-counted against the arriving one for that instant,
 *  which would overstate demand and risk refusing a bookable table. This
 *  is deliberately the only tie-break choice that cannot *undercount*:
 *  processing the arrival first would momentarily hide a genuine
 *  overlap should two events ever share a timestamp for any other
 *  reason, and understating occupancy is the one mistake this function
 *  must never make, since that is what leads to overbooking. */
export function seatsTaken(
  bookings: { requested_at: string; party_size: number }[],
  slotStart: Date,
  slotMinutes: number,
) {
  const start = slotStart.getTime();
  const end = start + slotMinutes * 60_000;

  const overlapping = bookings
    .map((booking) => {
      const bStart = new Date(booking.requested_at).getTime();
      return {
        bStart,
        bEnd: bStart + slotMinutes * 60_000,
        party: booking.party_size,
      };
    })
    .filter((b) => b.bStart < end && b.bEnd > start);

  const events = overlapping.flatMap((b) => [
    { time: b.bStart, delta: b.party },
    { time: b.bEnd, delta: -b.party },
  ]);
  // Ties at the same instant: negative deltas (departures) before
  // positive deltas (arrivals), per the half-open interval reasoning
  // above.
  events.sort((a, b) => a.time - b.time || a.delta - b.delta);

  let running = 0;
  let peak = 0;
  for (const event of events) {
    running += event.delta;
    if (running > peak) peak = running;
  }
  return peak;
}

const spokenTime = (date: Date, timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(date);

/** The location-local calendar date ("YYYY-MM-DD") a moment falls on,
 *  used only to detect when an alternative crosses midnight -- same
 *  technique `lib/agent/hours.ts` uses to reason about calendar days
 *  independent of wall-clock time. */
const localDate = (date: Date, timezone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);

/** Times to offer when the requested one is full: half an hour either
 *  side, nearest first, because that is what a host would say.
 *
 *  An offset can cross into the previous or next calendar day when the
 *  requested slot is near midnight. Speaking a bare "1:15 AM" in that
 *  case would let a caller mishear it as later tonight when it is really
 *  tomorrow morning, so any alternative that lands on a different local
 *  date than the request is qualified with a day word -- the same voice
 *  `hours.ts`'s `findNextOpen` uses ("tomorrow at 5:00 PM"). Offsets here
 *  never exceed 90 minutes, so at most one calendar boundary is crossed
 *  in either direction. */
export function nearestTimes(slotStart: Date, timezone: string, count = 2) {
  const offsets = [-30, 30, -60, 60, -90, 90];
  const requestedDate = localDate(slotStart, timezone);
  return offsets
    .slice(0, count)
    .map((minutes) => new Date(slotStart.getTime() + minutes * 60_000))
    .sort((a, b) => a.getTime() - b.getTime())
    .map((d) => {
      const spoken = spokenTime(d, timezone);
      const altDate = localDate(d, timezone);
      if (altDate === requestedDate) return spoken;
      const dayWord = altDate > requestedDate ? "tomorrow" : "yesterday";
      return `${dayWord} at ${spoken}`;
    });
}

/** True once `requestedAt` is far enough in the past that answering it
 *  makes no sense -- a caller asking about a moment already gone should
 *  never hear a confident "available". `toleranceMinutes` absorbs clock
 *  skew between the voice platform and this server, so a legitimate
 *  "book me in five minutes" request right at the boundary is not
 *  wrongly rejected. */
export function isRequestInPast(
  requestedAt: Date,
  now: Date,
  toleranceMinutes = 2,
) {
  return requestedAt.getTime() < now.getTime() - toleranceMinutes * 60_000;
}
