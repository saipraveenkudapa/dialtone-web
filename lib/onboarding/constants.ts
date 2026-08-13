/* Shared between app/onboarding/actions.ts and the hours step's UI.
 * Lives here rather than in actions.ts because a "use server" file may
 * only export async functions -- a plain const array export from one
 * fails the build. */

// day_of_week convention: 0 = Sunday .. 6 = Saturday, matching the
// `hours` table (supabase/migrations/20260807000100_schema.sql) and
// lib/agent/hours.ts.
export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
