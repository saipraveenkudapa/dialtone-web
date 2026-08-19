import Link from "next/link";
import {
  DEFAULT_ORDER_HISTORY_WINDOW,
  ORDERS_PER_HISTORY_PAGE,
  ORDER_HISTORY_WINDOWS,
  getCurrentLocation,
  getOrderHistoryPage,
  type OrderHistoryWindow,
} from "@/lib/data";
import { ORDER_TAG, dateTimeIn, money, relative } from "@/lib/format";

export const metadata = { title: "Finished orders · Dialtone" };

const isWindow = (value: unknown): value is OrderHistoryWindow =>
  ORDER_HISTORY_WINDOWS.some((w) => w.key === value);

/** THE ORDERS THE BOARD IS FINISHED WITH.
 *
 *  /dashboard/orders is a pass. Its three columns hold four statuses,
 *  'completed' and 'cancelled' map to no column at all, and the whole
 *  trace of them on that screen is one sentence saying how many it is
 *  not showing. So the moment a cook pressed "Picked up" the order left
 *  the restaurant's world -- every line of it, the money on it, the
 *  caller who is owed it -- and no screen in this product listed it
 *  again. This is where it can be found.
 *
 *  ── WHY A SEPARATE ROUTE AND NOT A TOGGLE ON THE BOARD ──────────────
 *
 *  The obvious build is a .seg at the top of /dashboard/orders reading
 *  "Board / History". It is rejected, and not on taste:
 *
 *    * THE PASS MUST NOT STOP SHOWING LIVE TICKETS. The board is read on
 *      a tablet propped up in a kitchen, in service, by somebody with
 *      their hands full -- it is the screen the coarse-pointer block at
 *      the end of app.css was measured for. A control that swaps the
 *      whole screen for a list of last Tuesday's orders is one wet thumb
 *      away from a pass with no tickets on it, in the middle of service,
 *      and the way back is not obvious to somebody who did not mean to
 *      leave.
 *    * THE READERS ARE DIFFERENT PEOPLE AT DIFFERENT MOMENTS. A cook
 *      asks "what do I have to make, and by when", continuously, for
 *      four hours. An owner asks "what did we take last week", once,
 *      sitting down, afterwards. Those are not two modes of one screen;
 *      they are two screens, and one of them must never be able to
 *      render as the other.
 *    * ONE BOOKMARK EACH. A query flag on the kitchen's own address can
 *      be saved, shared or restored by a browser into the wrong mode.
 *      /dashboard/orders is the board and can only be the board.
 *
 *  What IS taken from the house is the navigation INSIDE this screen:
 *  the window is a `.seg.filter-seg` of links, the same control
 *  /dashboard/calls and /dashboard/messages filter with, and the pager
 *  beneath is theirs too. Nothing here is a new kind of nav, no class in
 *  this file is new, and the list is the system's own `.table`.
 *
 *  Read on the signed-in user's session (lib/data.ts), so RLS decides
 *  what is on it. There is no write on this screen at all: a finished
 *  order is a record, and the board is the only place this product
 *  changes one.
 */
export default async function OrderHistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const chosen = isWindow(params.window) ? params.window : DEFAULT_ORDER_HISTORY_WINDOW;
  const page = Math.max(1, Number(params.page) || 1);

  const location = await getCurrentLocation();
  if (!location) return null; // The layout already explains this case.

  const {
    orders,
    total,
    page: currentPage,
    pageCount,
  } = await getOrderHistoryPage(location.id, {
    timezone: location.timezone,
    window: chosen,
    page,
  });

  const tz = location.timezone;
  const label = ORDER_HISTORY_WINDOWS.find((w) => w.key === chosen)?.label ?? "";

  /* The default window is the bare address, so the URL in somebody's bar
     is the view they are looking at and nothing else. Changing the
     window always returns to page 1: a narrower window has fewer pages,
     and page 4 of a week that only has two is a request nobody made. */
  const href = (next: Partial<{ window: OrderHistoryWindow; page: number }>) => {
    const q = new URLSearchParams();
    const w = next.window ?? chosen;
    const p = next.page ?? 1;
    if (w !== DEFAULT_ORDER_HISTORY_WINDOW) q.set("window", w);
    if (p > 1) q.set("page", String(p));
    const s = q.toString();
    return s ? `/dashboard/orders/history?${s}` : "/dashboard/orders/history";
  };

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/dashboard/orders" className="row-link">
            ← Orders board
          </Link>
          <h1>Finished orders</h1>
          <div className="text-muted sub">
            {total} {total === 1 ? "order" : "orders"} · {label.toLowerCase()} · {tz}
          </div>
        </div>
      </div>

      {/* Links, not a client control, exactly as on the call log: a
          filtered view stays shareable and survives a refresh. */}
      <nav className="seg filter-seg" aria-label="Choose how far back to read">
        {ORDER_HISTORY_WINDOWS.map((w) => (
          <Link
            key={w.key}
            href={href({ window: w.key })}
            className={w.key === chosen ? "seg-opt is-on" : "seg-opt"}
            aria-current={w.key === chosen ? "page" : undefined}
          >
            {w.label}
          </Link>
        ))}
      </nav>

      {orders.length === 0 ? (
        <p className="text-muted empty-note">
          {chosen === "all"
            ? "No finished orders yet. One appears here the moment the kitchen presses “Picked up” on a ticket — or if an order is cancelled."
            : "Nothing finished in this window. Widen it above to look further back; anything the kitchen has not finished with is still on the board."}
        </p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Placed</th>
                <th>Order</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>
                    {/* THE WHOLE INSTANT, never timeIn's bare clock. Every
                        row on this screen is old by construction -- it is
                        the one log in this product where that is
                        guaranteed -- and "9:12 PM" does not say which
                        one. */}
                    <div className="num">{dateTimeIn(tz, o.placedAt)}</div>
                    <div className="caller-city">{relative(o.placedAt)}</div>
                  </td>
                  <td>
                    <div className="num">#{o.orderNumber}</div>
                    <div className="caller-city">
                      {o.type === "delivery" ? "Delivery" : "Pickup"}
                    </div>
                  </td>
                  {/* Printed as the read handed it over. The scrubbing is
                      done there, once, for every screen (see
                      toBoardOrder). */}
                  <td>{o.customerName ?? "No name taken"}</td>
                  <td>
                    <span className={ORDER_TAG[o.status]}>{o.status}</span>
                  </td>
                  <td className="num">{money(o.totalCents)}</td>
                  <td>
                    <Link href={`/dashboard/orders/${o.id}`} className="row-link">
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
            <Link href={href({ page: currentPage - 1 })} className="btn btn-secondary">
              Newer
            </Link>
          ) : null}
          <span className="text-muted">
            {(currentPage - 1) * ORDERS_PER_HISTORY_PAGE + 1}–
            {Math.min(currentPage * ORDERS_PER_HISTORY_PAGE, total)} of {total}
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
