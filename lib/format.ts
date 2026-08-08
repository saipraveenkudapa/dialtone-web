import type { CallOutcome } from "@/lib/supabase/types";

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export const mmss = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export const OUTCOME_TAG: Record<CallOutcome, string> = {
  order: "tag tag-accent",
  booking: "tag tag-accent-2",
  question: "tag tag-neutral",
  transferred: "tag tag-outline",
  spam: "tag tag-neutral",
  abandoned: "tag tag-neutral",
};

/** Clock time in the location's timezone. Timestamps are stored in UTC;
 *  staff only ever think in restaurant time. */
export function timeIn(timezone: string, iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(iso));
}

export function dateIn(timezone: string, date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: timezone,
  }).format(date);
}

export function relative(iso: string, now = Date.now()) {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} d ago`;
}
