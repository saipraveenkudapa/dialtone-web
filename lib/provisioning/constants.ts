/* Shared between lib/provisioning/draft.ts and the operator form's UI.
 * Lives in its own module rather than in the server action because a
 * "use server" file may only export async functions -- a plain const
 * array export from one fails the build. */

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
