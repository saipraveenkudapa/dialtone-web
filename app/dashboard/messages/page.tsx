import Link from "next/link";
import { Corners } from "@/components/Corners";
import {
  MESSAGES_PER_PAGE,
  MESSAGE_FILTERS,
  getCurrentLocation,
  getMessagesPage,
  type MessageFilter,
} from "@/lib/data";
import { relative, timeIn } from "@/lib/format";
import { setMessageHandled } from "./actions";

export const metadata = { title: "Messages · Dialtone" };

const isFilter = (value: unknown): value is MessageFilter =>
  MESSAGE_FILTERS.some((f) => f.key === value);

/** The message book.
 *
 *  Every call that used to reach for a human -- an angry caller, "put me
 *  through to the manager", a complaint about last Friday -- now ends as
 *  a row in `messages` instead, and until this screen existed the only
 *  way to see one was to open the call it was taken on, one call at a
 *  time. A message whose call row had not been written yet, or had since
 *  been deleted, carries `call_id: null` and so appeared nowhere at all:
 *  a person told they would be rung back, invisible to the people who
 *  were meant to ring them. This page reads by location, so no message
 *  can hide behind a missing call. */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filter = isFilter(params.filter) ? params.filter : "open";
  const page = Math.max(1, Number(params.page) || 1);

  const location = await getCurrentLocation();
  if (!location) return null; // The layout already explains this case.

  const {
    messages,
    total,
    openTotal,
    page: currentPage,
    pageCount,
  } = await getMessagesPage(location.id, { filter, page });

  const tz = location.timezone;
  const href = (next: Partial<{ filter: MessageFilter; page: number }>) => {
    const q = new URLSearchParams();
    const f = next.filter ?? filter;
    const p = next.page ?? 1;
    if (f !== "open") q.set("filter", f);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `/dashboard/messages?${s}` : "/dashboard/messages";
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Messages</h1>
          <div className="text-muted sub">
            {openTotal === 0
              ? "Nobody is waiting for a callback"
              : `${openTotal} waiting for a callback`}{" "}
            · {tz}
          </div>
        </div>
      </div>

      {/* Links, not a client control, exactly as on the call log: a
          filtered view stays shareable and survives a refresh. */}
      <nav className="seg filter-seg" aria-label="Filter messages">
        {MESSAGE_FILTERS.map((f) => (
          <Link
            key={f.key}
            href={href({ filter: f.key })}
            className={f.key === filter ? "seg-opt is-on" : "seg-opt"}
            aria-current={f.key === filter ? "page" : undefined}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {messages.length === 0 ? (
        <p className="text-muted empty-note">
          {filter === "open"
            ? "No messages waiting. Anything the agent takes for a person to answer shows up here."
            : "No messages yet. The agent takes one whenever a caller needs a person to ring them back."}
        </p>
      ) : (
        <div className="panel">
          {messages.map((m) => (
            <div key={m.id} className="card blueprint admin-facts">
              <Corners />
              <div className="card-kicker">
                {timeIn(tz, m.taken_at)} · {relative(m.taken_at)}
              </div>
              {/* Redacted and length-bounded on the way in
                  (lib/agent/messages.ts), so what a caller said is safe
                  to render as-is. */}
              <p className="card-body">{m.body}</p>
              <dl>
                <div className="fact-row">
                  <dt className="text-muted">From</dt>
                  <dd>{m.caller_name ?? "—"}</dd>
                </div>
                <div className="fact-row">
                  <dt className="text-muted">Call back</dt>
                  <dd className="num">{m.callback_phone ?? "—"}</dd>
                </div>
                <div className="fact-row">
                  <dt className="text-muted">Status</dt>
                  <dd>
                    {m.handled && m.handled_at ? (
                      <span className="tag tag-neutral">
                        handled {timeIn(tz, m.handled_at)}
                      </span>
                    ) : (
                      <span className="tag tag-accent">needs a callback</span>
                    )}
                  </dd>
                </div>
                <div className="fact-row">
                  <dt className="text-muted">Call</dt>
                  <dd>
                    {m.call_id ? (
                      <Link href={`/dashboard/calls/${m.call_id}`} className="row-link">
                        Listen to the call
                      </Link>
                    ) : (
                      // Not an error and not a missing message: the tool
                      // call can land before the telephony webhook writes
                      // the call row, and a call's recording ages out
                      // long before the person stops waiting. The message
                      // is still the whole record either way.
                      <span className="text-muted">No call record</span>
                    )}
                  </dd>
                </div>
              </dl>
              <form action={setMessageHandled}>
                <input type="hidden" name="id" value={m.id} />
                <input type="hidden" name="handled" value={m.handled ? "false" : "true"} />
                <button
                  type="submit"
                  className={m.handled ? "btn btn-ghost" : "btn btn-secondary"}
                >
                  {m.handled ? "Still needs a callback" : "Mark handled"}
                </button>
              </form>
            </div>
          ))}
        </div>
      )}

      {pageCount > 1 ? (
        <div className="pager">
          {currentPage > 1 ? (
            <Link href={href({ page: currentPage - 1 })} className="btn btn-secondary">
              Newer
            </Link>
          ) : null}
          <span className="text-muted">
            {(currentPage - 1) * MESSAGES_PER_PAGE + 1}–
            {Math.min(currentPage * MESSAGES_PER_PAGE, total)} of {total}
          </span>
          {currentPage < pageCount ? (
            <Link href={href({ page: currentPage + 1 })} className="btn btn-secondary">
              Older
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
