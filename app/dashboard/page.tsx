import Link from "next/link";
import { Corners } from "@/components/Corners";
import { LiveCallStrip } from "@/components/LiveCallStrip";
import { SoldOutPanel } from "@/components/SoldOutPanel";
import { CALLS, LOCATION, OUTCOME_TAG, STATS } from "@/lib/demo";

function todayLong() {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: LOCATION.timezone,
  }).format(new Date());
}

export default function TodayPage() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Today</h1>
          <div className="text-muted sub">
            {todayLong()} · {LOCATION.timezone}
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

      <LiveCallStrip />

      <div className="stat-grid">
        {STATS.map((s) => (
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
              {CALLS.slice(0, 5).map((c) => (
                <tr key={c.id}>
                  <td className="num">{c.time}</td>
                  <td>
                    <div>{c.from}</div>
                    <div className="caller-city">{c.city}</div>
                  </td>
                  <td>
                    <span className={OUTCOME_TAG[c.outcome]}>{c.outcome}</span>
                  </td>
                  <td className="num">{c.length}</td>
                  <td>
                    <Link href={`/dashboard/calls/${c.id}`} className="row-link">
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <SoldOutPanel />
      </div>
    </>
  );
}
