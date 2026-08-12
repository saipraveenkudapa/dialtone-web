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

/** How far either side of the requested time an alternative may be, in
 *  the order a host would try them: nearest first, and never more than an
 *  hour and a half away -- past that it is a different evening, not an
 *  alternative. Exported so a caller that has to fetch bookings covering
 *  every candidate (app/api/agent/availability/route.ts) can widen its
 *  window by exactly this much rather than guessing. */
export const ALTERNATIVE_OFFSETS_MINUTES = [-30, 30, -60, 60, -90, 90];
export const MAX_ALTERNATIVE_OFFSET_MINUTES = 90;

/** Times to offer when the requested one is full: half an hour either
 *  side, nearest first, because that is what a host would say -- but only
 *  the ones that would actually be taken.
 *
 *  `isOffered` is not optional, and that is the entire point. This used
 *  to be plain arithmetic: it offered `slotStart ± 30 minutes` with no
 *  capacity query, no hours check, and no past-time check, while the
 *  system prompt called the result "the nearest open times". A caller
 *  asking at 6:45 PM about 7:10 was offered "6:40 PM" -- a time
 *  `create_reservation` then refused outright as already past -- and
 *  could just as easily be offered a time the restaurant is shut or has
 *  no seats left at. Offering a time nobody checked is worse than
 *  offering none: the caller hears a promise, tries to take it, and is
 *  told no by the same agent that just made it.
 *
 *  So the decision of what is offerable belongs to the caller of this
 *  function -- it is the one holding the bookings, the hours and the
 *  clock -- and this walks the offsets in preference order and formats
 *  the first `count` that survive. Nothing here can be spoken without
 *  having been through that predicate.
 *
 *  An offset can cross into the previous or next calendar day when the
 *  requested slot is near midnight. Speaking a bare "1:15 AM" in that
 *  case would let a caller mishear it as later tonight when it is really
 *  tomorrow morning, so any alternative that lands on a different local
 *  date than the request is qualified with a day word -- the same voice
 *  `hours.ts`'s `findNextOpen` uses ("tomorrow at 5:00 PM"). Offsets here
 *  never exceed 90 minutes, so at most one calendar boundary is crossed
 *  in either direction. */
export function nearestOpenTimes({
  slotStart,
  timezone,
  isOffered,
  count = 2,
}: {
  slotStart: Date;
  timezone: string;
  isOffered: (candidate: Date) => boolean;
  count?: number;
}) {
  const requestedDate = localDate(slotStart, timezone);
  const offered: Date[] = [];

  for (const minutes of ALTERNATIVE_OFFSETS_MINUTES) {
    if (offered.length === count) break;
    const candidate = new Date(slotStart.getTime() + minutes * 60_000);
    if (isOffered(candidate)) offered.push(candidate);
  }

  // Spoken in time order regardless of which offsets survived, because
  // that is how a person reads a pair of times out loud.
  return offered
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
