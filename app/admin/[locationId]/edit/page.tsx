import { notFound, redirect } from "next/navigation";
import { isUuid } from "@/lib/admin/edit";

/* /edit is now one page: /admin/<locationId>.
 *
 * WHY THIS FILE STILL EXISTS. The editor's eight tabs and the overview's
 * four subjects became one nine-tab console on /admin/<locationId>, so
 * there is nothing left here to render. But /admin/<id>/edit,
 * /edit?section=menu and /edit#sold-out are bookmarked, pasted into
 * tickets and mailed, and those URLs can never be rewritten. So the
 * route stays and translates.
 *
 * redirect() and NOT permanentRedirect(). A 308 is cached hard by the
 * browser and by every proxy in between; this product is still moving,
 * and a permanent redirect is the one kind you cannot take back without
 * asking every client to clear its cache. 307 is reversible and costs a
 * round trip that only an old link pays.
 *
 * THE HASH SURVIVES WITHOUT BEING TOUCHED, WHICH IS WHY IT IS NOT READ
 * HERE. A fragment is never sent to a server -- there is nothing on this
 * request to read. RFC 7231 §7.1.2 is what saves it: when a Location
 * header carries no fragment of its own, the user agent re-applies the
 * original one. So /edit#menu arrives at
 * /admin/<id>?section=business#menu, and ConsoleTabs' hash handler --
 * which treats the hash as more specific than ?section= for exactly this
 * reason -- corrects the tab on the first client frame. That is the same
 * one-frame flash a hash arrival has always had, and the reason
 * ?section= exists for every link this product writes itself.
 *
 * NOTHING ELSE IS LEFT. maxDuration went with the page: the server
 * actions in ./actions.ts are unchanged and untouched, but they are
 * invoked from /admin/<locationId> now and inherit ITS segment config,
 * which is 300. That page's comment says so where the next reader will
 * be standing. readAssistantDrift and its five helpers moved to
 * lib/admin/drift.ts, and SystemManaged to
 * components/admin/SystemTab.tsx.
 */

/** Where each of the editor's old tabs went.
 *
 *  Seven are the same word. `recording` is the one that moved: the
 *  recording setting and the call log it governs are one ticket, so they
 *  are one tab now, and a bookmark of /edit?section=recording lands on
 *  the tab that holds the field it named.
 *
 *  READ IT THROUGH sectionFor(), NEVER BY INDEXING IT. `section` is
 *  attacker-chosen text off the query string, and an object literal
 *  inherits from Object.prototype -- ?section=constructor would
 *  otherwise return a truthy value that is not a section at all and get
 *  written into the redirect URL. */
const MOVED: Record<string, string> = {
  business: "business",
  hours: "hours",
  answering: "answering",
  service: "service",
  orders: "orders",
  recording: "calls",
  menu: "menu",
  managed: "managed",
};

/** The tab a bare /edit means.
 *
 *  Business, and deliberately NOT the console's own default of Line.
 *  Whoever bookmarked the bare editor meant the editor; landing them on
 *  the go-live panel loses their place, and the first thing the old
 *  /edit painted was Business. */
const BARE = "business";

function sectionFor(value: unknown): string {
  if (typeof value !== "string") return BARE;
  if (!Object.hasOwn(MOVED, value)) return BARE;
  return MOVED[value];
}

export default async function EditLocationRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ locationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locationId } = await params;

  // Same guard, in the same place, as the page this points at. A
  // redirect that passes a malformed id along is a redirect that hands
  // PostgREST a bad uuid cast one hop later.
  if (!isUuid(locationId)) notFound();

  const query = await searchParams;
  redirect(`/admin/${locationId}?section=${sectionFor(query.section)}`);
}
