import "server-only";

import { currentPlatformAdmin } from "@/lib/admin/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { dialableNumber, normalizePhoneToE164 } from "@/lib/phone";
import {
  AssistantSecretWriteError,
  provisionAssistantForLocation,
} from "@/lib/provisioning/assistant";
import {
  ProvisioningError,
  deleteAssistant,
  findAssistantForLocation,
  getAssistant,
  tagAssistantForLocation,
} from "@/lib/vapi/provision";
import {
  AREA_CODE_REFUSAL,
  NoNumberInAreaCodeError,
  NumberOutcomeUnknownError,
  areaCodeOf,
  bindPhoneNumber,
  createPhoneNumber,
  isAreaCode,
  listPhoneNumbers,
  type VapiPhoneNumber,
} from "@/lib/vapi/phone-numbers";
import type { HoursRow } from "@/lib/agent/hours";
import type { LocationRow } from "@/lib/supabase/types";

/* Whether a restaurant can answer the phone, and the writes that change
 * the answer.
 *
 * WHAT "LIVE" MEANS HERE
 * ---------------------
 * Three things must be true before is_live can be turned on, and each of
 * them is a thing a caller would notice if it were false:
 *
 *   assistant  vapi_assistant_id is set AND Vapi still has that
 *              assistant. The column on its own has already proved it
 *              can drift -- the one live restaurant on this platform
 *              has an assistant on Vapi and a null column.
 *   number     twilio_number is set AND a Vapi phone-number record for
 *              that number is pointed at this restaurant's assistant. A
 *              number in the column that Vapi points somewhere else is a
 *              caller reaching the wrong restaurant.
 *   fallback   fallback_human_number is set. Transfers, allergy
 *              hand-offs and the kill switch all dial it; live without
 *              one means a caller asking about a nut allergy hits dead
 *              air.
 *
 * Three more are shown and never block, because each is a worse product
 * rather than a broken one: an empty menu (the agent can still answer
 * hours and take a message), no hours, and unproven call forwarding.
 *
 * Forwarding is the interesting one. It only means anything when
 * business_phone is set -- that is the restaurant's own line being
 * forwarded to us, and somebody has to ring it once to prove the carrier
 * did what it was told. A restaurant that simply publishes the Dialtone
 * number forwards nothing, so for it the check is "na", not a warning.
 * lib/admin/data.ts's portfolio health carries the same rule, for the
 * same reason.
 *
 * Turning live OFF is none of that: no checklist, no Vapi round trip.
 * An operator killing a bad deployment must never be argued with, and a
 * Vapi outage must never be the reason a restaurant cannot be silenced.
 *
 * WHY EVERY EXPORT RE-CHECKS THE CALLER
 * ------------------------------------
 * This module holds the service-role key, which bypasses RLS on every
 * table for every tenant. app/admin/[locationId]/actions.ts checks
 * currentPlatformAdmin() before it calls in here; this file checks again
 * before it touches anything, because the module holding the key does
 * not get to depend on its caller having remembered. That is
 * lib/provisioning/create-restaurant.ts's posture, and it is copied here
 * deliberately.
 *
 * Nothing here takes an org id, an assistant id, a number string or a
 * timestamp from its caller. attachNumberToLocation takes a Vapi
 * phone-number id, and re-derives from scratch which numbers this
 * location may claim before it will touch that id -- posting one
 * restaurant's number id at another restaurant's page fails on that
 * freshly built set, not on anything the browser was told. The E.164
 * string written to the column comes from Vapi's own response.
 */

export type GoLiveCheckKey =
  | "fallback"
  | "assistant"
  | "number"
  | "menu"
  | "hours"
  | "forwarding";

export type GoLiveCheckStatus = "ok" | "blocked" | "warn" | "na";

export type GoLiveCheck = {
  key: GoLiveCheckKey;
  /** True for the three that gate is_live. A warning is never promoted
   *  to a blocker by being red; it simply is not one. */
  blocking: boolean;
  status: GoLiveCheckStatus;
  title: string;
  note: string;
};

/** One row of the number picker. Numbers this location may NOT claim
 *  stay in the list carrying their reason: "there are no numbers" and
 *  "there are three and they all belong to somebody else" are different
 *  problems with different next steps, and a filtered list makes them
 *  look like the same one. */
export type AttachableNumber = {
  id: string;
  number: string;
  name: string | null;
  provider: string;
  /** What Vapi said this number pointed at when this list was built.
   *
   *  A snapshot, and used as one. Every claim below is derived from it,
   *  and the account can move underneath a derivation: two runs on two
   *  different restaurants can each see the same row as free, and
   *  planNumber -- deterministically, on purpose -- picks the same one.
   *  So runAttach re-reads the account immediately before it binds and
   *  refuses if this has moved since. That re-read is the only thing
   *  standing between the second run and a number that now rings
   *  somebody else's assistant. */
  assistantId: string | null;
  /** "unknown" is not a kind of claim, it is the absence of an answer:
   *  the locations table could not be read, so nothing can be said about
   *  who owns this number and nothing may be attached. */
  claim: "free" | "mine" | "other-location" | "foreign" | "unknown";
  claimedBy: { locationId: string; locationName: string } | null;
  attachable: boolean;
  blockedReason: string | null;
};

export type GoLiveState = {
  location: LocationRow;
  checks: GoLiveCheck[];
  canGoLive: boolean;
  numbers: AttachableNumber[];
  /** Set when Vapi could not be read at all. The assistant and number
   *  checks then read "blocked" because they could not be CONFIRMED --
   *  which is why the panel withdraws the controls that act on them
   *  rather than disabling them against facts nobody could read. */
  vapiError: string | null;
  /** Set when the locations table -- the only record of which restaurant
   *  owns which number -- could not be read in full.
   *
   *  This is a refusal, not a warning. classifyNumbers is where "may this
   *  restaurant claim that number" is decided, and it decides it by
   *  looking at every other restaurant's claim; without that list the
   *  honest answer to every number is "we do not know", and the one
   *  answer that must never be reached by losing a read is "yes". */
  ownershipError: string | null;
  /** The area code to offer when a new number is asked for, read out of
   *  this restaurant's OWN numbers -- business_phone first, then
   *  fallback_human_number. Null when neither yields one.
   *
   *  A suggestion and never a decision. Vapi issues the number out of
   *  whatever area code it is handed, that code is what a customer reads
   *  off a door and dials, and there is no undo once it is issued -- so
   *  the operator confirms it every time, and null here means they have
   *  to type one rather than that anything will pick one for them.
   *  Derived here so the panel, the standalone button and the one-click
   *  all offer the same code out of the same two columns. */
  defaultAreaCode: string | null;
};

export type GoLiveResult =
  | { ok: true; message: string }
  | { ok: false; error: string; blockedBy?: GoLiveCheckKey[] };

/* ── the checklist, as a pure function ─────────────────────────────── */

/** Everything the checklist is computed from. Split out so the rules
 *  above can be read, and tested, without a database or a Vapi account
 *  anywhere near them. */
export type GoLiveFacts = {
  location: Pick<
    LocationRow,
    | "twilio_number"
    | "fallback_human_number"
    | "vapi_assistant_id"
    | "business_phone"
    | "forwarding_verified_at"
  >;
  /** Whether locations.agent_secret_hash is set -- the boolean, never
   *  the digest, because nothing downstream of here has any business
   *  with the value.
   *
   *  This is not paperwork. lib/agent/auth.ts matches every tool call
   *  against that column and filters `.not("agent_secret_hash", "is",
   *  null)`, so an assistant whose hash was never saved answers the
   *  phone, plays the greeting, and then 401s on the menu, the order and
   *  the transfer. Without this fact the checklist cannot see that state
   *  at all: it goes green, and the one-click turns the line on over it. */
  secretOnFile: boolean;
  /** Whether Vapi answered at all. False means the two Vapi-backed
   *  checks are unconfirmed, not that they failed. */
  vapiReachable: boolean;
  /** The id of the assistant Vapi has tagged for this location
   *  (metadata.dialtone_location_id), if any. */
  taggedAssistantId: string | null;
  /** Whether GET /assistant/{vapi_assistant_id} found the assistant this
   *  record NAMES -- a different question from the tag above, and the
   *  one the blocking rule actually states.
   *
   *  Null when there was nothing to ask: no id on file, or Vapi
   *  unreadable. An assistant that exists with its tag rubbed off used
   *  to report as "gone", and the repair for "gone" builds a second
   *  assistant and rotates the tool secret out from under the first --
   *  which is still the one the phone number rings. */
  assistantOnFileExists: boolean | null;
  /** Vapi's record for the number in locations.twilio_number, if the
   *  account still has one. */
  boundNumber: VapiPhoneNumber | null;
  /** classifyNumbers' verdict on that same number. The checklist's
   *  instruction has to match what the picker will actually allow: a
   *  note reading "attach it again" beside a row nothing can attach is a
   *  dead end with no way out of it inside the product. */
  boundNumberBlockedReason: string | null;
  /** A number on the account already pointed at this restaurant's
   *  assistant while the column names something else (or nothing).
   *  Callers are reaching this restaurant through it right now, so "no
   *  number yet" would be flatly untrue. */
  assistantNumber: { number: string; blockedReason: string | null } | null;
  menuItems: number;
  hoursRows: number;
};

const UNCONFIRMED =
  "Vapi could not be read just now, so this could not be confirmed. Nothing is turned on " +
  "against a fact nobody could check.";

/* The rule this states is "vapi_assistant_id is set AND that assistant
   still exists in Vapi", and existence is a separate question from the
   tag. findAssistantForLocation matches metadata.dialtone_location_id;
   an assistant that is cloned, restored or edited in the Vapi dashboard
   keeps answering calls and loses that tag, and the search then reports
   it as absent. Absent used to mean "build a replacement", which forks a
   live assistant and rotates the secret the original is still using --
   so the record's own id is confirmed with a direct GET, and
   "exists but untagged" is its own state with its own, much smaller,
   repair. */
function assistantCheck(facts: GoLiveFacts): GoLiveCheck {
  const onFile = facts.location.vapi_assistant_id;
  const tagged = facts.taggedAssistantId;

  const base = { key: "assistant" as const, blocking: true, title: "AI assistant" };

  if (!facts.vapiReachable) return { ...base, status: "blocked", note: UNCONFIRMED };

  /* Before any of the drift states, because it outranks all of them and
     because it is the one that can otherwise pass.

     An assistant with no tool secret on file is worse than a missing
     one: it answers, it greets the caller by name, and then every tool
     call it makes is rejected by lib/agent/auth.ts, so it cannot read
     the menu, take an order or transfer. This used to be invisible --
     `onFile && tagged === onFile` returned "ok" without ever looking at
     the column -- which meant the checklist went six-for-six green over
     it. Checked first, so the note an operator reads is the repair that
     actually happens: with no secret on file runRepair rebuilds and
     rotates rather than reconnecting, whatever else has drifted.

     Scoped to a restaurant whose assistant VAPI ACTUALLY HAS -- tagged,
     or the one this record names, confirmed by its own GET. A record
     naming an assistant that is gone gets the branch below instead,
     which is both truer and the same repair: building the replacement
     mints the secret too. With no assistant at all, "there is no
     assistant yet" is the useful sentence and the last branch says it. */
  if (!facts.secretOnFile && (tagged !== null || facts.assistantOnFileExists === true)) {
    return {
      ...base,
      status: "blocked",
      note:
        "There is an assistant, but no tool secret for it on file — so it would answer the " +
        "phone, greet the caller, and then fail at the menu, the order and the transfer, because " +
        "nothing it asks this deployment can be authenticated. Repairing re-provisions it with a " +
        "fresh secret and saves it.",
    };
  }

  if (onFile && tagged === onFile) {
    return { ...base, status: "ok", note: "On file here, and still on the Vapi account." };
  }
  if (!onFile && tagged) {
    // The exact drift this product has already shipped: an assistant
    // answering calls, and a column that forgot its id.
    return {
      ...base,
      status: "blocked",
      note:
        "Vapi has an assistant for this restaurant but this record has lost track of it. " +
        "Repairing reconnects the two and changes nothing on Vapi.",
    };
  }
  if (onFile && tagged) {
    // Checked before absence: repairing reads the tag first, so this is
    // what the button would actually do.
    return {
      ...base,
      status: "blocked",
      note:
        "This record names one assistant and Vapi has a different one tagged for this " +
        "restaurant. Repairing points the record at Vapi's.",
    };
  }
  if (onFile && facts.assistantOnFileExists) {
    return {
      ...base,
      status: "blocked",
      note:
        "The assistant this record names is on Vapi and answering, but it is no longer labelled " +
        "as this restaurant's, so nothing can find it by itself. Repairing puts the label back " +
        "and changes nothing else — no rebuild, and the tool secret is untouched.",
    };
  }
  if (onFile) {
    return {
      ...base,
      status: "blocked",
      note:
        "The assistant this record names is not on the Vapi account any more. Repairing builds " +
        "a replacement and rotates this restaurant's tool secret.",
    };
  }
  return {
    ...base,
    status: "blocked",
    note: "There is no assistant yet. Repairing builds one and mints this restaurant's tool secret.",
  };
}

function numberCheck(facts: GoLiveFacts): GoLiveCheck {
  const number = facts.location.twilio_number;
  const assistantId = facts.location.vapi_assistant_id;
  const base = { key: "number" as const, blocking: true, title: "Phone number" };

  if (!facts.vapiReachable) return { ...base, status: "blocked", note: UNCONFIRMED };

  if (!number) {
    // Not "no number": a number is ringing this restaurant's assistant
    // and only the column has not caught up. Saying "attach a free one"
    // here sends an operator looking for a problem that is not the one
    // in front of them.
    if (facts.assistantNumber) {
      const theirs = facts.assistantNumber;
      return {
        ...base,
        status: "blocked",
        note: theirs.blockedReason
          ? `${theirs.number} already rings this restaurant's assistant on Vapi, but this record ` +
            `does not name it and the number is ${theirs.blockedReason}. Nothing here can settle ` +
            "that — clear the other claim in the Vapi dashboard first, then attach it."
          : `${theirs.number} already rings this restaurant's assistant on Vapi, but this record ` +
            "does not name it. Attach it to write it down here.",
      };
    }
    return {
      ...base,
      status: "blocked",
      note:
        "No number yet. Attach one of the account's free numbers, or get a new one — nobody can " +
        "reach this restaurant through Dialtone until one is bound.",
    };
  }
  if (!facts.boundNumber) {
    return {
      ...base,
      status: "blocked",
      note: `${number} is on file here but is not a number on the Vapi account. Attach one that is.`,
    };
  }
  if (!assistantId || facts.boundNumber.assistantId !== assistantId) {
    // The picker's own verdict decides the instruction. Telling an
    // operator to "attach it again" while classifyNumbers refuses that
    // exact row -- which is what a number two restaurants both claim
    // does -- is a dead end with no button behind it.
    if (facts.boundNumberBlockedReason) {
      return {
        ...base,
        status: "blocked",
        note:
          `${number} is on the account, but Vapi points it somewhere other than this ` +
          `restaurant's assistant and the number is ${facts.boundNumberBlockedReason}. Neither ` +
          "side can attach it from here while that stands — settle it in the Vapi dashboard, " +
          "then attach it again.",
      };
    }
    return {
      ...base,
      status: "blocked",
      note: `${number} is on the account, but Vapi is not pointing it at this restaurant's assistant. Attach it again.`,
    };
  }
  return { ...base, status: "ok", note: `${number} rings this restaurant's assistant.` };
}

/** Whether there is a fallback number, AND whether it is one that can
 *  actually be dialled.
 *
 *  "Not null" used to be the whole test, and it is not the same
 *  question. Nothing downstream re-formats this column: app/api/agent/
 *  transfer hands it to Vapi verbatim, lib/vapi/provision.ts bakes it
 *  into the assistant's native transfer destination, and lib/phone.ts
 *  records what that costs -- a bare "(510) 555-0199" 400s with "must be
 *  a valid phone number in the E.164 format", caught live. So a row
 *  holding "12", or a legacy local-format number written before
 *  setFallbackNumber normalized on the way in, clears a null check and
 *  then drops the one caller nobody can afford to drop: the one asking
 *  about an allergy.
 *
 *  normalizePhoneToE164 is the arbiter rather than a second rule of this
 *  module's own -- it is the exact function setFallbackNumber writes
 *  through, so what this demands and what a save produces cannot drift.
 *  Equality, not truthiness: a value that normalizes to something OTHER
 *  than itself is not merely untidy, it is a different string from the
 *  one that will be dialled. */
function fallbackCheck(facts: GoLiveFacts): GoLiveCheck {
  const number = facts.location.fallback_human_number;
  const base = { key: "fallback" as const, blocking: true, title: "Fallback number" };

  if (!number) {
    return {
      ...base,
      status: "blocked",
      note:
        "No fallback number. Transfers, allergy hand-offs and the kill switch would all have " +
        "nowhere to go, so a caller asking something the agent cannot answer would hit dead air.",
    };
  }

  const dialable = normalizePhoneToE164(number);

  if (!dialable) {
    return {
      ...base,
      status: "blocked",
      note:
        `${number} is on file as the fallback number, but it is not a number anything here can ` +
        "dial, so transfers, allergy hand-offs and the kill switch would all fail at the moment " +
        "they were needed. Type it in full below and save it, e.g. (510) 555-0100.",
    };
  }

  if (dialable !== number) {
    return {
      ...base,
      status: "blocked",
      note:
        `${number} is on file, and it is dialled exactly as it is stored — which Vapi and Twilio ` +
        `both refuse, because it is not E.164. Save it again below and it is stored as ` +
        `${dialable}, which is the same number in the shape they accept.`,
    };
  }

  return {
    ...base,
    status: "ok",
    note: `Transfers, allergy hand-offs and the kill switch all dial ${number}.`,
  };
}

function menuCheck(facts: GoLiveFacts): GoLiveCheck {
  const base = { key: "menu" as const, blocking: false, title: "Menu" };

  return facts.menuItems > 0
    ? {
        ...base,
        status: "ok",
        note: `${facts.menuItems} ${facts.menuItems === 1 ? "item" : "items"} on the menu.`,
      }
    : {
        ...base,
        status: "warn",
        note:
          "No menu items. The agent can still answer hours, take a message and hand a caller to " +
          "a person — it just cannot take an order.",
      };
}

function hoursCheck(facts: GoLiveFacts): GoLiveCheck {
  const base = { key: "hours" as const, blocking: false, title: "Hours" };

  return facts.hoursRows > 0
    ? {
        ...base,
        status: "ok",
        note: `${facts.hoursRows} ${facts.hoursRows === 1 ? "day" : "days"} of hours on file.`,
      }
    : {
        ...base,
        status: "warn",
        note:
          "No hours on file, so the agent will treat this restaurant as closed and cannot promise " +
          "a pickup time.",
      };
}

function forwardingCheck(facts: GoLiveFacts): GoLiveCheck {
  const base = { key: "forwarding" as const, blocking: false, title: "Call forwarding" };
  const theirs = facts.location.business_phone;

  // Nothing is being forwarded, so there is nothing to prove. Shown
  // rather than hidden, so an operator can see the question was asked.
  if (!theirs) {
    return {
      ...base,
      status: "na",
      note:
        "This restaurant has no line of its own on file, so it publishes the Dialtone number " +
        "directly and there is nothing to forward.",
    };
  }
  if (facts.location.forwarding_verified_at) {
    return { ...base, status: "ok", note: `A call to ${theirs} has been proved to land here.` };
  }
  return {
    ...base,
    status: "warn",
    note:
      `Nobody has proved that a call to ${theirs} lands here. Ring it once, and mark it verified ` +
      "if the agent picks up.",
  };
}

/** The whole checklist, blockers first. Pure: same facts, same list. */
export function buildChecks(facts: GoLiveFacts): GoLiveCheck[] {
  return [
    assistantCheck(facts),
    numberCheck(facts),
    fallbackCheck(facts),
    menuCheck(facts),
    hoursCheck(facts),
    forwardingCheck(facts),
  ];
}

/** Which blockers are still in the way. Empty means this restaurant can
 *  be turned on. Warnings are never in here. */
export function blockersOf(checks: GoLiveCheck[]): GoLiveCheckKey[] {
  return checks.filter((c) => c.blocking && c.status !== "ok").map((c) => c.key);
}

/* ── who may claim which number ────────────────────────────────────── */

/** What a location has to say about the numbers on the account. Only
 *  the three columns that constitute a claim. */
export type NumberClaimant = {
  id: string;
  name: string;
  twilio_number: string | null;
  vapi_assistant_id: string | null;
};

/** Turn the account's numbers into the picker's rows, from this
 *  location's point of view.
 *
 *  Pure, and the only place "may this restaurant claim that number"
 *  is decided. Two independent kinds of claim are honoured, because the
 *  database and Vapi can disagree and this product has watched them do
 *  it: a location claims a number if its twilio_number column holds it,
 *  and it claims a number if Vapi points that number at its assistant.
 *  When those two disagree about WHICH location, nobody gets to attach
 *  it from here -- a one-click re-point would quietly take a live number
 *  away from whichever restaurant is currently answering on it.
 *
 *  `claimsKnown` is the difference between "nobody claims this number"
 *  and "we could not find out". An empty claimant list means the first;
 *  a failed or truncated read of the locations table means the second,
 *  and handing that in as an empty list would turn every other
 *  restaurant's number into a free one. This whole guard is a set
 *  difference, so losing the set has to refuse rather than widen. */
export function classifyNumbers({
  numbers,
  locationId,
  claimants,
  claimsKnown = true,
}: {
  numbers: VapiPhoneNumber[];
  locationId: string;
  claimants: NumberClaimant[];
  claimsKnown?: boolean;
}): AttachableNumber[] {
  return numbers.map((n) => {
    if (!claimsKnown) {
      return {
        id: n.id,
        number: n.number,
        name: n.name,
        provider: n.provider,
        assistantId: n.assistantId,
        claim: "unknown" as const,
        claimedBy: null,
        attachable: false,
        blockedReason: "not checkable — which restaurant owns which number could not be read",
      };
    }

    const byNumber = claimants.find((c) => c.twilio_number !== null && c.twilio_number === n.number);
    const byAssistant = n.assistantId
      ? claimants.find((c) => c.vapi_assistant_id !== null && c.vapi_assistant_id === n.assistantId)
      : undefined;

    const row = {
      id: n.id,
      number: n.number,
      name: n.name,
      provider: n.provider,
      assistantId: n.assistantId,
    };

    // The database says one restaurant owns it and Vapi says another
    // does. Both are asserting a live claim; neither can be honoured
    // with a button.
    if (byNumber && byAssistant && byNumber.id !== byAssistant.id) {
      return {
        ...row,
        claim: "other-location" as const,
        claimedBy: { locationId: byNumber.id, locationName: byNumber.name },
        attachable: false,
        // The reason, not the remedy: the remedy is a whole sentence and
        // it belongs in numberCheck's note, where there is room to name
        // where it has to be done.
        blockedReason: `claimed by both ${byNumber.name} and ${byAssistant.name}`,
      };
    }

    const owner = byNumber ?? byAssistant;

    if (owner && owner.id === locationId) {
      return {
        ...row,
        claim: "mine" as const,
        claimedBy: { locationId: owner.id, locationName: owner.name },
        attachable: true,
        blockedReason: null,
      };
    }
    if (owner) {
      return {
        ...row,
        claim: "other-location" as const,
        claimedBy: { locationId: owner.id, locationName: owner.name },
        attachable: false,
        blockedReason: `already ${owner.name}'s`,
      };
    }
    // Bound on Vapi to an assistant no restaurant here owns. It belongs
    // to something else on this Vapi org -- a test assistant, another
    // product -- and taking it would break whatever that is.
    if (n.assistantId) {
      return {
        ...row,
        claim: "foreign" as const,
        claimedBy: null,
        attachable: false,
        blockedReason: "pointed at an assistant that is not one of ours",
      };
    }
    return {
      ...row,
      claim: "free" as const,
      claimedBy: null,
      attachable: true,
      blockedReason: null,
    };
  });
}

/* ── the gate, and the reads behind it ─────────────────────────────── */

/* Byte-identical to create-restaurant.ts's refusal. A non-admin, a
   malformed id and a location that does not exist are told apart by
   nobody. */
/* One string, two constants built from it. makeItLive cannot return a
   GoLiveResult, and two literals staying in sync by hand is exactly how
   a refusal stops being byte-identical. */
const NOT_FOUND_TEXT = "Not found.";
const NOT_FOUND: GoLiveResult = { ok: false, error: NOT_FOUND_TEXT };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Staff, and a location id that could be one. Returns the refusal to
 *  hand back, or null to proceed. Nothing observable happens on the
 *  refusing path: no service-role client, no Vapi request, no log line
 *  that could confirm a location exists. */
async function gate(locationId: string): Promise<GoLiveResult | null> {
  const admin = await currentPlatformAdmin();
  if (!admin) return NOT_FOUND;
  if (!UUID.test(locationId)) return NOT_FOUND;
  return null;
}

/** "The database would not answer", which is not the same fact as "there
 *  is no such restaurant" and must never be rendered as one.
 *
 *  Both used to come back as null, and the page turns null into
 *  notFound() -- so one transient Postgres error replaced the only
 *  screen with Take offline and the kill switch on it with a 404. */
export class LocationReadError extends Error {
  constructor(message = "Could not read this restaurant just now.") {
    super(message);
    this.name = "LocationReadError";
  }
}

async function loadLocation(locationId: string): Promise<LocationRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("locations")
    .select("*")
    .eq("id", locationId)
    .maybeSingle();

  if (error) {
    console.error("[go-live] could not read the location", { code: error.code });
    throw new LocationReadError();
  }
  return (data as LocationRow | null) ?? null;
}

/** The row, for a mutation. A restaurant that is not there is a refusal;
 *  a read that FAILED is a different refusal; neither is an exception a
 *  server action gets to throw at a browser. */
async function rowForWrite(
  locationId: string,
): Promise<{ row: LocationRow } | { refusal: GoLiveResult }> {
  try {
    const row = await loadLocation(locationId);
    return row ? { row } : { refusal: NOT_FOUND };
  } catch (err) {
    if (err instanceof LocationReadError) {
      return { refusal: { ok: false, error: `${err.message} Nothing was changed.` } };
    }
    throw err;
  }
}

/** The whole state, for a mutation. Same split as rowForWrite. */
async function stateForWrite(
  locationId: string,
): Promise<{ state: GoLiveState } | { refusal: GoLiveResult }> {
  try {
    const state = await getGoLiveState(locationId);
    return state ? { state } : { refusal: NOT_FOUND };
  } catch (err) {
    if (err instanceof LocationReadError) {
      return { refusal: { ok: false, error: `${err.message} Nothing was changed.` } };
    }
    throw err;
  }
}

/** Vapi's error, as one finished sentence the panel can print. Never
 *  carries the key: ProvisioningError names the variable, never its
 *  value. */
function vapiMessage(err: unknown): string {
  const raw =
    err instanceof ProvisioningError || err instanceof Error
      ? err.message
      : "Vapi could not be reached.";
  return /[.!?]$/.test(raw) ? raw : `${raw}.`;
}

const NO_KEY =
  "This deployment has no VAPI_PRIVATE_KEY set, so nothing about the assistant or the number " +
  "could be read.";

const NO_OWNERSHIP =
  "Which restaurant owns which number could not be read just now, so no number can be attached " +
  "— refusing is the only safe answer, because the one this must never reach by losing a read " +
  "is “nobody owns it”.";

/** A ceiling on the claimants read, and a tripwire.
 *
 *  Without an explicit limit this select inherits PostgREST's max-rows
 *  cap, and a truncated read is indistinguishable from a complete one:
 *  the restaurants past the cut simply stop claiming their own numbers.
 *  Asking for one more row than the platform could plausibly have turns
 *  that silent failure into a condition this file can see and refuse on. */
export const CLAIMANT_LIMIT = 5000;

/** How long the two Vapi reads behind this page get.
 *
 *  Much shorter than VAPI_TIMEOUT_MS, because this is the only page in
 *  the product carrying Take offline and the kill switch, and it does not
 *  paint until these resolve. A Vapi outage that hangs rather than fails
 *  has to land on the vapiError path in seconds; the alternative is an
 *  operator who cannot silence a restaurant because a third party stopped
 *  answering. */
const PAGE_VAPI_TIMEOUT_MS = 5_000;

/** Everything the panel draws.
 *
 *  Deliberately asks Vapi rather than trusting the columns. A cached
 *  answer is exactly what let a live restaurant's assistant id drift to
 *  null with nobody noticing, and "the column says so" is not evidence
 *  that a caller reaches anybody.
 *
 *  Returns null for a caller who is not staff and for a location that
 *  does not exist -- the page turns both into notFound(). Throws
 *  LocationReadError when the row could not be READ, which is a
 *  different fact and gets the error boundary rather than a 404. */
export async function getGoLiveState(locationId: string): Promise<GoLiveState | null> {
  const admin = await currentPlatformAdmin();
  if (!admin) return null;
  if (!UUID.test(locationId)) return null;

  const location = await loadLocation(locationId);
  if (!location) return null;

  const supabase = supabaseAdmin();
  const [menu, hours, claimants] = await Promise.all([
    supabase
      .from("menu_items")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId),
    supabase
      .from("hours")
      .select("location_id", { count: "exact", head: true })
      .eq("location_id", locationId),
    // Every location, because "may this restaurant claim that number"
    // is a question about all of them. Four columns of a table with one
    // row per restaurant on the platform.
    supabase
      .from("locations")
      .select("id, name, twilio_number, vapi_assistant_id")
      .limit(CLAIMANT_LIMIT),
  ]);

  // A missing count is a warning that reads as "0 items", which is the
  // safe direction: it never turns a blocker green.
  if (menu.error) console.error("[go-live] menu count failed", { code: menu.error.code });
  if (hours.error) console.error("[go-live] hours count failed", { code: hours.error.code });

  // Ownership is the one read here that fails the other way. Every claim
  // this list is missing is a number that classifies as free, so a lost
  // or truncated read has to become a refusal rather than a shorter set.
  const claimantRows = (claimants.data ?? []) as NumberClaimant[];
  const truncated = claimantRows.length >= CLAIMANT_LIMIT;
  const claimsKnown = !claimants.error && !truncated;

  if (claimants.error) {
    console.error("[go-live] locations read failed", { code: claimants.error.code });
  }
  if (truncated) {
    console.error("[go-live] locations read hit the claimant ceiling", { limit: CLAIMANT_LIMIT });
  }

  let vapiError: string | null = null;
  let vapiNumbers: VapiPhoneNumber[] = [];
  let taggedAssistantId: string | null = null;
  let assistantOnFileExists: boolean | null = null;

  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    console.error("[go-live] VAPI_PRIVATE_KEY is not configured");
    vapiError = NO_KEY;
  } else {
    try {
      // One list, one search, and -- when this record names an assistant
      // -- one direct read of that assistant.
      //
      // findAssistantForLocation matches on metadata.dialtone_location_id
      // rather than on the column, which is the whole point: it can see
      // an assistant the column has forgotten. getAssistant answers the
      // opposite question, which the blocking rule actually states: is
      // the assistant this record NAMES still there. An assistant whose
      // tag was rubbed off in the Vapi dashboard is invisible to the
      // first and present to the second, and it is usually the one
      // answering the phone.
      const onFile = location.vapi_assistant_id;
      const options = { timeoutMs: PAGE_VAPI_TIMEOUT_MS };
      const [numbers, tagged, named] = await Promise.all([
        listPhoneNumbers(vapiKey, options),
        findAssistantForLocation(vapiKey, locationId, options),
        onFile ? getAssistant(vapiKey, onFile, options) : Promise.resolve(null),
      ]);
      vapiNumbers = numbers;
      taggedAssistantId = tagged?.id ?? null;
      assistantOnFileExists = onFile ? named !== null : null;
    } catch (err) {
      vapiError = vapiMessage(err);
    }
  }

  // Classified first, because two of the checks below need the picker's
  // own verdict: an instruction that points at a row nothing can attach
  // is a dead end with no button behind it.
  const numbers = classifyNumbers({
    numbers: vapiNumbers,
    locationId,
    claimants: claimantRows,
    claimsKnown,
  });

  const boundNumber =
    vapiNumbers.find((n) => location.twilio_number && n.number === location.twilio_number) ?? null;

  const assistantRecord = location.vapi_assistant_id
    ? (vapiNumbers.find(
        (n) => n.assistantId === location.vapi_assistant_id && n.number !== location.twilio_number,
      ) ?? null)
    : null;

  const reasonFor = (id: string) => numbers.find((n) => n.id === id)?.blockedReason ?? null;

  const facts: GoLiveFacts = {
    location,
    // Boolean(), not `!== null`: an empty string is not a digest
    // lib/agent/auth.ts could ever match, so it is not a secret on file.
    secretOnFile: Boolean(location.agent_secret_hash),
    vapiReachable: vapiError === null,
    taggedAssistantId,
    assistantOnFileExists,
    boundNumber,
    boundNumberBlockedReason: boundNumber ? reasonFor(boundNumber.id) : null,
    assistantNumber: assistantRecord
      ? { number: assistantRecord.number, blockedReason: reasonFor(assistantRecord.id) }
      : null,
    menuItems: menu.count ?? 0,
    hoursRows: hours.count ?? 0,
  };

  const checks = buildChecks(facts);

  return {
    location,
    checks,
    canGoLive: blockersOf(checks).length === 0,
    numbers,
    vapiError,
    ownershipError: claimsKnown ? null : NO_OWNERSHIP,
    // The restaurant's own line first: that is the area code its
    // customers already dial and the one a forwarded call should look
    // like it came from. The fallback second -- it is a person at this
    // restaurant, so it is the next best evidence of where the
    // restaurant is. Neither is invented if neither parses.
    defaultAreaCode:
      areaCodeOf(location.business_phone) ?? areaCodeOf(location.fallback_human_number),
  };
}

/* ── the writes ────────────────────────────────────────────────────── */

/** One column, one row, one message. Every mutation below lands through
 *  here so a failed write reads the same way whichever column it was. */
async function write(
  locationId: string,
  patch: Record<string, unknown>,
  message: string,
): Promise<GoLiveResult> {
  const { error } = await supabaseAdmin().from("locations").update(patch).eq("id", locationId);

  if (error) {
    // The code, never the patch: fallback_human_number is somebody's
    // personal number and has no business in a log.
    console.error("[go-live] update failed", { code: error.code, columns: Object.keys(patch) });
    return { ok: false, error: "That did not save. Nothing was changed." };
  }
  return { ok: true, message };
}

/** write(), but only while twilio_number still holds what the decision
 *  to write was derived from.
 *
 *  Every path in this file that puts a number in that column goes
 *  through here, because every one of them decided what to write from a
 *  read taken before a Vapi round trip, and there is no transaction
 *  spanning Vapi and Postgres -- so another run (another Vercel
 *  instance; the module-level single-flight below only covers one
 *  process) can write a number into this column while we are away.
 *
 *  `expected` is that read, handed back: null for the two cases that
 *  decided BECAUSE the column was empty (minting, and attaching to a
 *  restaurant with no number), and the string on file for the one case
 *  that legitimately replaces a number -- re-attaching after a rebuild.
 *  Hard-coding `.is(null)` would have refused that last one; leaving the
 *  update unconditional, which is what attaching used to do, silently
 *  overwrote a number another run had just minted and already shown to
 *  an operator.
 *
 *  Postgres serializes this UPDATE per row and re-evaluates the
 *  predicate under READ COMMITTED, so the loser updates zero rows and
 *  learns it lost. `.select("id")` is what makes that visible: without
 *  it PostgREST returns no representation and zero rows is
 *  indistinguishable from one.
 *
 *  Losing is NOT an error to retry. It means a number this restaurant
 *  may already be answering on is in the column, and a second one is now
 *  live on the Vapi account. The caller's job is to name both, loudly,
 *  and never to overwrite.
 *
 *  This is detection, not prevention: two presses landing on two
 *  instances can still mint two numbers. Preventing that needs a claim
 *  column (`locations.number_claim_at`) and a migration, which is not in
 *  this change. */
async function writeNumberIf(
  locationId: string,
  expected: string | null,
  patch: Record<string, unknown>,
  message: string,
): Promise<
  | { ok: true; message: string }
  | { ok: false; error: string; reason: "failed" | "lost" }
> {
  const row = supabaseAdmin().from("locations").update(patch).eq("id", locationId);
  // PostgREST spells "still null" and "still this string" with two
  // different operators, and `.eq(column, null)` is not the first one.
  const guarded = expected === null ? row.is("twilio_number", null) : row.eq("twilio_number", expected);
  const { data, error } = await guarded.select("id");

  if (error) {
    console.error("[go-live] conditional update failed", {
      code: error.code,
      columns: Object.keys(patch),
    });
    return { ok: false, error: "That did not save. Nothing was changed.", reason: "failed" };
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error:
        expected === null
          ? "This restaurant already had a number written down by the time that landed, so " +
            "nothing here was overwritten."
          : `This restaurant's number stopped being ${expected} while that was in flight, so ` +
            "nothing here was overwritten.",
      reason: "lost",
    };
  }
  return { ok: true, message };
}

/** Turn the phone on, or off.
 *
 *  On: the checklist is rebuilt from a fresh read of the row AND a fresh
 *  read of Vapi first. The panel the operator clicked from can be
 *  minutes old, and "we rendered it green" is not authorization.
 *
 *  Off: nothing but the column. No checklist and no Vapi round trip --
 *  both app/api/twilio/voice/route.ts and app/api/agent/assistant/route.ts
 *  refuse on `kill_switch_on || !is_live` at call time, so this alone is
 *  a real kill, and it must keep working while Vapi is down. */
export async function setLocationLive({
  locationId,
  live,
}: {
  locationId: string;
  live: boolean;
}): Promise<GoLiveResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  if (!live) {
    return write(
      locationId,
      { is_live: false },
      "Taken offline. Callers no longer reach the assistant.",
    );
  }

  const read = await stateForWrite(locationId);
  if ("refusal" in read) return read.refusal;
  const state = read.state;

  const blocked = blockersOf(state.checks);
  if (blocked.length > 0) {
    const titles = state.checks
      .filter((c) => blocked.includes(c.key))
      .map((c) => c.title.toLowerCase());
    return {
      ok: false,
      error: `Not turned on: ${titles.join(", ")} ${blocked.length === 1 ? "is" : "are"} still in the way.`,
      blockedBy: blocked,
    };
  }

  return write(
    locationId,
    { is_live: true },
    state.location.kill_switch_on
      ? "Live — but the kill switch is still on, so every call goes straight to a person."
      : `Live. ${state.location.twilio_number} now rings the assistant.`,
  );
}

/** Hand every call straight to a person without taking the line down,
 *  or give the calls back. Ungated for the same reason as taking a
 *  restaurant offline: this is the switch somebody reaches for while a
 *  caller is being handled badly. */
export async function setKillSwitch({
  locationId,
  on,
}: {
  locationId: string;
  on: boolean;
}): Promise<GoLiveResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  if (!on) {
    return write(
      locationId,
      { kill_switch_on: false },
      "Kill switch off. The assistant is taking calls again.",
    );
  }

  // Written FIRST, then read only to decorate the sentence.
  //
  // This used to read the row before writing, purely to choose between
  // two messages -- which meant a transient error on that select refused
  // the emergency control outright, and refused it with the word "Not
  // found.", mid-incident, to somebody staring at a restaurant that
  // plainly exists. Taking a restaurant offline has never been gated on
  // a read; the switch beside it must not be either.
  const result = await write(
    locationId,
    { kill_switch_on: true },
    "Kill switch on. Every call now goes straight to a person.",
  );
  if (!result.ok) return result;

  let location: LocationRow | null = null;
  try {
    location = await loadLocation(locationId);
  } catch {
    // Decoration only. The switch is already thrown; the generic
    // sentence above is true whether or not this read worked.
    location = null;
  }

  if (!location) return result;

  /* THREE WAYS, NOT TWO, AND THE THIRD IS THE ONE THIS CONTROL EXISTS
     FOR.

     This sentence tested the column for TRUTHINESS while meaning
     "dialable", which is the distinction fallbackCheck and
     runMakeItLive were taught and this decoration was not. The
     population it gets wrong is exactly the one an emergency switch is
     reached for: a restaurant that went live before that check existed
     and carries a legacy "(510) 555-0199", or a "12" typed into a field
     that gave no inline feedback. For that row the switch reported
     success AND NAMED THE NUMBER, while app/api/twilio/voice dials that
     literal string in TwiML (`dial({ to: fallback })`) and the call
     fails. A false all-clear is worse than a refusal: the operator
     reads a number back to a restaurant owner mid-incident and stops
     looking, and the caller it drops is the one asking about an
     allergy.

     Still no gate. The write above already happened and must keep
     happening -- silence is the safe state and this is the switch
     somebody throws while a caller is being handled badly. Only the
     decoration is corrected, which is all that was ever wrong. */
  const onFile = location.fallback_human_number;
  const dialable = dialableNumber(onFile);

  if (dialable) {
    return { ok: true, message: `Kill switch on. Every call now goes straight to ${dialable}.` };
  }

  /* There IS a number, and naming it is the point: the operator is
     looking at it. No "below" in this sentence -- the same switch is in
     the sidebar of every console page, where there is no field below
     anything. */
  if (onFile) {
    return {
      ok: true,
      message:
        `Kill switch on — but ${onFile} is the fallback number on file, and it is not in the ` +
        "shape Twilio dials, so callers will reach nobody. Save it again as a full number, " +
        "e.g. (510) 555-0100, or take the restaurant offline instead.",
    };
  }

  return {
    ok: true,
    message:
      "Kill switch on. There is no fallback number, so callers will not reach anybody — set " +
      "one, or take the restaurant offline instead.",
  };
}

/** Record, or un-record, that somebody rang the restaurant's own line
 *  and the call landed here. The timestamp is written here; no date and
 *  no "verified by" note is accepted from a caller. */
export async function setForwardingVerified({
  locationId,
  verified,
}: {
  locationId: string;
  verified: boolean;
}): Promise<GoLiveResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  return verified
    ? write(
        locationId,
        { forwarding_verified_at: new Date().toISOString() },
        "Noted — forwarding is proven.",
      )
    : write(
        locationId,
        { forwarding_verified_at: null },
        "Cleared. Forwarding counts as unproven again.",
      );
}

/** The number transfers, allergy hand-offs and the kill switch dial.
 *
 *  Normalized again here even though the action already did it: this
 *  module is what actually writes the column, and app/api/agent/transfer
 *  hands that column straight to Twilio. */
export async function setFallbackNumber({
  locationId,
  number,
}: {
  locationId: string;
  number: string;
}): Promise<GoLiveResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const e164 = normalizePhoneToE164(number);
  if (!e164) {
    return {
      ok: false,
      error: "That does not look like a phone number, so nothing was saved.",
    };
  }

  // Read before write here, unlike the kill switch: nothing is lost by
  // refusing to set a fallback number, so failing closed costs nothing.
  const read = await rowForWrite(locationId);
  if ("refusal" in read) return read.refusal;
  const location = read.row;

  const result = await write(
    locationId,
    { fallback_human_number: e164 },
    `Saved. Transfers, allergy hand-offs and the kill switch now dial ${e164}.`,
  );

  // Honest small print, and only where it is true. The tool routes read
  // this column live, but the assistant's own one-tap transfer
  // destination was baked into the Vapi payload when the assistant was
  // built (see nativeTransferTool in lib/vapi/provision.ts), so an
  // assistant that already exists still carries the old number there.
  //
  // This used to end at "until the assistant is rebuilt", which named a
  // problem and no way out of it -- there was nothing in the console
  // that would rebuild an assistant it considered healthy. Edit details
  // is now that road: saving the fallback number there pushes the
  // rebuild with it, and says whether the push landed. This panel's own
  // field stays, because its job is clearing a blocker on a restaurant
  // that has no assistant yet, where there is nothing to rebuild.
  if (result.ok && location.vapi_assistant_id) {
    return {
      ok: true,
      message:
        `${result.message} The assistant's own one-tap transfer still carries the number it was ` +
        "built with. Save the same number under Edit details → Answering the phone to rebuild " +
        "the assistant and move that too.",
    };
  }
  return result;
}

/* ── the things a restaurant needs before it can answer ────────────── */

/* The two sentences below are shared by the standalone controls and by
   the one-click run, so an operator reads the same words whichever road
   they took. */
const NO_ASSISTANT_TO_ATTACH =
  "There is no assistant to point a number at yet. Repair the assistant first, then attach " +
  "the number.";

const NO_ASSISTANT_TO_MINT =
  "There is no assistant to point a new number at yet. Repair the assistant first — " +
  "otherwise the number would ring nothing.";

/** attachNumberToLocation, minus the gate and minus the read.
 *
 *  Split out for makeItLive, which has already derived the state and
 *  must not derive it three more times -- each derivation is three Vapi
 *  round trips, and burying the step order under redundant reads is how
 *  an ordering argument stops being checkable. Module-private: the gate
 *  stays on the export, so "the module holding the key checks for
 *  itself" is untouched.
 *
 *  Every guard the export used to hold is HERE, not re-implemented
 *  above: the Vapi refusal, the ownership refusal, the assistant
 *  precondition and -- the one that matters across tenants -- the
 *  re-derived attachable set. `phoneNumberId` is still a selector that
 *  proves nothing.
 *
 *  `number` on the failure branch is the honest part: when Vapi bound
 *  the number and only the column write failed, that number is now
 *  ringing this restaurant's assistant and the operator has to be told
 *  which one. */
async function runAttach(
  state: GoLiveState,
  phoneNumberId: string,
  vapiKey: string,
): Promise<
  | { ok: true; message: string; number: string }
  | { ok: false; error: string; number: string | null }
> {
  if (state.vapiError) {
    return { ok: false, error: `${state.vapiError} Nothing was changed.`, number: null };
  }
  // The cross-tenant guard is a set difference against every other
  // restaurant's claim. Without that set the picker's rows are all
  // refusals already; saying so plainly beats "that is not a number this
  // restaurant can claim" for a number that may well be its own.
  if (state.ownershipError) {
    return { ok: false, error: `${state.ownershipError} Nothing was changed.`, number: null };
  }

  const assistantId = state.location.vapi_assistant_id;
  if (!assistantId) {
    return { ok: false, error: NO_ASSISTANT_TO_ATTACH, number: null };
  }

  const pick = state.numbers.find((n) => n.id === phoneNumberId);
  if (!pick || !pick.attachable) {
    return {
      ok: false,
      error: pick?.blockedReason
        ? `That number is ${pick.blockedReason}, so it was not attached.`
        : "That is not a number this restaurant can claim. Reload the page and pick again.",
      number: null,
    };
  }

  /* The compare-and-set on Vapi's side, and the reason it exists.
   *
   * `pick` came out of a derivation, and a derivation is a photograph.
   * Two runs on two DIFFERENT restaurants can each photograph the same
   * unclaimed number, and planNumber picks deterministically -- by
   * design, so that two runs on ONE restaurant converge -- which for two
   * restaurants means they converge on the same row instead of avoiding
   * it. Re-checking `pick.attachable` proves nothing here: that flag was
   * computed from the same photograph.
   *
   * So the account is read once more, right before the PATCH, and the
   * bind only happens while Vapi still points this number where it
   * pointed when the claim was worked out. The loser is told the number
   * moved rather than taking it off whoever won -- which, for a number
   * the other restaurant is already answering on, is the difference
   * between a refusal and a caller ordering from the wrong menu. */
  let fresh: VapiPhoneNumber | undefined;
  try {
    fresh = (await listPhoneNumbers(vapiKey)).find((n) => n.id === pick.id);
  } catch (err) {
    console.error("[go-live] could not re-read the number", err instanceof Error ? err.message : err);
    return {
      ok: false,
      error: `${vapiMessage(err)} The number was not attached — nothing is bound against an account nobody could read.`,
      number: null,
    };
  }
  if (!fresh) {
    return {
      ok: false,
      error: `${pick.number} is not on the Vapi account any more, so it was not attached. Reload the page and pick again.`,
      number: null,
    };
  }
  // Unchanged since the claim was worked out, or already pointing where
  // this is about to point it -- the second is the same restaurant's own
  // second press, and re-binding a number to the assistant it already
  // rings is a no-op PATCH, not a theft.
  if (fresh.assistantId !== pick.assistantId && fresh.assistantId !== assistantId) {
    return {
      ok: false,
      error:
        `${pick.number} was claimed while this was being worked out — Vapi points it somewhere ` +
        "other than it did a moment ago, so it was not attached and nothing was taken off " +
        "whoever claimed it. Reload the page and pick again.",
      number: null,
    };
  }

  let bound;
  try {
    bound = await bindPhoneNumber(vapiKey, {
      phoneNumberId: pick.id,
      assistantId,
      name: state.location.name,
    });
  } catch (err) {
    console.error("[go-live] could not bind the number", err instanceof Error ? err.message : err);
    return { ok: false, error: `${vapiMessage(err)} The number was not attached.`, number: null };
  }

  // Vapi's string, not the browser's and not the picker's. Conditional
  // on the column still holding what this decision was derived from:
  // every plan that reaches here with an empty column decided BECAUSE it
  // was empty, and an unconditional update would overwrite a number
  // another run minted -- and already read down a phone -- while this
  // one was away at Vapi.
  const saved = await writeNumberIf(
    state.location.id,
    state.location.twilio_number,
    { twilio_number: bound.number },
    `${bound.number} now rings this restaurant's assistant.`,
  );

  if (saved.ok) return { ok: true, message: saved.message, number: bound.number };

  // Self-contained on both roads: the standalone button hands the
  // operator nothing but this sentence, and the number Vapi has just
  // bound is the fact that must not be lost in it.
  return {
    ok: false,
    number: bound.number,
    error:
      saved.reason === "lost"
        ? `${bound.number} now rings this restaurant's assistant on Vapi, but the number written ` +
          "down here changed while that was in flight, so nothing here was overwritten. Settle " +
          "which of the two this restaurant keeps in the Vapi dashboard."
        : `${bound.number} now rings this restaurant's assistant on Vapi, but writing it down ` +
          "here failed. Attach it again — the binding itself is already right, so there is " +
          "nothing else to undo.",
  };
}

/** Point one of the account's numbers at this restaurant's assistant.
 *
 *  `phoneNumberId` is a selector and proves nothing. The attachable set
 *  is rebuilt here, from Vapi and from every location's claims, and
 *  anything outside it is refused -- so this cannot be used to take a
 *  number off another restaurant. What lands in the column is Vapi's own
 *  E.164 string. */
export async function attachNumberToLocation({
  locationId,
  phoneNumberId,
}: {
  locationId: string;
  phoneNumberId: string;
}): Promise<GoLiveResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    console.error("[go-live] VAPI_PRIVATE_KEY is not configured");
    return { ok: false, error: NO_KEY };
  }

  const read = await stateForWrite(locationId);
  if ("refusal" in read) return read.refusal;

  const done = await runAttach(read.state, phoneNumberId, vapiKey);
  return done.ok ? { ok: true, message: done.message } : { ok: false, error: done.error };
}

/** provisionNumberForLocation, minus the gate and minus the read. Same
 *  split, and the same guards, as runAttach.
 *
 *  `number` is set on the failure branch whenever Vapi may have issued
 *  one. That is not a courtesy: reporting the number IS the rollback.
 *  lib/vapi/phone-numbers.ts deliberately ships no release wrapper --
 *  DELETE /phone-number is the one irreversible act in this feature, and
 *  a machine taking it seconds after a number came into existence, on a
 *  line that may already have been read down a phone, is the worst
 *  version of it. Keeping the number costs one slot of the org's free
 *  allowance, which a person can hand back in the Vapi dashboard;
 *  deleting it costs the number, which nobody can get back. */
async function runProvision(
  state: GoLiveState,
  vapiKey: string,
  areaCode: string,
): Promise<
  | { ok: true; message: string; number: string }
  | { ok: false; error: string; number: string | null }
> {
  if (state.vapiError) {
    return { ok: false, error: `${state.vapiError} No number was requested.`, number: null };
  }

  // Refused before anything is spent. A double click, a retried POST and
  // a stale tab all land here.
  if (state.location.twilio_number) {
    return {
      ok: false,
      error:
        `This restaurant already has ${state.location.twilio_number}. Getting a second number ` +
        "would spend another of the account's free numbers for nothing.",
      number: null,
    };
  }

  const assistantId = state.location.vapi_assistant_id;
  if (!assistantId) {
    return { ok: false, error: NO_ASSISTANT_TO_MINT, number: null };
  }

  let created;
  try {
    created = await createPhoneNumber(vapiKey, {
      assistantId,
      name: state.location.name,
      areaCode,
    });
  } catch (err) {
    // An empty pool in one area code is not a fault, and reporting it as
    // one sends an operator to check a deployment that is working. It
    // has its own sentence, which already says nothing was issued, and
    // it names the move that actually helps: a neighbouring area code.
    if (err instanceof NoNumberInAreaCodeError) {
      console.error("[go-live] no number free in that area code", { areaCode: err.areaCode });
      return { ok: false, error: err.message, number: null };
    }
    // A POST that allocates, whose outcome nobody read: a deadline, a
    // 5xx, a body that would not parse. Its own message already says
    // that much and says the dashboard is the only place that settles
    // it, and NOTHING may be added to it -- "No number was issued" here
    // is how one ambiguous failure becomes two billed numbers.
    if (err instanceof NumberOutcomeUnknownError) {
      console.error("[go-live] a new number's fate could not be read", { locationId: state.location.id });
      return { ok: false, error: err.message, number: null };
    }
    console.error("[go-live] could not get a number", err instanceof Error ? err.message : err);
    // Everything left is Vapi refusing the request outright -- a 4xx,
    // which never reached the pool. That, and only that, is what earns
    // the second sentence. Deliberately not `number: created?.number`:
    // there is no record to read.
    return { ok: false, error: `${vapiMessage(err)} No number was issued.`, number: null };
  }

  const saved = await writeNumberIf(
    state.location.id,
    // This whole path is reached only because the column was empty, so
    // "still empty" is exactly what it decided on.
    null,
    { twilio_number: created.number },
    `${created.number} is this restaurant's number, and it rings the assistant.`,
  );

  if (saved.ok) return { ok: true, message: saved.message, number: created.number };

  // Both failures keep the number and name it. It is the only copy the
  // operator has, and re-running this would spend another one.
  return {
    ok: false,
    number: created.number,
    error:
      saved.reason === "lost"
        ? `Vapi issued ${created.number} and pointed it at this restaurant, but this record ` +
          "already had a number written down by the time it landed, so nothing here was " +
          "overwritten. Do not ask for another one — settle which of the two this restaurant " +
          "keeps in the Vapi dashboard."
        : `Vapi issued ${created.number} and pointed it at this restaurant, but saving it here ` +
          "failed. Do not ask for another one — attach that number instead.",
  };
}

/** Take a new number from Vapi and bind it in the same call.
 *
 *  The one-way door. Every caller must have asked first -- but the
 *  guard that counts is here: a restaurant that already has a number
 *  cannot mint a second one by clicking twice, and there is no undo to
 *  offer if it does.
 *
 *  `areaCode` is one of the two values this module accepts from a
 *  browser -- makeItLive takes the same one, for the same act -- and
 *  unlike a phone-number id it is a VALUE rather than a
 *  selector -- there is no set to re-derive it against, because the
 *  operator is choosing where the restaurant's new number will appear to
 *  be. So it is checked for shape here, before a single read runs, and
 *  checked again in createPhoneNumber before a request is built. It
 *  reaches no query, no column and no log line; it reaches Vapi as three
 *  digits or it reaches nothing at all. */
export async function provisionNumberForLocation({
  locationId,
  areaCode,
}: {
  locationId: string;
  areaCode: string;
}): Promise<GoLiveResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  // Before the Postgres read and before the two Vapi reads behind
  // stateForWrite: a typo in this field costs nothing at all, and it
  // should cost nothing at all.
  if (!isAreaCode(areaCode)) return { ok: false, error: AREA_CODE_REFUSAL };

  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    console.error("[go-live] VAPI_PRIVATE_KEY is not configured");
    return { ok: false, error: NO_KEY };
  }

  const read = await stateForWrite(locationId);
  if ("refusal" in read) return read.refusal;

  const done = await runProvision(read.state, vapiKey, areaCode);
  return done.ok ? { ok: true, message: done.message } : { ok: false, error: done.error };
}

/** What the repair actually did.
 *
 *  The three messages below already tell these apart in prose; the
 *  one-click run has to tell them apart as data, because "rebuilt" is
 *  the only one that rotates a tool secret and leaves the phone number
 *  pointed at the old assistant -- and flattening that into
 *  "assistant: done" in a report is how an operator stops reading the
 *  report. */
export type AssistantAction =
  /** The record already named the assistant Vapi has. Nothing happened. */
  | "already-connected"
  /** The column was pointed at Vapi's tagged assistant. Nothing on Vapi
   *  changed, so a restaurant that was answering calls kept answering. */
  | "reconnected"
  /** metadata.dialtone_location_id was put back. No rebuild, no secret
   *  moved. */
  | "relabelled"
  /** A new tool secret, minted and saved, and the assistant provisioned
   *  around it. Two shapes, one act: a brand-new assistant where Vapi
   *  had none -- in which case the number, if any, is still pointed at
   *  the old one until it is attached again -- or a re-provisioning of
   *  the assistant Vapi already holds, when there was no secret on file
   *  to authenticate it with and reconnecting would only have made the
   *  checklist green over a phone that could not take an order. */
  | "rebuilt";

/** repairAssistant, minus the gate and minus the row read. Same split as
 *  runAttach, and it surfaces the one fact the export's prose keeps to
 *  itself: which of the three quite different acts happened. */
async function runRepair(
  location: LocationRow,
  base: string,
  vapiKey: string,
): Promise<
  | { ok: true; message: string; action: AssistantAction }
  | { ok: false; error: string; halt: MakeItLiveHalt | null }
> {
  const locationId = location.id;

  /* An assistant this deployment cannot authenticate to is not one to
     reconnect a record to, and it is certainly not one to point a phone
     number at.
     
     With agent_secret_hash null, lib/agent/auth.ts rejects every tool
     call the assistant makes: it answers, it greets, and then it cannot
     read the menu, take an order or transfer. Both shortcuts below are
     therefore withheld -- reconnecting or re-labelling would write a
     column, turn the checklist green and leave the phone ringing an
     assistant that can do nothing. What is needed is a fresh secret,
     which is the provisioning path at the bottom of this function; when
     Vapi already holds a tagged assistant, upsertAssistant PATCHes that
     same one rather than building a second beside it. */
  const noSecret = !location.agent_secret_hash;

  let tagged;
  try {
    tagged = await findAssistantForLocation(vapiKey, locationId);
  } catch (err) {
    return { ok: false, error: `${vapiMessage(err)} Nothing was changed.`, halt: null };
  }

  if (tagged && !noSecret) {
    if (tagged.id === location.vapi_assistant_id) {
      return {
        ok: true,
        message: "Nothing to repair — this record already points at the assistant Vapi has.",
        action: "already-connected",
      };
    }
    const saved = await write(
      locationId,
      { vapi_assistant_id: tagged.id },
      "Reconnected to the assistant Vapi already had for this restaurant. Nothing on Vapi was " +
        "changed, so a restaurant that was answering calls kept answering them.",
    );
    return saved.ok
      ? { ok: true, message: saved.message, action: "reconnected" }
      : { ok: false, error: saved.error, halt: null };
  }

  // Nothing carries the tag. Before treating that as "there is no
  // assistant", ask whether the one this record names is simply
  // untagged -- the difference between a PATCH of one metadata key and
  // building a second assistant on top of a live one.
  if (location.vapi_assistant_id) {
    let named;
    try {
      named = await getAssistant(vapiKey, location.vapi_assistant_id);
    } catch (err) {
      // Could not ask is not evidence of absence, and absence is what
      // sends this down the rebuild path.
      return { ok: false, error: `${vapiMessage(err)} Nothing was changed.`, halt: null };
    }

    if (named) {
      try {
        await tagAssistantForLocation(vapiKey, named, locationId);
      } catch (err) {
        return { ok: false, error: `${vapiMessage(err)} Nothing was changed.`, halt: null };
      }
      if (!noSecret) {
        return {
          ok: true,
          action: "relabelled",
          message:
            "Labelled the assistant this record already names as this restaurant's. It was on Vapi " +
            "the whole time, just unlabelled — nothing was rebuilt, no tool secret moved, and a " +
            "restaurant that was answering calls kept answering them.",
        };
      }
      // The label is back, but there is still no secret to authenticate
      // this assistant's tool calls with, so the run does not stop here.
      // It falls into provisioning below -- which finds this very
      // assistant by the label just restored and re-provisions it in
      // place, rather than building a second one beside it.
    }
  }

  // Building one. Now `base` matters, because every tool's server.url is
  // built from it and a wrong one fails silently -- as an agent that
  // mysteriously refuses to take an order, months later.
  let origin: URL;
  try {
    origin = new URL(base);
  } catch {
    return {
      ok: false,
      halt: "deployment-address",
      error:
        "Could not work out this deployment's own address, so a new assistant's tools would have " +
        "nowhere to call back to. Nothing was changed.",
    };
  }
  if (origin.protocol !== "https:" || /^(localhost|127\.|\[?::1)/.test(origin.hostname)) {
    return {
      ok: false,
      halt: "deployment-address",
      error:
        `This restaurant's assistant has to be provisioned, and that cannot be done from ${origin.origin} — ` +
        "Vapi has to be able to reach the tools over https from the internet. Reconnecting an " +
        "existing assistant works anywhere; provisioning one does not. Nothing was changed.",
    };
  }

  const { data: hoursData, error: hoursError } = await supabaseAdmin()
    .from("hours")
    .select("day_of_week, open_time, close_time, is_closed")
    .eq("location_id", locationId);

  if (hoursError) {
    console.error("[go-live] could not read the hours", { code: hoursError.code });
    return {
      ok: false,
      halt: null,
      error: "Could not read this restaurant's hours. Nothing was changed.",
    };
  }

  // Whether Vapi already holds something for this restaurant decides
  // both what to SAY afterwards and, far more importantly, what may be
  // deleted if the write below fails: upsertAssistant PATCHes a tagged
  // assistant and only creates one when there is none.
  const reprovisioning = tagged !== null || location.vapi_assistant_id !== null;

  try {
    // Mints the secret, PATCHes or creates the assistant, then writes
    // agent_secret_hash and vapi_assistant_id together -- in that order,
    // for the reason its own header gives.
    await provisionAssistantForLocation({
      location,
      hours: (hoursData ?? []) as HoursRow[],
      base: origin.origin,
      vapiKey,
    });
  } catch (err) {
    console.error("[go-live] could not build the assistant", err instanceof Error ? err.message : err);

    /* The one failure that leaves something behind on Vapi.
     *
     * AssistantSecretWriteError means Vapi accepted the assistant --
     * tagged with this location id, carrying a brand-new secret in nine
     * tool headers -- and the single UPDATE that saves the hash did not
     * land. Left alone, the next press finds that orphan BY ITS TAG,
     * reconnects to it, and the checklist goes green over an assistant
     * whose every tool call 401s. So it is deleted, exactly as
     * lib/provisioning/create-restaurant.ts deletes it for the identical
     * failure.
     *
     * `created` is what makes that safe. When Vapi already had a tagged
     * assistant, upsertAssistant PATCHED it -- deleting THAT would take
     * a restaurant that is answering calls off the air to tidy up a
     * failed write, which is far worse than the state being repaired. */
    if (err instanceof AssistantSecretWriteError) {
      if (err.created) {
        try {
          await deleteAssistant(vapiKey, err.assistantId);
          return {
            ok: false,
            halt: null,
            error:
              "Vapi accepted a new assistant but saving its tool secret here failed, so the " +
              "half-made assistant was removed again rather than left where the next repair " +
              "would reconnect to it. Nothing was changed. Try again.",
          };
        } catch (cleanup) {
          console.error(
            "[go-live] could not remove the half-made assistant",
            cleanup instanceof Error ? cleanup.message : cleanup,
          );
          return {
            ok: false,
            halt: null,
            error:
              `Vapi accepted a new assistant (${err.assistantId}) but saving its tool secret here ` +
              "failed, and removing it again failed too. Delete it in the Vapi dashboard before " +
              "repairing this restaurant again — left there, it looks like this restaurant's " +
              "assistant and cannot authenticate a single tool call.",
          };
        }
      }
      return {
        ok: false,
        halt: null,
        error:
          "Vapi re-provisioned this restaurant's assistant with a fresh tool secret, but saving " +
          "that secret here failed — so its tool calls cannot be authenticated until this is " +
          "repaired again. Nothing on Vapi was deleted: it is the assistant this restaurant " +
          "answers on. Press repair again.",
      };
    }

    return {
      ok: false,
      halt: null,
      error:
        err instanceof ProvisioningError || err instanceof Error
          ? `Could not build the assistant: ${vapiMessage(err)}`
          : "Could not build the assistant.",
    };
  }

  return {
    ok: true,
    action: "rebuilt",
    message: reprovisioning
      ? "Re-provisioned this restaurant's assistant and minted it a fresh tool secret — there " +
        "was none on file, so every tool call it made was being rejected. The number, if there " +
        "is one, still rings it."
      : "Built a new assistant and rotated this restaurant's tool secret. The phone number was " +
        "not re-pointed — attach it again so it rings the new assistant.",
  };
}

/** Reconnect this record to its Vapi assistant, or build one.
 *
 *  Three quite different acts behind one button, and the difference is
 *  what Vapi already has:
 *
 *    * An assistant tagged for this location exists -> this is a
 *      database repair. The column is pointed at it and NOTHING on Vapi
 *      changes. The tool secret is untouched, so an assistant that is
 *      answering calls right now keeps answering them. This is the path
 *      the drifted live restaurant needs.
 *    * No tagged assistant, but the assistant this record NAMES is still
 *      there -> the tag was rubbed off (cloned, restored or edited in
 *      the Vapi dashboard), and the repair is to put it back. One PATCH
 *      of one metadata key. Nothing is created and no secret moves.
 *      Without this branch that assistant read as absent, and absent
 *      means "build a replacement" -- which forks a live assistant and
 *      rotates the secret the original is still authenticating its tool
 *      calls with, so a restaurant that was working silently loses its
 *      menu, hours and ordering while the number keeps ringing the old
 *      one.
 *    * Neither -> one is built, which mints a new tool secret and
 *      writes its hash. Every tool URL is rebuilt from `base`.
 *
 *  `base` is only load-bearing on the second path, which is the only one
 *  that validates it: an assistant whose nine tools point at localhost
 *  is not a repair, it is a restaurant that quietly cannot take orders.
 *  Reconnecting a record needs no callback address at all, and refusing
 *  to do it on a deployment that happens to be reachable only privately
 *  would be refusing the safest operation in this file. */
export async function repairAssistant({
  locationId,
  base,
}: {
  locationId: string;
  base: string;
}): Promise<GoLiveResult> {
  const denied = await gate(locationId);
  if (denied) return denied;

  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    console.error("[go-live] VAPI_PRIVATE_KEY is not configured");
    return { ok: false, error: NO_KEY };
  }

  const read = await rowForWrite(locationId);
  if ("refusal" in read) return read.refusal;

  const done = await runRepair(read.row, base, vapiKey);
  return done.ok ? { ok: true, message: done.message } : { ok: false, error: done.error };
}

/* ── one click ─────────────────────────────────────────────────────── */

/* MAKE IT LIVE
 * ------------
 * One button that does every step a machine may do by itself, in order,
 * and stops at the one blocker no button can resolve.
 *
 * THE ORDER, AND WHY IT IS THAT ORDER
 *
 *   S0  gate            currentPlatformAdmin() + uuid shape. No I/O on
 *                       the refusing path.
 *   S1  derive          getGoLiveState() -- the one authority. Postgres
 *                       AND Vapi.
 *   S2  vapi            refuse outright if Vapi could not be read.
 *                       Nothing is turned on against unread facts.
 *   S3  fallback        VERIFY ONLY. Missing -> refuse, and say which
 *                       field. No write, no Vapi mutation.
 *   S4  assistant       runRepair(). Always before the number.
 *   S5  re-derive       but only if S4 changed something.
 *   S6  number          planNumber() -> reuse, reuse again, or mint.
 *   S7  live            setLocationLive({ live: true }).
 *
 * Fallback first because it is the only blocker no button can clear, so
 * a run that reached S6 without it was always going to stop -- and S6 is
 * the step that can mint a real, billed, undeletable outside resource.
 * Checking it first is what makes "provisioning is the last resort" true
 * in time as well as in priority. It is also what stops the S4 build
 * path failing obscurely: provisionAssistantForLocation throws outright
 * on a null fallback_human_number, and "Could not build the assistant:
 * ..." is a bad way to learn that one field is empty.
 *
 * The assistant before the number because both attach and provision
 * refuse without a vapi_assistant_id, and because repairAssistant's
 * rebuild branch ends with "The phone number was not re-pointed --
 * attach it again". Attaching second closes that follow-up
 * automatically: after a rebuild, S5's re-derivation sees the column's
 * number still claimed by this restaurant and S6 re-points it at the new
 * assistant. This is the first thing in the product that closes it.
 *
 * is_live IS WRITTEN BY EXACTLY ONE FUNCTION, AND IT IS NOT THIS ONE.
 * S7 calls setLocationLive, which reads the row and Vapi again and
 * refuses on any standing blocker. That -- not a rollback -- is what
 * makes "live with no working number" unreachable: there is no ordering
 * of failures in which the is_live write happens while the number check
 * is not ok.
 *
 * THE KILL SWITCH IS NEVER TOUCHED. A restaurant whose kill switch is on
 * gets turned live and setLocationLive's own message says every call
 * still goes straight to a person. Silently undoing somebody's emergency
 * act is not a thing a convenience button may do.
 *
 * ALMOST NOTHING IS ROLLED BACK. Not the rotated secret (its plaintext
 * only ever existed inside the Vapi payload), not the bound number (the
 * binding is the correct end state and the next render narrates it), and
 * above all not a provisioned number -- see runProvision. The rollback
 * for a provisioned number is reporting it, which is why `newNumber` is
 * populated on the failure branch too and the dialog is shown on
 * `newNumber !== null` regardless of `ok`.
 *
 * The one exception is an assistant Vapi CREATED in this run whose
 * secret hash then failed to save: that one is deleted, in runRepair,
 * because leaving it is worse than losing it. It carries this location's
 * tag and no working secret, so the next press finds it, reconnects to
 * it, and the checklist goes green over an agent that answers the phone
 * and then cannot read the menu. An assistant that was PATCHED rather
 * than created is never deleted -- it is the one the restaurant is
 * answering on.
 */

/** What this run did about the phone number. */
export type NumberAction =
  /** The column's number already rings this assistant. No PATCH. */
  | "already-bound"
  /** A number this restaurant already claimed, re-pointed and written
   *  down. */
  | "attached-own"
  /** An unclaimed number already on the Vapi account. */
  | "attached-free"
  /** POST /phone-number. The one-way door. */
  | "provisioned";

export type MakeItLiveStepOutcome =
  /** Re-derived green. Nothing was attempted. */
  | "already-ok"
  /** This run changed something. */
  | "changed"
  /** A human has to act. Nothing was attempted. */
  | "refused"
  /** Attempted, and did not land. */
  | "failed"
  /** An earlier step stopped the run. */
  | "not-reached";

export type MakeItLiveStep =
  | { key: "fallback"; outcome: MakeItLiveStepOutcome; note: string }
  | {
      key: "assistant";
      outcome: MakeItLiveStepOutcome;
      note: string;
      action: AssistantAction | null;
    }
  | {
      key: "number";
      outcome: MakeItLiveStepOutcome;
      note: string;
      action: NumberAction | null;
      number: string | null;
    }
  | { key: "live"; outcome: MakeItLiveStepOutcome; note: string };

/** Everything the handover dialog needs, and nothing it does not.
 *
 *  Populated ONLY when this run sent POST /phone-number -- including on
 *  the failure branch, because a number that exists is the operator's
 *  most urgent fact whether or not the rest of the run landed. */
export type NewNumberHandover = {
  /** Vapi's own E.164 string, verbatim. Never re-derived, never
   *  re-formatted for storage: app/api/twilio/voice/route.ts matches
   *  inbound calls on this exact string. */
  e164: string;
  /** The same digits grouped for reading down a phone. Display only. */
  spoken: string;
  /** The restaurant's own line -- the number whose calls have to be
   *  forwarded TO e164. Null means it has no line of its own, so there
   *  is nothing to forward and it publishes e164 directly. The same
   *  distinction forwardingCheck() calls "na". */
  businessPhone: string | null;
  /** Who has to be told to set the forwarding up. Null when unknown. */
  carrier: string | null;
  locationName: string;
};

/** Where a run stopped, when it stopped for a reason no button on this
 *  panel can resolve. `fallback` is the only one with a control here,
 *  which is why `focus` exists beside it. */
export type MakeItLiveHalt =
  /** A fact only a human knows. */
  | "fallback"
  /** The other fact only a human knows, and the second of the two with
   *  a control on this panel: a number would have to be minted and no
   *  person has said which area code to mint it in. The confirmation
   *  behind "Make it live" is where it gets answered, and "Get a new
   *  number…" is the other way to the same field. */
  | "area-code"
  /** Nothing may be turned on against facts nobody could read. */
  | "vapi-unreadable"
  /** Reuse cannot be proved impossible, so nothing may be minted. */
  | "ownership-unreadable"
  /** A claim only a person can settle in Vapi's own console. */
  | "vapi-dashboard"
  /** An assistant must be BUILT and this deployment's address is not a
   *  public https one. */
  | "deployment-address"
  /** Reserved. Another run holds this restaurant's number claim -- which
   *  needs the cross-instance claim column described on
   *  writeNumberIf. Not reachable until that migration ships; the
   *  in-process single flight below awaits rather than halting. */
  | "already-running";

/** A short honest summary of where the restaurant ended up.
 *
 *  Deliberately NOT a GoLiveState. The panel re-renders from
 *  getGoLiveState() after the action's revalidatePath, and that render is
 *  always fresher than anything carried out of a mutation. This is for
 *  the report sentence only. */
export type MakeItLiveFinal = {
  isLive: boolean;
  number: string | null;
  killSwitchOn: boolean;
  assistantId: string | null;
};

export type MakeItLiveResult =
  | {
      ok: true;
      message: string;
      steps: MakeItLiveStep[];
      newNumber: NewNumberHandover | null;
      final: MakeItLiveFinal;
    }
  | {
      ok: false;
      error: string;
      steps: MakeItLiveStep[];
      newNumber: NewNumberHandover | null;
      /** Null when this run has no account of where the restaurant ended
       *  up that is worth handing back -- the first read failed, or a
       *  re-read after a write did. A stale summary is worse than none. */
      final: MakeItLiveFinal | null;
      halt: MakeItLiveHalt | null;
      /** A UI instruction, not a fact-claim: exactly one field in this
       *  panel can be the answer, and this names it. */
      focus: "fallback" | null;
      blockedBy: GoLiveCheckKey[];
    };

/** E.164 grouped for reading aloud: "+1 (510) 626-8819".
 *
 *  Display only. Never stored, never sent to Vapi, never compared --
 *  locations.twilio_number holds Vapi's own string and the Twilio voice
 *  route matches on it. Anything that is not a NANP number comes back
 *  unchanged rather than guessed at. */
export function spokenNumber(e164: string): string {
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return nanp ? `+1 (${nanp[1]}) ${nanp[2]}-${nanp[3]}` : e164;
}

/** What to do about the phone number, decided from facts alone.
 *
 *  Pure, and the only place "reuse or mint" is decided. It never
 *  re-implements ownership: it consumes classifyNumbers' rows and reads
 *  `claim` and `attachable`, which is where "may this restaurant claim
 *  that number" already lives.
 *
 *  Three properties worth stating, because each is a way this could hurt
 *  somebody:
 *
 *    * Reuse beats minting, always. Minting is the one-way door.
 *    * A non-null twilio_number is never overwritten. This function's
 *      authority extends to adding what is missing, never to replacing
 *      what is on file -- "the number moved to another provider" and
 *      "the number was released" are facts only a human has.
 *    * `claimsKnown` false refuses everything, including minting. The
 *      standalone provision button does not care about the claimant read
 *      ("getting a brand-new number does not depend on it", which is
 *      right for a button a person pressed on purpose). It is wrong
 *      here: this run's whole licence to spend a one-way-door resource
 *      is that it PROVED reuse was impossible, and with the claimant
 *      read lost it has proved nothing. */
export type NumberPlan =
  | { kind: "already-bound" }
  | { kind: "attach"; id: string; number: string; because: "own" | "free" }
  | { kind: "provision" }
  | { kind: "halt"; halt: MakeItLiveHalt; note: string };

/* `assistantId` earns its place here now that AttachableNumber carries
   the assistant each row points at. It is NOT the "there is nothing to
   point a number at" assertion -- that stays at the call site, where
   runAttach and runProvision already enforce it. It answers a different
   question, and one only this function can ask: is one of these rows
   already ringing THIS restaurant's assistant while being unattachable?
   That restaurant is answering calls on a number nothing here can write
   down, and minting a second one beside it spends the one irreversible
   resource in the feature on a problem it cannot fix. */
export function planNumber({
  numberCheckOk,
  onFile,
  numbers,
  claimsKnown,
  assistantId,
}: {
  /** numberCheck's status === "ok", from the freshly built checklist. */
  numberCheckOk: boolean;
  /** locations.twilio_number, from the read this decision is made on. */
  onFile: string | null;
  /** classifyNumbers' output for this location. */
  numbers: AttachableNumber[];
  /** ownershipError === null. False means every row is a refusal and
   *  "nobody owns it" is not an answer this may reach. */
  claimsKnown: boolean;
  /** locations.vapi_assistant_id, from the same read. Null means no row
   *  can be ringing this restaurant's assistant, because it has none. */
  assistantId: string | null;
}): NumberPlan {
  if (numberCheckOk) return { kind: "already-bound" };

  if (!claimsKnown) {
    return {
      kind: "halt",
      halt: "ownership-unreadable",
      note:
        "Which restaurant owns which number could not be read, so neither reusing a number nor " +
        "getting a new one is safe — a new one might duplicate one this restaurant already pays " +
        "for.",
    };
  }

  // Deterministic: two runs deriving the same account state pick the
  // same row, so their PATCHes converge on one binding instead of
  // splitting the account across two restaurants. bindPhoneNumber is
  // idempotent under repetition.
  const inOrder = (rows: AttachableNumber[]) =>
    [...rows].sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));

  if (onFile !== null) {
    const mine = numbers.find((n) => n.number === onFile);
    if (mine && mine.attachable) {
      // The number that may already be on a door. It wins over every
      // free number on the account.
      return { kind: "attach", id: mine.id, number: mine.number, because: "own" };
    }
    return {
      kind: "halt",
      halt: "vapi-dashboard",
      note: mine
        ? `${onFile} is on file for this restaurant but it is ${mine.blockedReason ?? "not attachable"}. ` +
          "Nothing here can settle that — clear the other claim in the Vapi dashboard first."
        : `${onFile} is on file for this restaurant but it is not a number on the Vapi account. ` +
          "Nothing here will replace a number that may be printed on a door — settle where it " +
          "went in the Vapi dashboard, then attach one that is on the account.",
    };
  }

  // No column value, so "mine" can only have come from byAssistant: a
  // number already ringing this restaurant's assistant, which the
  // checklist already narrates as "attach it to write it down here".
  const own = inOrder(numbers.filter((n) => n.claim === "mine" && n.attachable))[0];
  if (own) return { kind: "attach", id: own.id, number: own.number, because: "own" };

  /* Callers are already reaching this restaurant on a number, and the
     claim on it is contested -- the database says one restaurant owns it
     and Vapi says another does -- so classifyNumbers refuses it to
     everybody and no row here reads as "mine".
  
     Without this, the empty column falls all the way through to
     provisioning: a second number is minted for a restaurant that is
     answering the phone this minute, billed per minute for nothing,
     while the double claim it was bought to work around stands
     untouched. numberCheck already says the true thing about this state
     and says nothing here can settle it; this is the same halt the
     non-empty column gets a few lines above, for the same class of row. */
  const contested = assistantId
    ? inOrder(numbers.filter((n) => n.assistantId === assistantId && !n.attachable))[0]
    : undefined;
  if (contested) {
    return {
      kind: "halt",
      halt: "vapi-dashboard",
      note:
        `${contested.number} already rings this restaurant's assistant on Vapi, but it is ` +
        `${contested.blockedReason ?? "not attachable"}, so it cannot be written down here. ` +
        "Nothing here can settle that — clear the other claim in the Vapi dashboard first, then " +
        "attach it. Getting a new number would leave two ringing one assistant and settle " +
        "nothing.",
    };
  }

  const free = inOrder(numbers.filter((n) => n.claim === "free" && n.attachable))[0];
  if (free) return { kind: "attach", id: free.id, number: free.number, because: "free" };

  return { kind: "provision" };
}

/* ── the run ───────────────────────────────────────────────────────── */

const FALLBACK_REFUSAL =
  "Not turned on: there is no fallback number, and that is the one thing here nobody can work " +
  "out for you. Transfers, allergy hand-offs and the kill switch all dial it. Type the number a " +
  "caller should reach when the agent cannot help, save it, and press this again.";

/* The same halt, for a restaurant that HAS a fallback number that
   cannot be dialled. Its own sentence rather than the one above,
   because "there is no fallback number" is not true of it and an
   operator looking at a number on the screen would read that as the
   panel being broken. What is wrong with it is in the check's own note,
   which travels with this refusal as the fallback step's note. */
const FALLBACK_UNDIALABLE =
  "Not turned on: the fallback number on file is not one that can be dialled, and that is the " +
  "one thing here nobody can work out for you. Transfers, allergy hand-offs and the kill switch " +
  "all dial it. Fix it in the field below, save it, and press this again.";

/* WHAT THE ONE-CLICK DOES ABOUT THE AREA CODE, AND WHY.
 *
 * It never picks one. It mints only in a code a person handed it, and
 * when it has none it refuses this one step, names where the code gets
 * typed, and turns nothing on.
 *
 * The area code is not an implementation detail of provisioning. It is
 * the visible half of a number that goes on a door, a menu and a Google
 * listing, that a customer reads and dials, and that no undo in this
 * feature can take back once Vapi has issued it -- lib/vapi/phone-numbers.ts
 * ships no release wrapper on purpose. There is no honest source for a
 * guess: the operator's own area code is wherever the operator happens
 * to be sitting, a house constant would put a Pittsburgh number on a
 * Berkeley door, and Vapi's own default is whatever its pool hands over.
 * Every one of those is a mistake that only becomes visible after the
 * number is real and unreturnable.
 *
 * GoLiveState.defaultAreaCode -- business_phone, then
 * fallback_human_number -- is a SUGGESTION and is treated as one on both
 * roads. The standalone button offers it in a field the operator can
 * change; this run does not read it at all. Nor could it honestly: the
 * second source is a person's mobile, and areaCodeOf cannot tell a bare
 * ten-digit foreign number from a NANP one either. Both are fine to
 * offer a person and neither is fit to spend unread.
 *
 * So `areaCode` arrives from the confirmation the operator answered, or
 * it does not arrive and this stops -- exactly as it stops on a missing
 * fallback number, and for the same reason: it has hit a fact only a
 * person has. Refusing costs one more press of a button that is already
 * under the operator's thumb. Guessing costs the number. */
const NO_AREA_CODE_NOTE =
  "There is no area code to get a number in. This restaurant has no number of its own on file " +
  "to take one from, and nothing here will pick one for it — the area code is the part of the " +
  "new number its customers will see and dial. Use “Get a new number…” below and type the one " +
  "this restaurant wants, or put its own phone number on the record first and press this again.";

/** The same refusal when the record DOES suggest a code, which changes
 *  only what there is to say next: there is something to offer, and it
 *  still has to be looked at by somebody before it is spent. */
function mintNeedsAreaCode(suggestion: string): string {
  return (
    "Nothing on the account can be reused, so this restaurant needs a brand-new number — and " +
    "the area code it is issued in is the part its customers read off a door and dial, which " +
    `nothing here will choose on their behalf. This restaurant's own number is in ${suggestion}. ` +
    "Press “Make it live” again to confirm that one or type another, or use “Get a new number…” " +
    "below. Nothing was requested and nothing was spent."
  );
}

type StepBag = {
  fallback: Extract<MakeItLiveStep, { key: "fallback" }>;
  assistant: Extract<MakeItLiveStep, { key: "assistant" }>;
  number: Extract<MakeItLiveStep, { key: "number" }>;
  live: Extract<MakeItLiveStep, { key: "live" }>;
};

/** The four steps, none of them attempted. */
function untriedSteps(): StepBag {
  return {
    fallback: { key: "fallback", outcome: "not-reached", note: "Not tried." },
    assistant: { key: "assistant", outcome: "not-reached", note: "Not tried.", action: null },
    number: {
      key: "number",
      outcome: "not-reached",
      note: "Not tried.",
      action: null,
      number: null,
    },
    live: { key: "live", outcome: "not-reached", note: "Not tried." },
  };
}

function listSteps(bag: StepBag): MakeItLiveStep[] {
  return [bag.fallback, bag.assistant, bag.number, bag.live];
}

function checkOf(state: GoLiveState, key: GoLiveCheckKey): GoLiveCheck | undefined {
  return state.checks.find((c) => c.key === key);
}

function finalOf(state: GoLiveState, over: Partial<MakeItLiveFinal> = {}): MakeItLiveFinal {
  return {
    isLive: state.location.is_live,
    number: state.location.twilio_number,
    killSwitchOn: state.location.kill_switch_on,
    assistantId: state.location.vapi_assistant_id,
    ...over,
  };
}

function handoverOf(location: LocationRow, e164: string): NewNumberHandover {
  return {
    e164,
    spoken: spokenNumber(e164),
    businessPhone: location.business_phone,
    carrier: location.carrier_name,
    locationName: location.name,
  };
}

/** The refusal a caller who is not staff gets, in this function's shape.
 *  Byte-identical to every other refusal in this module. */
function notFoundRun(): MakeItLiveResult {
  return {
    ok: false,
    error: NOT_FOUND_TEXT,
    steps: listSteps(untriedSteps()),
    newNumber: null,
    final: null,
    halt: null,
    focus: null,
    blockedBy: [],
  };
}

/** Runs, keyed by restaurant, so one operator's double-click cannot
 *  become two runs.
 *
 *  This module is server-only, so the map is a server-process singleton.
 *  It covers the hazard that actually happens -- one operator, one
 *  double-click, one lambda -- completely and for free. It covers
 *  nothing across instances, and Vercel runs many; see
 *  writeNumberIf for what does and does not survive that. */
const inFlight = new Map<string, Promise<MakeItLiveResult>>();

/** Turn a restaurant on, doing every step a machine may do by itself.
 *
 *  `base` is this deployment's own origin, read off the request by the
 *  action and never off a form field. It is load-bearing on exactly one
 *  path -- building a brand-new assistant -- same as repairAssistant.
 *
 *  The only caller-supplied value is `locationId`. Everything else is
 *  re-read inside. There is no number id, no assistant id and no "skip
 *  the checks" flag to hand it, so it cannot be aimed at another tenant
 *  or at a resource this restaurant does not own. */
export async function makeItLive({
  locationId,
  base,
  areaCode,
}: {
  locationId: string;
  base: string;
  /** What the operator answered when this run's confirmation asked
   *  which area code a brand-new number should be issued in. Undefined
   *  when they were never asked, which is most runs -- almost none of
   *  them reach the mint. It is a VALUE and not a selector, so it is
   *  checked for shape here and again in createPhoneNumber, it reaches
   *  no query, no column and no log line, and its absence is a refusal
   *  rather than a default. */
  areaCode?: string;
}): Promise<MakeItLiveResult> {
  // First statement, before any argument is looked at, and before the
  // single-flight map: joining a run in progress is itself an answer,
  // and a stranger does not get one.
  const admin = await currentPlatformAdmin();
  if (!admin) return notFoundRun();
  if (!UUID.test(locationId)) return notFoundRun();

  const running = inFlight.get(locationId);
  if (running) return running;

  const run = (async () => {
    try {
      return await runMakeItLive(locationId, base, areaCode);
    } finally {
      inFlight.delete(locationId);
    }
  })();
  inFlight.set(locationId, run);
  return run;
}

async function runMakeItLive(
  locationId: string,
  base: string,
  areaCode: string | undefined,
): Promise<MakeItLiveResult> {
  const steps = untriedSteps();

  const stopped = (
    error: string,
    over: {
      halt?: MakeItLiveHalt | null;
      focus?: "fallback" | null;
      blockedBy?: GoLiveCheckKey[];
      newNumber?: NewNumberHandover | null;
      final?: MakeItLiveFinal | null;
    } = {},
  ): MakeItLiveResult => ({
    ok: false,
    error,
    steps: listSteps(steps),
    newNumber: over.newNumber ?? null,
    final: over.final ?? null,
    halt: over.halt ?? null,
    focus: over.focus ?? null,
    blockedBy: over.blockedBy ?? [],
  });

  // S2, hoisted: without a key nothing about the assistant or the number
  // can be read, and nothing is turned on against unread facts.
  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    console.error("[go-live] VAPI_PRIVATE_KEY is not configured");
    return stopped(`${NO_KEY} Nothing was turned on.`, { halt: "vapi-unreadable" });
  }

  // S1. The one authority: Postgres and Vapi, together.
  const read = await stateForWrite(locationId);
  if ("refusal" in read) {
    const refusal = read.refusal;
    return stopped(refusal.ok ? NOT_FOUND_TEXT : refusal.error);
  }
  let state = read.state;

  // S2.
  if (state.vapiError) {
    return stopped(`${state.vapiError} Nothing was turned on.`, {
      halt: "vapi-unreadable",
      final: finalOf(state),
      blockedBy: blockersOf(state.checks),
    });
  }

  // S3. Verify only. No write, no Vapi mutation, nothing spent -- this
  // is the blocker no button can clear, and the run was always going to
  // stop here.
  //
  // Asked of the checklist rather than of the column: "set" and "can be
  // dialled" are not the same question, and this step must refuse
  // everything the checklist refuses or the run walks past a blocker
  // the panel is showing and mints a number for a restaurant that
  // cannot finish. See fallbackCheck.
  const fallbackRow = checkOf(state, "fallback");
  const fallbackNote = fallbackRow?.note ?? "";
  if (fallbackRow?.status !== "ok") {
    steps.fallback = { key: "fallback", outcome: "refused", note: fallbackNote };
    steps.assistant = {
      key: "assistant",
      outcome: "not-reached",
      note: "Not tried — the fallback number comes first.",
      action: null,
    };
    steps.number = {
      key: "number",
      outcome: "not-reached",
      note: "Not tried — nothing is bought for a run that cannot finish.",
      action: null,
      number: null,
    };
    const refusal = state.location.fallback_human_number
      ? FALLBACK_UNDIALABLE
      : FALLBACK_REFUSAL;
    return stopped(refusal, {
      halt: "fallback",
      focus: "fallback",
      blockedBy: ["fallback"],
      final: finalOf(state),
    });
  }
  steps.fallback = { key: "fallback", outcome: "already-ok", note: fallbackNote };

  // S4. Always before the number: attach and provision both refuse
  // without an assistant, and a rebuild leaves the number pointed at the
  // old one.
  const assistantCheckRow = checkOf(state, "assistant");
  if (assistantCheckRow?.status === "ok") {
    steps.assistant = {
      key: "assistant",
      outcome: "already-ok",
      note: assistantCheckRow.note,
      action: null,
    };
  } else {
    const repaired = await runRepair(state.location, base, vapiKey);
    if (!repaired.ok) {
      steps.assistant = { key: "assistant", outcome: "failed", note: repaired.error, action: null };
      return stopped(repaired.error, {
        halt: repaired.halt,
        final: finalOf(state),
        blockedBy: blockersOf(state.checks),
      });
    }

    const changed = repaired.action !== "already-connected";
    steps.assistant = {
      key: "assistant",
      outcome: changed ? "changed" : "already-ok",
      note: repaired.message,
      action: repaired.action,
    };

    // S5. Only when something of ours changed -- a rebuild invalidates
    // every number classification S1 produced.
    if (changed) {
      const again = await stateForWrite(locationId);
      if ("refusal" in again) {
        const refusal = again.refusal;
        const why = refusal.ok ? NOT_FOUND_TEXT : refusal.error;
        return stopped(
          `${repaired.message} Then this restaurant could not be read again, so the number was ` +
            `not touched and it was not turned on. ${why}`,
        );
      }
      state = again.state;
      if (state.vapiError) {
        return stopped(
          `${repaired.message} Then Vapi stopped answering, so the number was not touched and ` +
            `it was not turned on. ${state.vapiError}`,
          { halt: "vapi-unreadable", final: finalOf(state) },
        );
      }
    }
  }

  // S6. Reuse, reuse again, then -- and only then -- mint.
  const numberCheckRow = checkOf(state, "number");
  const plan = planNumber({
    numberCheckOk: numberCheckRow?.status === "ok",
    onFile: state.location.twilio_number,
    numbers: state.numbers,
    claimsKnown: state.ownershipError === null,
    assistantId: state.location.vapi_assistant_id,
  });

  let newNumber: NewNumberHandover | null = null;
  let numberNow = state.location.twilio_number;

  if (plan.kind === "halt") {
    steps.number = {
      key: "number",
      outcome: "refused",
      note: plan.note,
      action: null,
      number: null,
    };
    return stopped(`Not turned on. ${plan.note}`, {
      halt: plan.halt,
      final: finalOf(state),
      blockedBy: blockersOf(state.checks),
    });
  }

  if (plan.kind === "already-bound") {
    steps.number = {
      key: "number",
      outcome: "already-ok",
      note: numberCheckRow?.note ?? "",
      action: "already-bound",
      number: state.location.twilio_number,
    };
  } else if (!state.location.vapi_assistant_id) {
    // Asserted at the call site, as planNumber's header says. Reachable
    // only if the assistant vanished between S5 and here.
    const why = plan.kind === "attach" ? NO_ASSISTANT_TO_ATTACH : NO_ASSISTANT_TO_MINT;
    steps.number = { key: "number", outcome: "failed", note: why, action: null, number: null };
    return stopped(why, { final: finalOf(state), blockedBy: blockersOf(state.checks) });
  } else if (plan.kind === "attach") {
    const attached = await runAttach(state, plan.id, vapiKey);
    if (!attached.ok) {
      steps.number = {
        key: "number",
        outcome: "failed",
        note: attached.error,
        action: null,
        number: attached.number,
      };
      // A bound number with an unwritten column is not a rollback
      // candidate: the binding is the correct end state, the restaurant
      // is reachable on it now, and the next render narrates it.
      // runAttach's own sentence already names the number in that case,
      // on both roads, so this only adds what is specific to a run.
      return stopped(
        attached.number ? `${attached.error} It was not turned on.` : attached.error,
        { final: finalOf(state), blockedBy: blockersOf(state.checks) },
      );
    }
    numberNow = attached.number;
    steps.number = {
      key: "number",
      outcome: "changed",
      note: attached.message,
      action: plan.because === "own" ? "attached-own" : "attached-free",
      number: attached.number,
    };
  } else if (!isAreaCode(areaCode)) {
    /* The one-way door, and no person has said which area code it opens
       onto. See the memo above NO_AREA_CODE_NOTE for why this refuses
       rather than picks -- and note that it refuses just as flatly when
       the record DOES suggest a code, because a suggestion nobody looked
       at is a guess with a citation. Nothing was requested and nothing
       was spent. */
    const note = state.defaultAreaCode
      ? mintNeedsAreaCode(state.defaultAreaCode)
      : NO_AREA_CODE_NOTE;
    steps.number = {
      key: "number",
      outcome: "refused",
      note,
      action: null,
      number: null,
    };
    return stopped(`Not turned on. ${note}`, {
      halt: "area-code",
      final: finalOf(state),
      blockedBy: blockersOf(state.checks),
    });
  } else {
    // The one-way door, reached only because reuse was proved
    // impossible, in the area code a person confirmed.
    const got = await runProvision(state, vapiKey, areaCode.trim());
    if (got.number) newNumber = handoverOf(state.location, got.number);
    if (!got.ok) {
      steps.number = {
        key: "number",
        outcome: "failed",
        note: got.error,
        action: got.number ? "provisioned" : null,
        number: got.number,
      };
      return stopped(got.error, {
        newNumber,
        final: finalOf(state),
        blockedBy: blockersOf(state.checks),
      });
    }
    numberNow = got.number;
    steps.number = {
      key: "number",
      outcome: "changed",
      note: got.message,
      action: "provisioned",
      number: got.number,
    };
  }

  // S7. The only writer of is_live in the product, and it re-derives all
  // three blockers itself before it writes.
  const wasLive = state.location.is_live;
  const lived = await setLocationLive({ locationId, live: true });
  if (!lived.ok) {
    steps.live = { key: "live", outcome: "failed", note: lived.error };
    return stopped(lived.error, {
      newNumber,
      final: finalOf(state, { number: numberNow }),
      blockedBy: lived.blockedBy ?? [],
    });
  }
  steps.live = { key: "live", outcome: wasLive ? "already-ok" : "changed", note: lived.message };

  // The banner: a short account of what had to be done, then
  // setLocationLive's own sentence, which already carries the kill-switch
  // caveat when there is one. The long version is in the step notes.
  const did: string[] = [];
  if (steps.assistant.action === "reconnected") did.push("Reconnected the assistant.");
  if (steps.assistant.action === "relabelled") did.push("Re-labelled the assistant on Vapi.");
  if (steps.assistant.action === "rebuilt") {
    did.push("Built a new assistant and rotated this restaurant's tool secret.");
  }
  if (steps.number.action === "attached-own" || steps.number.action === "attached-free") {
    did.push(`Attached ${steps.number.number}.`);
  }
  if (steps.number.action === "provisioned") {
    did.push(`Took a new number from Vapi: ${steps.number.number}.`);
  }

  return {
    ok: true,
    message: [...did, lived.message].join(" "),
    steps: listSteps(steps),
    newNumber,
    final: finalOf(state, { isLive: true, number: numberNow }),
  };
}
