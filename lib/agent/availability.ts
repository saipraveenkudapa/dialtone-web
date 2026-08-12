/** Seats already promised during a slot.
 *
 *  A table is held for the whole slot, so any booking whose own slot
 *  overlaps this one competes for the same seats. */
export function seatsTaken(
  bookings: { requested_at: string; party_size: number }[],
  slotStart: Date,
  slotMinutes: number,
) {
  const start = slotStart.getTime();
  const end = start + slotMinutes * 60_000;

  return bookings.reduce((total, booking) => {
    const bStart = new Date(booking.requested_at).getTime();
    const bEnd = bStart + slotMinutes * 60_000;
    const overlaps = bStart < end && bEnd > start;
    return overlaps ? total + booking.party_size : total;
  }, 0);
}

const spokenTime = (date: Date, timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(date);

/** Times to offer when the requested one is full: half an hour either
 *  side, nearest first, because that is what a host would say. */
export function nearestTimes(slotStart: Date, timezone: string, count = 2) {
  const offsets = [-30, 30, -60, 60, -90, 90];
  return offsets
    .slice(0, count)
    .map((minutes) => new Date(slotStart.getTime() + minutes * 60_000))
    .sort((a, b) => a.getTime() - b.getTime())
    .map((d) => spokenTime(d, timezone));
}
