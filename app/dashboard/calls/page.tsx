import Link from "next/link";
import {
  CALLS_PER_PAGE,
  CALL_FILTERS,
  getCallsPage,
  getCurrentLocation,
  type CallFilter,
} from "@/lib/data";
import { OUTCOME_TAG, money, mmss, relative, timeIn } from "@/lib/format";

export const metadata = { title: "Calls · Dialtone" };

const isFilter = (value: unknown): value is CallFilter =>
  CALL_FILTERS.some((f) => f.key === value);

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const filter = isFilter(params.filter) ? params.filter : "all";
  const page = Math.max(1, Number(params.page) || 1);

  const location = await getCurrentLocation();
  if (!location) return null;

  const {
    calls,
    total,
    page: currentPage,
    pageCount,
    orderByCall,
    bookingByCall,
    messageByCall,
  } = await getCallsPage(location.id, { filter, page });

  const tz = location.timezone;
  const label = CALL_FILTERS.find((f) => f.key === filter)?.label ?? "All";
  const href = (next: Partial<{ filter: CallFilter; page: number }>) => {
    const q = new URLSearchParams();
    const f = next.filter ?? filter;
    const p = next.page ?? 1;
    if (f !== "all") q.set("filter", f);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `/dashboard/calls?${s}` : "/dashboard/calls";
  };

  /** A message taken on this call, if there was one.
   *
   *  Shown alongside the result rather than instead of it, and shown
   *  even when the call also produced an order: an order is finished
   *  business and a message is a person still waiting for the phone to
   *  ring, so it is the one thing on the row somebody has to act on.
   *  The whole book lives at /dashboard/messages -- including the
   *  messages taken on a call that has no row here at all, which is why
   *  that page and not this one is the place a message can be found. */
  const messageTag = (callId: string) => {
    const taken = messageByCall.get(callId);
    if (!taken) return null;
    return (
      <Link href="/dashboard/messages" className="row-link">
        <span className={taken.open ? "tag tag-accent" : "tag tag-neutral"}>
          {taken.open ? "message · needs a callback" : "message · handled"}
        </span>
      </Link>
    );
  };

  /** What the call produced, in one line. */
  const result = (callId: string, call: (typeof calls)[number]) => {
    const order = orderByCall.get(callId);
    if (order) return `Order #${order.order_number} · ${money(order.total_cents)}`;

    const booking = bookingByCall.get(callId);
    if (booking) {
      return `Table for ${booking.party_size} · ${timeIn(tz, booking.requested_at)}`;
    }

    if (call.transferred_to_human) {
      return call.transfer_reason ?? "Sent to a human";
    }
    if (call.is_spam) return "Auto-dialer, hung up";
    if (!call.answered_at) return "Nobody picked up";
    return "—";
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calls</h1>
          <div className="text-muted sub">
            {total} {label.toLowerCase()}
            {total === 1 ? " call" : " calls"} · {tz}
          </div>
        </div>
      </div>

      {/* Links, not a client control: a filtered log stays shareable and
          survives a refresh. */}
      <nav className="seg filter-seg" aria-label="Filter calls">
        {CALL_FILTERS.map((f) => (
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

      {calls.length === 0 ? (
        <p className="text-muted empty-note">
          {filter === "all"
            ? "No calls yet. Place a test call to hear the agent answer."
            : `No ${label.toLowerCase()} calls in the log.`}
        </p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Caller</th>
                <th>Outcome</th>
                <th>Length</th>
                <th>Result</th>
                <th>Cost</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="num">{timeIn(tz, c.started_at)}</div>
                    <div className="caller-city">{relative(c.started_at)}</div>
                  </td>
                  <td>
                    <div>{c.from_number ?? "Unknown"}</div>
                    <div className="caller-city">
                      {[c.from_city, c.from_state].filter(Boolean).join(", ")}
                    </div>
                  </td>
                  <td>
                    {c.outcome ? (
                      <span className={OUTCOME_TAG[c.outcome]}>{c.outcome}</span>
                    ) : (
                      <span className="tag tag-neutral">{c.status}</span>
                    )}
                  </td>
                  <td className="num">
                    {c.duration_seconds ? mmss(c.duration_seconds) : "—"}
                  </td>
                  <td className="call-result">
                    {messageTag(c.id)}
                    <div>{result(c.id, c)}</div>
                  </td>
                  <td className="num">
                    {money(c.telephony_cost_cents + c.llm_cost_cents)}
                  </td>
                  <td>
                    <Link href={`/dashboard/calls/${c.id}`} className="row-link">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pageCount > 1 ? (
        <div className="pager">
          {currentPage > 1 ? (
            <Link
              href={href({ page: currentPage - 1 })}
              className="btn btn-secondary"
            >
              Newer
            </Link>
          ) : null}
          <span className="text-muted">
            {(currentPage - 1) * CALLS_PER_PAGE + 1}–
            {Math.min(currentPage * CALLS_PER_PAGE, total)} of {total}
          </span>
          {currentPage < pageCount ? (
            <Link
              href={href({ page: currentPage + 1 })}
              className="btn btn-secondary"
            >
              Older
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
