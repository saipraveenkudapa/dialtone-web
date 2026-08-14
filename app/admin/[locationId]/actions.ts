"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { currentPlatformAdmin } from "@/lib/admin/auth";
import { normalizePhoneToE164 } from "@/lib/phone";
import {
  attachNumberToLocation,
  makeItLive,
  provisionNumberForLocation,
  repairAssistant,
  setFallbackNumber,
  setForwardingVerified,
  setKillSwitch,
  setLocationLive,
  type GoLiveResult,
  type MakeItLiveStep,
  type NewNumberHandover,
} from "@/lib/provisioning/go-live";

/* The operator's go-live controls, as HTTP endpoints.
 *
 * WHY EVERY ONE OF THESE RE-CHECKS AUTHORIZATION
 * ----------------------------------------------
 * A `"use server"` export is a live endpoint the moment it compiles.
 * Anyone holding its action id can POST any body to it without ever
 * loading /admin, so none of the following is a permission:
 *
 *   * app/admin/layout.tsx calling notFound() on a non-admin,
 *   * components/admin/GoLive.tsx not drawing the button,
 *   * middleware.ts, whose catch deliberately fails OPEN
 *     (NextResponse.next() on any Supabase error),
 *   * the route being unlinked from anywhere a stranger can reach.
 *
 * So the gate is the first statement of every export below, before a
 * single argument is looked at, and it is checked a second time inside
 * lib/provisioning/go-live.ts -- the module that actually holds the
 * service-role key does not get to depend on its caller having
 * remembered. That is the same posture as app/admin/new/actions.ts and
 * lib/provisioning/create-restaurant.ts, and for the same reason.
 *
 * WHAT MAY CROSS THE BROWSER BOUNDARY
 * -----------------------------------
 * As little as possible. There is no `live: boolean` parameter and no
 * `on: boolean` parameter: "go live" and "take offline" are two separate
 * exports that each write a literal, which removes any question of how a
 * caller-supplied flag gets coerced. Only two actions take a second
 * argument at all, and each is an untrusted selector rather than a
 * value:
 *
 *   * attachNumberAction takes a Vapi phone-number ID. It proves
 *     nothing. go-live.ts re-derives the attachable set for this
 *     location and refuses any id that is not in it, and the E.164
 *     string that lands in locations.twilio_number comes from Vapi's own
 *     response, never from here.
 *   * setFallbackNumberAction takes what the operator typed. It is
 *     normalized to E.164 here and refused outright if it will not
 *     normalize, so nothing but E.164 reaches the column that
 *     app/api/agent/transfer/route.ts hands to Twilio to dial.
 *
 * Nothing here accepts an org id, an assistant id, a tool secret, a
 * timestamp, an origin, or a "skip the checks" flag. `base` for the
 * assistant repair is derived from the request's own Origin header --
 * every Vapi tool's server.url is rebuilt from it, so a caller-supplied
 * value would point this restaurant's tools at somebody else's server.
 *
 * WHAT THESE ACTIONS DO NOT DO
 * ----------------------------
 * There is no release-the-number action. DELETE /phone-number is the one
 * irreversible act in this whole feature -- the number can be on a door,
 * a menu and a Google listing -- and it does not belong next to a row of
 * reversible toggles. Detaching (which go-live.ts models as attaching a
 * different number) is reversible; releasing is not.
 */

/** What the panel renders back to the operator. Narrower than
 *  GoLiveResult on purpose: the checklist the page re-renders after the
 *  revalidate below is a fresher account of what is blocking than any
 *  key list carried out of the mutation. */
export type GoLiveActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/** What the one-click run renders back.
 *
 *  Wider than GoLiveActionResult by exactly two things, and both are a
 *  record of what THIS RUN DID rather than a claim about what is
 *  currently true -- which is why they survive a boundary that
 *  deliberately drops `state` and `blockedBy`:
 *
 *    steps      the honest account of the run, including the steps it
 *               never reached. The page's re-render cannot reconstruct
 *               it, because it describes acts and not facts.
 *    newNumber  set only when this run sent POST /phone-number. It is
 *               the handover moment of the whole product, and it is set
 *               on the failure branch too: a number that now exists is
 *               the operator's most urgent fact whether or not the rest
 *               of the run landed.
 *
 *  `focus` is likewise an instruction about this run, not a fact: it
 *  names the one field on this panel that can be the answer. */
export type MakeItLiveActionResult =
  | {
      ok: true;
      message: string;
      steps: MakeItLiveStep[];
      newNumber: NewNumberHandover | null;
    }
  | {
      ok: false;
      error: string;
      steps: MakeItLiveStep[];
      newNumber: NewNumberHandover | null;
      focus: "fallback" | null;
    };

/* The RFC shape, not app/admin/[locationId]/page.tsx's old
   /^[0-9a-f-]{36}$/i -- that one accepts thirty-six dashes, which
   reaches PostgREST as a malformed uuid cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Byte-identical to app/admin/new/actions.ts and create-restaurant.ts.
   A non-admin, a malformed id and a location that does not exist all get
   this one sentence, so none of the three can be told apart. */
type Refusal = Extract<GoLiveActionResult, { ok: false }>;
const NOT_FOUND: Refusal = { ok: false, error: "Not found." };

/** The gate. Returns the refusal to hand back, or null to proceed.
 *
 *  Nothing observable happens on the refusing path: no revalidatePath,
 *  no service-role client, no Vapi request. A caller who is not staff
 *  cannot even learn that this location exists by timing the reply. */
async function refuse(locationId: string): Promise<Refusal | null> {
  const admin = await currentPlatformAdmin();
  if (!admin) return NOT_FOUND;
  if (!UUID.test(locationId)) return NOT_FOUND;
  return null;
}

/** Revalidate what actually moved, then narrow the result.
 *
 *  Deliberately runs on failure too. A mutation that reached Vapi and
 *  then failed to write the column has already changed the world, and
 *  the operator's next glance at this page must show the world rather
 *  than the render from before the click. This only ever runs for a
 *  caller the gate already admitted.
 *
 *  `portfolio` is true only for the three writes /admin actually
 *  renders. It maps is_live, kill_switch_on and forwarding_verified_at
 *  into its health badge; twilio_number and vapi_assistant_id appear
 *  nowhere on it, so revalidating the portfolio for those is noise. */
function settle(
  locationId: string,
  result: GoLiveResult,
  { portfolio }: { portfolio: boolean },
): GoLiveActionResult {
  revalidatePath(`/admin/${locationId}`);
  if (portfolio) revalidatePath("/admin");
  return result.ok
    ? { ok: true, message: result.message }
    : { ok: false, error: result.error };
}

/* ── the state of the line ─────────────────────────────────────────── */

/** Turn the assistant on. go-live.ts re-derives all three blockers from
 *  a freshly read row before it writes: the checklist the browser was
 *  looking at can be minutes old, and "we rendered it green" is not
 *  authorization. */
export async function goLiveAction(locationId: string): Promise<GoLiveActionResult> {
  const denied = await refuse(locationId);
  if (denied) return denied;

  return settle(locationId, await setLocationLive({ locationId, live: true }), {
    portfolio: true,
  });
}

/** Turn it off. No checklist, no Vapi round trip, no confirmation
 *  dialog: an operator killing a bad deployment must never be argued
 *  with, and the column alone is a real kill -- both
 *  app/api/twilio/voice/route.ts and app/api/agent/assistant/route.ts
 *  refuse on `kill_switch_on || !is_live` at call time. A Vapi outage
 *  must not be able to keep a restaurant answering. */
export async function takeOfflineAction(locationId: string): Promise<GoLiveActionResult> {
  const denied = await refuse(locationId);
  if (denied) return denied;

  return settle(locationId, await setLocationLive({ locationId, live: false }), {
    portfolio: true,
  });
}

/** Hand every call straight to a person, without taking the line down.
 *  Same one-click rule as above, for the same reason. */
export async function killSwitchOnAction(locationId: string): Promise<GoLiveActionResult> {
  const denied = await refuse(locationId);
  if (denied) return denied;

  return settle(locationId, await setKillSwitch({ locationId, on: true }), {
    portfolio: true,
  });
}

/** Give the calls back to the assistant. */
export async function killSwitchOffAction(locationId: string): Promise<GoLiveActionResult> {
  const denied = await refuse(locationId);
  if (denied) return denied;

  return settle(locationId, await setKillSwitch({ locationId, on: false }), {
    portfolio: true,
  });
}

/* ── the record of what was checked by hand ────────────────────────── */

/** Record that somebody rang the restaurant's own line and the call
 *  landed here. The timestamp is written server-side by go-live.ts; no
 *  date, no "verified by" note and no carrier string is accepted from
 *  the browser. */
export async function markForwardingVerifiedAction(
  locationId: string,
): Promise<GoLiveActionResult> {
  const denied = await refuse(locationId);
  if (denied) return denied;

  return settle(locationId, await setForwardingVerified({ locationId, verified: true }), {
    portfolio: true,
  });
}

/** Un-record it -- the carrier changed, or somebody clicked too early.
 *  Clearing a claim we can no longer stand behind is never gated. */
export async function clearForwardingVerifiedAction(
  locationId: string,
): Promise<GoLiveActionResult> {
  const denied = await refuse(locationId);
  if (denied) return denied;

  return settle(locationId, await setForwardingVerified({ locationId, verified: false }), {
    portfolio: true,
  });
}

/* ── the things a restaurant needs before it can answer ────────────── */

/** Point an existing Vapi number at this restaurant's assistant.
 *
 *  Free, instantaneous and exactly reversible -- one PATCH puts it back
 *  -- which is why this has no confirmation step and provisioning does.
 *
 *  `phoneNumberId` is a selector and nothing more. Shape-checking it
 *  here only keeps an obviously malformed value out of a Vapi path; the
 *  actual defence is in go-live.ts, which recomputes which numbers this
 *  location may claim and refuses anything else. Posting Nonna Rosa's
 *  number id from Marty's page fails on that freshly derived set. */
export async function attachNumberAction(
  locationId: string,
  phoneNumberId: string,
): Promise<GoLiveActionResult> {
  const denied = await refuse(locationId);
  if (denied) return denied;

  if (!UUID.test(phoneNumberId)) {
    // Past the gate, so this may be specific. It still names no
    // restaurant and no column.
    return { ok: false, error: "That is not a number on this account. Reload the page and pick again." };
  }

  return settle(locationId, await attachNumberToLocation({ locationId, phoneNumberId }), {
    portfolio: false,
  });
}

/** Provision a brand-new Vapi number and bind it to this restaurant's
 *  assistant in the same call.
 *
 *  The one-way door. It creates a real, dialable outside resource, it
 *  consumes the org's free-number allowance, and every call it takes
 *  bills per minute. Releasing it later returns the allowance slot but
 *  never that number -- once it is on a door, a menu or a Google
 *  listing, "reversible" stops being true in the only sense that
 *  matters. So it is its own button behind its own confirmation, and it
 *  is never a side effect of Go live.
 *
 *  The dialog in components/admin/GoLive.tsx is a misclick guard, not an
 *  authorization control: a browser that skips it proves nothing. The
 *  guards that count are the gate above, the second gate inside
 *  go-live.ts, and go-live.ts's own refusal to mint a second number when
 *  this location already has one. */
export async function provisionNumberAction(
  locationId: string,
): Promise<GoLiveActionResult> {
  const denied = await refuse(locationId);
  if (denied) return denied;

  return settle(locationId, await provisionNumberForLocation({ locationId }), {
    portfolio: false,
  });
}

/** Reconnect this record to its Vapi assistant, or build one.
 *
 *  `base` is the deployment's own origin, read off this request rather
 *  than typed by anyone. Every one of the assistant's tool URLs is
 *  rebuilt from it, so a wrong value here would leave a live restaurant
 *  with nine tools pointing at a server that does not exist -- a failure
 *  that surfaces only as the agent mysteriously refusing to take orders.
 *  go-live.ts refuses a base that is not https, or that points at
 *  localhost, on the one path where it matters -- building a new
 *  assistant. Reconnecting a record to an assistant Vapi already has
 *  needs no callback address at all and is allowed anywhere. */
export async function repairAssistantAction(
  locationId: string,
): Promise<GoLiveActionResult> {
  const denied = await refuse(locationId);
  if (denied) return denied;

  const origin = (await headers()).get("origin") ?? "";
  const base = origin.replace(/\/+$/, "");
  if (!base) {
    return {
      ok: false,
      error: "Could not work out this deployment's own address, so the assistant's tools would " +
        "have nowhere to call back to. Nothing was changed.",
    };
  }

  return settle(locationId, await repairAssistant({ locationId, base }), {
    portfolio: false,
  });
}

/** Set the number that transfers, allergy hand-offs and the kill switch
 *  all dial.
 *
 *  This is the only place in the product where it can be changed after a
 *  restaurant is created -- create-restaurant.ts writes it once and
 *  nothing else ever touches it -- which is why the checklist's "set a
 *  fallback number" is an instruction with somewhere to go.
 *
 *  Normalized here and refused outright if it will not normalize.
 *  app/api/agent/transfer/route.ts hands this column straight to Twilio,
 *  and Vapi's native transferCall 400s on anything that is not E.164, so
 *  a plausible-looking string saved as typed would surface as a
 *  transfer that silently fails on a live call. */
export async function setFallbackNumberAction(
  locationId: string,
  raw: string,
): Promise<GoLiveActionResult> {
  const denied = await refuse(locationId);
  if (denied) return denied;

  // Never logged, here or anywhere below: this is somebody's personal
  // number.
  const number = normalizePhoneToE164(raw);
  if (!number) {
    return {
      ok: false,
      error: "That does not look like a phone number. Use a 10-digit US number, or a full " +
        "number with its country code.",
    };
  }

  return settle(locationId, await setFallbackNumber({ locationId, number }), {
    portfolio: false,
  });
}

/* ── one click ─────────────────────────────────────────────────────── */

/** Turn a restaurant on, doing every step a machine may do by itself.
 *
 *  The paved road, not the only road. Every per-blocker control above
 *  stays: an operator debugging a half-broken restaurant still needs to
 *  repair just the assistant, or attach just a number, and this one
 *  button is a worse tool for that than the specific ones.
 *
 *  Same argument surface as every action here: one location id, and
 *  nothing else. No number id, no assistant id, no "skip the checks"
 *  flag. `base` is the deployment's own origin off this request -- every
 *  Vapi tool's server.url is rebuilt from it on the one path that builds
 *  an assistant, so a caller-supplied value would point this
 *  restaurant's tools at somebody else's server. go-live.ts checks the
 *  caller again, and re-reads every other value it acts on.
 *
 *  This CAN provision a number, which is the one act in the feature with
 *  no undo -- but only after it has proved reuse is impossible from a
 *  freshly derived account state, and only after every cheaper step has
 *  been tried. The confirmation that guards the standalone provision
 *  button is a misclick guard on a button whose ONLY act is to spend;
 *  this button's job is to get a restaurant answering the phone, and its
 *  real guard is go-live.ts's refusal to mint while any number can be
 *  reused. */
export async function makeItLiveAction(locationId: string): Promise<MakeItLiveActionResult> {
  const denied = await refuse(locationId);
  if (denied) {
    // The gate's own sentence, in this action's shape. Nothing
    // observable has happened: no revalidate, no read, no Vapi request.
    return { ...denied, steps: [], newNumber: null, focus: null };
  }

  const origin = (await headers()).get("origin") ?? "";
  const base = origin.replace(/\/+$/, "");
  if (!base) {
    return {
      ok: false,
      error: "Could not work out this deployment's own address, so the assistant's tools would " +
        "have nowhere to call back to. Nothing was changed.",
      steps: [],
      newNumber: null,
      focus: null,
    };
  }

  const result = await makeItLive({ locationId, base });

  // Both paths, on failure too, for the reason settle()'s comment gives:
  // a run that reached Vapi and then failed has already changed the
  // world. `/admin` as well, because this one can write is_live, which
  // the portfolio's health badge reads.
  revalidatePath(`/admin/${locationId}`);
  revalidatePath("/admin");

  // `state` and `blockedBy` are dropped here on purpose: the checklist
  // the page re-renders after the revalidate above is a fresher account
  // of what is blocking than any list carried out of the mutation. That
  // is the same reason GoLiveActionResult already narrows blockedBy away.
  return result.ok
    ? {
        ok: true,
        message: result.message,
        steps: result.steps,
        newNumber: result.newNumber,
      }
    : {
        ok: false,
        error: result.error,
        steps: result.steps,
        newNumber: result.newNumber,
        focus: result.focus,
      };
}
