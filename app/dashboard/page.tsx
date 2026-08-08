import Link from "next/link";
import { Corners } from "@/components/Corners";
import { LiveCallStrip } from "@/components/LiveCallStrip";
import { SoldOutPanel } from "@/components/SoldOutPanel";
import {
  getCurrentLocation,
  getLiveCall,
  getRecentCalls,
  getTodayStats,
} from "@/lib/data";
import { OUTCOME_TAG, dateIn, money, timeIn } from "@/lib/format";

export default async function TodayPage() {
  const location = await getCurrentLocation();
  if (!location) return null; // The layout already explains this case.

  const [stats, calls, liveCall] = await Promise.all([
    getTodayStats(location.id, location.timezone),
    getRecentCalls(location.id, 5),
    getLiveCall(location.id),
  ]);

  const tz = location.timezone;

  const cards = [
    {
      label: "Calls answered",
      value: String(stats.answered),
      note: "today, in restaurant time",
    },
    {
      label: "Orders taken",
      value: String(stats.orders),
      note: `${money(stats.ordersRevenueCents)} through the agent`,
    },
    {
      label: "Tables booked",
      value: String(stats.bookings),
      note: `${stats.covers} covers`,
    },
    {
      label: "Sent to a human",
      value: String(stats.transferred),
      note: stats.transferReasons.length
        ? stats.transferReasons.slice(0, 2).join(", ")
        : "nothing needed a person",
    },
    {
      label: "Call spend",
      value: money(stats.spendCents),
      note: stats.answered
        ? `${money(Math.round(stats.spendCents / stats.answered))} average`
        : "no calls yet",
    },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Today</h1>
          <div className="text-muted sub">
            {dateIn(tz)} · {tz}
          </div>
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary blueprint">
            <Corners />
            Place a test call
          </button>
          <Link href="/dashboard/menu/live" className="btn btn-secondary">
            Open manager screen
          </Link>
        </div>
      </div>

      <LiveCallStrip locationId={location.id} initialCall={liveCall} />

      <div className="stat-grid">
        {cards.map((s) => (
          <div key={s.label} className="card blueprint stat-card">
            <Corners />
            <div className="card-kicker">{s.label}</div>
            <div className="stat-value">{s.value}</div>
            <div className="text-muted stat-note">{s.note}</div>
          </div>
        ))}
      </div>

      <div className="split">
        <section className="panel">
          <h4>Latest calls</h4>
          {calls.length === 0 ? (
            <p className="text-muted empty-note">
              No calls yet. Place a test call to hear the agent answer.
            </p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Caller</th>
                  <th>Outcome</th>
                  <th>Length</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td className="num">{timeIn(tz, c.started_at)}</td>
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
                      {c.duration_seconds
                        ? `${Math.floor(c.duration_seconds / 60)}:${String(
                            c.duration_seconds % 60,
                          ).padStart(2, "0")}`
                        : "—"}
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
          )}
        </section>

        <SoldOutPanel />
      </div>
    </>
  );
}
