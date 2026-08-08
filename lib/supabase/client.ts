"use client";

import { createBrowserClient } from "@supabase/ssr";
import { supabaseEnv } from "./env";

let cached: ReturnType<typeof createBrowserClient> | null = null;

/** Browser client. Created lazily so a page can still render (and a build
 *  can still prerender) before the environment is configured. */
export function supabaseBrowser() {
  if (!cached) {
    const { url, anonKey } = supabaseEnv();
    cached = createBrowserClient(url, anonKey);
  }
  return cached;
}
