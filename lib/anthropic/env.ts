/* Reading the Anthropic config in one place, so a missing key fails with
   a sentence a human can act on instead of a 401 from a library three
   frames deep. Same shape and same reason as lib/supabase/env.ts.

   ANTHROPIC_API_KEY is server-side only. It has no NEXT_PUBLIC_ twin and
   must never grow one: a model key in the browser bundle is a key anyone
   can spend. `anthropicClient()` below is marked `server-only`, which
   turns a stray import from a client component into a build error rather
   than a leaked key. */

export function anthropicEnv() {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error(
      "Reading a menu is not configured. Set ANTHROPIC_API_KEY in .env.local " +
        "(console.anthropic.com -> API keys), and in the Vercel project's " +
        "environment variables for the deployed app. It is a server-side " +
        "secret: never give it a NEXT_PUBLIC_ prefix.",
    );
  }

  return { apiKey };
}

/** Whether a menu can be read at all right now. Lets a screen say "menu
 *  reading is switched off" instead of offering a button that throws. */
export function anthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
