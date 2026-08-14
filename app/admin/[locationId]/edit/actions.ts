"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { currentPlatformAdmin } from "@/lib/admin/auth";
import {
  createMenuCategory,
  createMenuItem,
  deleteHoliday,
  deleteMenuCategory,
  deleteMenuItem,
  isUuid,
  resyncAssistant,
  saveAnswering,
  saveBusiness,
  saveHoliday,
  saveHours,
  saveMenuCategory,
  saveMenuItem,
  saveOrderRouting,
  saveRecording,
  saveService,
  setMenuItemSoldOut,
  type EditResult,
} from "@/lib/admin/edit";
import type { DraftHours } from "@/lib/provisioning/draft";

/* The record editor's controls, as HTTP endpoints.
 *
 * WHY EVERY ONE OF THESE RE-CHECKS AUTHORIZATION
 * ----------------------------------------------
 * A `"use server"` export is a live endpoint the moment it compiles.
 * Anyone holding its action id can POST any body to it without ever
 * loading /admin, so none of the following is a permission:
 *
 *   * app/admin/layout.tsx calling notFound() on a non-admin,
 *   * this route not being linked from anywhere a stranger can reach,
 *   * components/admin/EditSections.tsx disabling a Save button,
 *   * middleware.ts, whose catch deliberately fails OPEN.
 *
 * So `gate()` is the first statement of every export below, before a
 * single argument is looked at, and lib/admin/edit.ts checks it AGAIN
 * before it touches the service-role key -- the module that bypasses
 * RLS on every table for every tenant does not get to depend on its
 * caller having remembered. Same posture as
 * app/admin/[locationId]/actions.ts and lib/provisioning/create-restaurant.ts.
 *
 * WHAT MAY CROSS THE BROWSER BOUNDARY
 * -----------------------------------
 * Content, and selectors. Never an authorization.
 *
 *   * locationId is the only id that decides WHOSE data is touched. It
 *     is uuid-shape-checked here and again in lib/admin/edit.ts before
 *     it reaches PostgREST.
 *   * every child row id -- a holiday, a menu category, a menu item --
 *     is a selector and proves nothing. lib/admin/edit.ts proves each
 *     one belongs to this location with a read filtered on location_id
 *     before it writes, and filters the write on it too. menu_items'
 *     category_id is the sharpest of them: the
 *     app.sync_menu_item_location trigger re-derives an item's
 *     location_id FROM ITS CATEGORY, so an unchecked move does not fail,
 *     it silently hands the dish to another tenant.
 *   * No org id, user id, membership, assistant id, tool secret, twilio
 *     number, timestamp or is_live flag is accepted, here or anywhere
 *     downstream. The organization is found through the location's own
 *     org_id, server-side.
 *   * the request's Origin is passed through as `base`, and it is
 *     CHECKED against this deployment's own configured address rather
 *     than used as it. Every one of the assistant's nine tool URLs is
 *     rebuilt on a re-sync, so a rebuild driven from a preview build or
 *     an old domain would repoint a live restaurant's tools at a server
 *     that is not serving it. lib/admin/edit.ts's configuredOrigin() is
 *     the authority; a mismatch refuses the push and names both
 *     addresses.
 *   * `seenUpdatedAt` -- locations.updated_at as the form was rendered
 *     from -- is a concurrency token, not an authorization. The write
 *     carries it as a filter, so a tab opened before somebody else
 *     changed this restaurant cannot put their change back.
 *
 * WHY EVERY INPUT IS REBUILT FIELD BY FIELD
 * -----------------------------------------
 * The `*Input` types below describe what the form sends, not what an
 * endpoint receives. A hand-rolled POST can carry a number where a
 * string is declared (`.trim()` on it is a TypeError, i.e. a 500 rather
 * than a sentence) or thirty extra keys. So each action reconstructs its
 * input from named fields through `str`/`bool`, which means exactly the
 * declared columns can be reached and an odd body gets the validator's
 * own refusal instead of a stack trace.
 *
 * WHAT IS NOT HERE
 * ----------------
 * Nothing that writes twilio_number, twilio_number_sid, is_live,
 * kill_switch_on, forwarding_verified_at, vapi_assistant_id,
 * agent_secret_hash, onboarding_step or stripe_customer_id. Those are
 * the go-live panel's, and a text box for twilio_number is a typo that
 * silently points a restaurant's calls at nothing. The editor shows them
 * as facts and links across.
 */

/* Byte-identical to app/admin/[locationId]/actions.ts, app/admin/new/actions.ts
   and lib/admin/edit.ts. A non-admin, a malformed id and a location that
   does not exist all get this one sentence, so none of the three can be
   told apart by anyone probing. */
const NOT_FOUND: EditResult = { ok: false, error: "Not found." };

/** The gate. Returns the refusal to hand back, or null to proceed.
 *
 *  Nothing observable happens on the refusing path: no revalidatePath,
 *  no service-role client, no Vapi request, no log line. A caller who is
 *  not staff cannot learn that this location exists by timing the
 *  reply. */
async function gate(locationId: string): Promise<EditResult | null> {
  const admin = await currentPlatformAdmin();
  if (!admin) return NOT_FOUND;
  if (typeof locationId !== "string" || !isUuid(locationId)) return NOT_FOUND;
  return null;
}

/** The origin the console is open on, off the request.
 *
 *  NOT the address anything is rebuilt from. lib/admin/edit.ts takes
 *  that from server-side configuration and compares this against it, so
 *  a save made from a preview deployment or an old domain refuses the
 *  push with a sentence naming both addresses rather than quietly
 *  pointing a live restaurant's nine tools at the wrong server. "" means
 *  the header was absent, which skips the comparison; the configured
 *  address is used either way. */
async function requestOrigin(): Promise<string> {
  return ((await headers()).get("origin") ?? "").replace(/\/+$/, "");
}

/** locations.updated_at as the client was rendered from, rebuilt as a
 *  string like every other field. Anything else -- a number, an object,
 *  a missing key -- becomes "", which lib/admin/edit.ts refuses as a
 *  stale form rather than writing without the guard. */
function token(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Revalidate what actually moved, then hand the result back untouched.
 *
 *  Untouched matters: EditResult carries `phone`, and `phone` is the
 *  only authority on whether the assistant agrees with the screen. A
 *  narrowing wrapper that dropped it -- the way the go-live panel's
 *  settle() narrows blockedBy away -- would turn "saved, and the phone
 *  is still on the old number" into a plain success.
 *
 *  Runs on failure too, for the same reason go-live.ts's does: a
 *  mutation that wrote Postgres and then failed at Vapi has already
 *  changed the world, and the operator's next glance must show the
 *  world rather than the render from before the click. It only ever
 *  runs for a caller the gate already admitted.
 *
 *  `portfolio` is true only for the one section /admin actually renders:
 *  it lists locations.name and organizations.name and nothing else this
 *  editor touches.
 *
 *  A refused save re-renders with identical props, so the operator's
 *  typed text survives -- the sections re-seed only when the value on
 *  the server has actually moved. */
function settle(
  locationId: string,
  result: EditResult,
  { portfolio = false }: { portfolio?: boolean } = {},
): EditResult {
  revalidatePath(`/admin/${locationId}/edit`);
  revalidatePath(`/admin/${locationId}`);
  if (portfolio) revalidatePath("/admin");
  return result;
}

/* ── rebuilding an untrusted body into a declared input ────────────── */

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function bool(value: unknown): boolean {
  return value === true;
}

/* A child row id -- an hours row, a holiday, a category, a menu item.
   It is a SELECTOR and it proves nothing: lib/admin/edit.ts proves every
   one of them belongs to this location with a read filtered on
   location_id BEFORE it writes, and carries the same filter on the write.
   Refusing a malformed one here only keeps it out of a code path that
   would otherwise start doing work, and gives it the same sentence a
   real stranger's id gets, so the two cannot be told apart. */
const NO_SUCH_ROW: EditResult = {
  ok: false,
  error: "That is not on this restaurant's record any more. Reload the page.",
};

function badSelector(id: unknown): boolean {
  return typeof id !== "string" || !isUuid(id);
}

/* ── 1. the business ───────────────────────────────────────────────── */

/** Name, timezone, address, display phone, carrier, and the
 *  organization's own name and plan.
 *
 *  Three of these -- name, timezone, address -- are baked into the Vapi
 *  assistant's system prompt, so this save can rebuild it. lib/admin/edit.ts
 *  diffs against the row first, so re-submitting them unchanged pushes
 *  nothing and does not rotate the tool secret. */
export async function saveBusinessAction(
  locationId: string,
  input: {
    orgName: string;
    plan: string;
    name: string;
    timezone: string;
    address: string;
    businessPhone: string;
    carrierName: string;
  },
  seenUpdatedAt: string,
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const result = await saveBusiness({
    locationId,
    input: {
      orgName: str(input?.orgName),
      plan: str(input?.plan),
      name: str(input?.name),
      timezone: str(input?.timezone),
      address: str(input?.address),
      businessPhone: str(input?.businessPhone),
      carrierName: str(input?.carrierName),
    },
    base: await requestOrigin(),
    seenUpdatedAt: token(seenUpdatedAt),
  });

  // The only section whose columns /admin itself renders.
  return settle(locationId, result, { portfolio: true });
}

/* ── 2. answering the phone ────────────────────────────────────────── */

/** The greeting and the transfer destination. Both are baked into the
 *  assistant, so either one moving rebuilds it.
 *
 *  The fallback number is the highest-stakes field in the editor: the
 *  column is what app/api/agent/transfer/route.ts tells the model, but
 *  the BAKED copy is what Vapi's own transferCall actually dials. Saved
 *  without a rebuild, the agent says "one moment" and the call moves to
 *  the old number with nothing reporting an error. */
export async function saveAnsweringAction(
  locationId: string,
  input: { greetingText: string; fallbackNumber: string },
  seenUpdatedAt: string,
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  return settle(
    locationId,
    await saveAnswering({
      locationId,
      input: {
        greetingText: str(input?.greetingText),
        fallbackNumber: str(input?.fallbackNumber),
      },
      base: await requestOrigin(),
      seenUpdatedAt: token(seenUpdatedAt),
    }),
  );
}

/* ── 3. money & service ────────────────────────────────────────────── */

/** Tax, order types, promise times, seats, party size, slot length.
 *
 *  Six of the seven are read out of Postgres inside the call and land on
 *  the next one. order_types is the exception: it is enforced live AND
 *  baked into the prompt's "Order type available" line, so it rebuilds. */
export async function saveServiceAction(
  locationId: string,
  input: {
    taxPercent: string;
    orderTypes: string;
    pickupPromiseMinutes: string;
    deliveryPromiseMinutes: string;
    seats: string;
    maxPartySize: string;
    reservationSlotMinutes: string;
  },
  seenUpdatedAt: string,
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  return settle(
    locationId,
    await saveService({
      locationId,
      input: {
        taxPercent: str(input?.taxPercent),
        orderTypes: str(input?.orderTypes),
        pickupPromiseMinutes: str(input?.pickupPromiseMinutes),
        deliveryPromiseMinutes: str(input?.deliveryPromiseMinutes),
        seats: str(input?.seats),
        maxPartySize: str(input?.maxPartySize),
        reservationSlotMinutes: str(input?.reservationSlotMinutes),
      },
      base: await requestOrigin(),
      seenUpdatedAt: token(seenUpdatedAt),
    }),
  );
}

/* ── 4. where orders go ────────────────────────────────────────────── */

/** The kitchen ticket's destination. Nothing baked, nothing to push. */
export async function saveOrderRoutingAction(
  locationId: string,
  input: { orderDelivery: string; orderSmsTo: string; orderEmailTo: string },
  seenUpdatedAt: string,
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  return settle(
    locationId,
    await saveOrderRouting({
      locationId,
      input: {
        orderDelivery: str(input?.orderDelivery),
        orderSmsTo: str(input?.orderSmsTo),
        orderEmailTo: str(input?.orderEmailTo),
      },
      seenUpdatedAt: token(seenUpdatedAt),
    }),
  );
}

/* ── 5. recording & retention ──────────────────────────────────────── */

export async function saveRecordingAction(
  locationId: string,
  input: { recordingEnabled: boolean; recordingRetentionDays: string },
  seenUpdatedAt: string,
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  return settle(
    locationId,
    await saveRecording({
      locationId,
      input: {
        recordingEnabled: bool(input?.recordingEnabled),
        recordingRetentionDays: str(input?.recordingRetentionDays),
      },
      seenUpdatedAt: token(seenUpdatedAt),
    }),
  );
}

/* ── 6. hours ──────────────────────────────────────────────────────── */

/** All seven days, in one upsert. No rebuild: the prompt's frozen "Hours
 *  today" line is one the model is ordered not to trust, and
 *  app/api/agent/hours/route.ts queries Postgres -- with holiday_hours --
 *  on every call.
 *
 *  Exported from here rather than from a section of its own because this
 *  is the action layer for the whole /edit route; the hours card is free
 *  to live in its own component. */
export async function saveHoursAction(
  locationId: string,
  rows: DraftHours[],
  /** hoursSignature() of the week this grid was rendered from. The
   *  upsert replaces all seven rows, so it may only replace the week the
   *  operator was actually looking at. */
  seenSignature: string,
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  // Sliced before mapping so a hand-rolled body cannot make this walk a
  // million rows; validateHours refuses anything that is not exactly
  // seven, in its own sentence.
  const input: DraftHours[] = Array.isArray(rows)
    ? rows.slice(0, 14).map((row) => ({
        dayOfWeek: Number(row?.dayOfWeek),
        closed: bool(row?.closed),
        open: str(row?.open),
        close: str(row?.close),
      }))
    : [];

  return settle(
    locationId,
    await saveHours({ locationId, input, seenSignature: token(seenSignature) }),
  );
}

/* ── 7. holidays ───────────────────────────────────────────────────── */

/** Add or edit one date's override. `holidayId` is null to add.
 *
 *  Per row rather than per section: Thanksgiving and a private party in
 *  March are independent facts, and one bad date must not block the
 *  other. */
export async function saveHolidayAction(
  locationId: string,
  holidayId: string | null,
  input: { date: string; closed: boolean; open: string; close: string },
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  // A selector, and it proves nothing: lib/admin/edit.ts reads the row
  // filtered on location_id before it writes, and filters the write too.
  // Anything that is not a uuid is refused here rather than reaching
  // PostgREST as a malformed cast.
  const id = typeof holidayId === "string" && holidayId !== "" ? holidayId : null;
  if (id !== null && badSelector(id)) return NO_SUCH_ROW;

  return settle(
    locationId,
    await saveHoliday({
      locationId,
      holidayId: id,
      input: {
        date: str(input?.date),
        closed: bool(input?.closed),
        open: str(input?.open),
        close: str(input?.close),
      },
    }),
  );
}

export async function deleteHolidayAction(
  locationId: string,
  holidayId: string,
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  if (badSelector(holidayId)) return NO_SUCH_ROW;

  return settle(locationId, await deleteHoliday({ locationId, holidayId }));
}

/* ── 8. the menu ───────────────────────────────────────────────────── */

/* The live-read exception, and the product's central promise.
   app/api/agent/menu/route.ts queries Postgres on every call and is
   never cached into the prompt, and public.place_order re-reads the
   price and the sold-out state in the same statement that builds the
   line. So a price saved here is what the agent quotes on the very next
   call, and nothing in this block pushes anything to Vapi.

   category_id is the sharpest selector in the file. The
   app.sync_menu_item_location trigger re-derives an item's location_id
   FROM ITS CATEGORY, so an item posted with another restaurant's
   category id does not fail -- it silently becomes that restaurant's
   item. lib/admin/edit.ts proves the target category belongs to this
   location, server-side, on every single item write. */

export async function createMenuCategoryAction(
  locationId: string,
  input: { name: string; sortOrder: string },
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  return settle(
    locationId,
    await createMenuCategory({
      locationId,
      input: { name: str(input?.name), sortOrder: str(input?.sortOrder) },
    }),
  );
}

export async function saveMenuCategoryAction(
  locationId: string,
  categoryId: string,
  input: { name: string; sortOrder: string },
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;
  if (badSelector(categoryId)) return NO_SUCH_ROW;

  return settle(
    locationId,
    await saveMenuCategory({
      locationId,
      categoryId,
      input: { name: str(input?.name), sortOrder: str(input?.sortOrder) },
    }),
  );
}

/** Removing a category takes its items with it -- menu_items.category_id
 *  is `on delete cascade`. lib/admin/edit.ts's sentence says so. */
export async function deleteMenuCategoryAction(
  locationId: string,
  categoryId: string,
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;
  if (badSelector(categoryId)) return NO_SUCH_ROW;

  return settle(locationId, await deleteMenuCategory({ locationId, categoryId }));
}

/** Rebuilt field by field, so the only thing that can reach the write is
 *  the seven declared columns -- no location_id, no id, and nothing an
 *  extra key in the body could smuggle into the patch. */
function menuItemInput(input: {
  categoryId: string;
  name: string;
  description: string;
  priceDollars: string;
  allergenNote: string;
  sortOrder: string;
  soldOutUntil: string;
}) {
  return {
    categoryId: str(input?.categoryId),
    name: str(input?.name),
    description: str(input?.description),
    priceDollars: str(input?.priceDollars),
    allergenNote: str(input?.allergenNote),
    sortOrder: str(input?.sortOrder),
    soldOutUntil: str(input?.soldOutUntil),
  };
}

export async function createMenuItemAction(
  locationId: string,
  input: {
    categoryId: string;
    name: string;
    description: string;
    priceDollars: string;
    allergenNote: string;
    sortOrder: string;
    soldOutUntil: string;
  },
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  return settle(locationId, await createMenuItem({ locationId, input: menuItemInput(input) }));
}

export async function saveMenuItemAction(
  locationId: string,
  itemId: string,
  input: {
    categoryId: string;
    name: string;
    description: string;
    priceDollars: string;
    allergenNote: string;
    sortOrder: string;
    soldOutUntil: string;
  },
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;
  if (badSelector(itemId)) return NO_SUCH_ROW;

  return settle(
    locationId,
    await saveMenuItem({ locationId, itemId, input: menuItemInput(input) }),
  );
}

export async function deleteMenuItemAction(
  locationId: string,
  itemId: string,
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;
  if (badSelector(itemId)) return NO_SUCH_ROW;

  return settle(locationId, await deleteMenuItem({ locationId, itemId }));
}

/** The fastest-moving field on the record: the kitchen runs out of
 *  branzino at seven and the agent has to stop selling it on the next
 *  call. Neither value expires on its own -- there is no job that clears
 *  'reopen' or 'close' -- so a human has to put it back on sale. */
export async function setMenuItemSoldOutAction(
  locationId: string,
  itemId: string,
  /** "" puts it back on sale. */
  until: string,
): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;
  if (badSelector(itemId)) return NO_SUCH_ROW;

  return settle(locationId, await setMenuItemSoldOut({ locationId, itemId, until: str(until) }));
}

/* ── pushing an edit that did not push ─────────────────────────────── */

/** "Update the phone". The retry behind a failed re-sync, with nothing
 *  to retype.
 *
 *  Writes no column: it rebuilds the assistant from the row exactly as
 *  it stands, which makes it safe to press twice. It is NOT the go-live
 *  panel's Repair assistant -- that one deliberately pushes nothing when
 *  the record already points at the assistant Vapi has, which is the
 *  state a stale-prompt restaurant is always in.
 *
 *  Alone among these, a failed push here comes back ok:false, because
 *  nothing else happened. */
export async function resyncAssistantAction(locationId: string): Promise<EditResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  // The address a rebuild uses is lib/admin/edit.ts's configuredOrigin(),
  // never this one; this is only the console's own origin, for the
  // mismatch check there. An absent header is not a refusal here because
  // it is not the value anything is built from.
  return settle(locationId, await resyncAssistant({ locationId, base: await requestOrigin() }));
}
