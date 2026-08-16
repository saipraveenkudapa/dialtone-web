/* THE HOUSE MARKER, AND IT IS NOT DECORATION HERE.
 *
 * In its old home -- a function private to app/admin/[locationId]/edit/
 * page.tsx -- this was unreachable by construction: nothing could import
 * it, so nothing could ship it to a browser. As a lib/admin/* export it
 * is importable by anything, and it reads VAPI_PRIVATE_KEY below. Every
 * other module in lib/ that touches a secret or the service role opens
 * with this line (lib/admin/data.ts, lib/admin/edit.ts, lib/admin/auth.ts,
 * lib/provisioning/go-live.ts, lib/vapi/phone-numbers.ts …) and it does
 * not arrive transitively: lib/vapi/provision.ts deliberately opts OUT of
 * it so scripts/provision-vapi.mjs can run, and says so in its own header.
 * So the guarantee has to be stated here or it does not exist. */
import "server-only";

import { currentPlatformAdmin } from "@/lib/admin/auth";
import { buildGreeting, buildSystemPrompt } from "@/lib/agent/prompt";
import { getAssistant, type VapiAssistant } from "@/lib/vapi/provision";
import type { AssistantDrift, DriftCell } from "@/components/admin/EditSections";
import type { LocationRow } from "@/lib/supabase/types";

/* ── what the phone is actually carrying ───────────────────────────────
 *
 * Moved here whole from app/admin/[locationId]/edit/page.tsx when that
 * route became a redirect and the console became one page. Every
 * function below is unchanged; only the one that reads Vapi widened its
 * parameter from EditableLocation to LocationRow, so the merged page can
 * hand it the row it already has and run this read CONCURRENTLY with the
 * two it used to wait behind.
 *
 * The types are imported from a "use client" module. That is safe and
 * deliberate: `import type` is erased before either bundle is built, so
 * no client code is pulled into this server module and no server code is
 * pulled into that one. The types belong beside the components that
 * render them.
 *
 * Read off Vapi, not off a column and not off a timestamp.
 *
 * An `assistant_synced_at` column was the obvious alternative and it is
 * the wrong one: it would still read "synced" after a rebuild that
 * half-failed, which is precisely the case this exists to catch. Asking
 * Vapi is the same principle lib/provisioning/go-live.ts's whole panel
 * rests on.
 *
 * The expected values are derived by running the REAL builders --
 * buildGreeting and buildSystemPrompt -- over the row as it stands now,
 * and then reading the same three lines out of both strings. Nothing
 * about the prompt template or the interpolation is duplicated here, so
 * a change to lib/agent/prompt.ts cannot make this report a
 * disagreement that does not exist.
 *
 * Whole-prompt equality USED to be meaningless: {{current_datetime}} and
 * {{hours_today}} were frozen at build time and always differed by the
 * next day. Neither is any more -- the date is a Liquid template Vapi
 * renders per call and the hours line is a pointer at get_hours, so the
 * prompt is now deterministic for a given location row and whole-prompt
 * equality would mean something. Widening this comparison is a separate
 * change with its own failure modes (a prompt edited on Vapi by hand
 * would start reporting drift on every line at once); it is deliberately
 * not made here. So the comparison stays per line, anchored, and a line
 * that cannot be found at all is `unknown` -- never `matches`. */

/** How long the console will wait on Vapi before it gives up and says so.
 *
 *  Short, and for the same reason the go-live panel's own read is short:
 *  a page that has not painted cannot be edited, and this check is the
 *  least urgent thing on the screen. When it times out the sections say
 *  the assistant could not be read rather than claiming the phone
 *  agrees. */
const PAGE_VAPI_TIMEOUT_MS = 5_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The assistant's system message, as Vapi is holding it. */
function systemPromptOf(assistant: VapiAssistant): string | null {
  const model = assistant.model;
  if (!isObject(model) || !Array.isArray(model.messages)) return null;
  for (const message of model.messages) {
    if (isObject(message) && message.role === "system") return stringOf(message.content);
  }
  return null;
}

/** The destination of the native transferCall tool -- the one thing that
 *  actually moves the live phone leg. app/api/agent/transfer/route.ts
 *  reads the column and only tells the model a number; this is what
 *  dials. */
function transferNumberOf(assistant: VapiAssistant): string | null {
  const model = assistant.model;
  if (!isObject(model) || !Array.isArray(model.tools)) return null;
  for (const tool of model.tools) {
    if (!isObject(tool) || tool.type !== "transferCall") continue;
    if (!Array.isArray(tool.destinations) || tool.destinations.length === 0) continue;
    const first: unknown = tool.destinations[0];
    if (isObject(first)) return stringOf(first.number);
  }
  return null;
}

/** One "Label: value" line out of a system prompt. Anchored to the start
 *  of a line, so nothing in the body of the prompt can be mistaken for
 *  the details block at its foot. */
function promptLine(prompt: string | null, label: string): string | null {
  if (prompt === null) return null;
  const prefix = `${label}: `;
  for (const line of prompt.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

function cell(onPhone: string | null, expected: string | null): DriftCell {
  // Either half missing means this screen does not know, and it says so.
  // Reporting "matches" from an absent line is the exact false comfort
  // the flag exists to prevent.
  if (onPhone === null || expected === null) return { state: "unknown", onPhone };
  return onPhone.trim() === expected.trim()
    ? { state: "matches", onPhone }
    : { state: "stale", onPhone };
}

function noDrift(state: AssistantDrift["state"]): AssistantDrift {
  const unknown: DriftCell = { state: "unknown", onPhone: null };
  return {
    state,
    greeting: unknown,
    transfer: unknown,
    name: unknown,
    address: unknown,
    orderTypes: unknown,
  };
}

export async function readAssistantDrift(location: LocationRow): Promise<AssistantDrift> {
  /* IT GATES ITSELF, like every other read in lib/admin/.
   *
   *  getAdminLocation, getEditableRecord and getAdminCall all open with
   *  this line for the same reason: a page's check protects a ROUTE, and
   *  this is a function. Its only caller today already ran the gate --
   *  app/admin/[locationId]/page.tsx awaits getAdminLocation before this
   *  goes into its Promise.all -- so in practice this costs one cached
   *  session read and changes nothing. What it buys is that the next
   *  caller cannot forget.
   *
   *  "Unreadable" and not an exception: the sections already draw one
   *  muted sentence for a drift read that could not be made, and a
   *  console that throws is a console with no kill switch on it. */
  const admin = await currentPlatformAdmin();
  if (!admin) return noDrift("unreadable");

  if (!location.vapi_assistant_id) return noDrift("no-assistant");

  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) return noDrift("unreadable");

  let assistant: VapiAssistant | null;
  try {
    assistant = await getAssistant(vapiKey, location.vapi_assistant_id, {
      timeoutMs: PAGE_VAPI_TIMEOUT_MS,
    });
  } catch {
    // A timeout, a 500, a bad key. "We could not ask" is not evidence of
    // agreement, and it is not evidence of absence either -- the sections
    // print one muted sentence and every save still works.
    return noDrift("unreadable");
  }

  // Vapi says there is no such assistant. Different from never having
  // had one, and the go-live panel's repair is the destination.
  if (!assistant) return noDrift("missing");

  // The secret is blanked before the row is handed to a builder. The
  // builders never read it and this row is never written anywhere, but a
  // hash that cannot reach a template cannot leak out of one.
  const row: LocationRow = { ...location, agent_secret_hash: null };
  const onPhone = systemPromptOf(assistant);

  // locations.timezone has no CHECK constraint, and buildSystemPrompt
  // hands it to Intl.DateTimeFormat, which throws RangeError on a zone
  // it does not know. That is precisely the dead-air bug the timezone
  // <select> in this console exists to prevent -- so it must not be able
  // to take down the one page an operator would open to FIX such a row.
  // The three prompt lines go unknown; the greeting and the transfer
  // destination need no timezone and are still compared.
  let expected: string | null = null;
  try {
    expected = buildSystemPrompt({ location: row });
  } catch {
    expected = null;
  }

  return {
    state: "read",
    greeting: cell(stringOf(assistant.firstMessage), buildGreeting(row)),
    transfer: cell(transferNumberOf(assistant), location.fallback_human_number),
    name: cell(promptLine(onPhone, "Name"), promptLine(expected, "Name")),
    address: cell(promptLine(onPhone, "Address"), promptLine(expected, "Address")),
    orderTypes: cell(
      promptLine(onPhone, "Order type available"),
      promptLine(expected, "Order type available"),
    ),
  };
}
