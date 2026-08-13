import Link from "next/link";
import { Corners } from "@/components/Corners";
import { getPortfolio } from "@/lib/admin/data";
import { money, relative } from "@/lib/format";

const HEALTH_LABEL: Record<string, { text: string; tag: string }> = {
  live: { text: "Answering", tag: "tag tag-accent" },
  "kill-switch": { text: "Kill switch", tag: "tag tag-out" },
  "not-live": { text: "Not live", tag: "tag tag-neutral" },
  "no-forwarding": { text: "Forwarding unproven", tag: "tag tag-outline" },
};

export default async function OperatorPage() {
  const rows = await getPortfolio();

  const totals = rows.reduce(
    (acc, r) => ({
      answered: acc.answered + r.answered,
      missed: acc.missed + r.missed,
      orders: acc.orders + r.orders,
      revenueCents: acc.revenueCents + r.revenueCents,
      spendCents: acc.spendCents + r.spendCents,
      live: acc.live + (r.health === "live" ? 1 : 0),
    }),
    { answered: 0, missed: 0, orders: 0, revenueCents: 0, spendCents: 0, live: 0 },
  );

  const cards = [
    { label: "Restaurants", value: String(rows.length), note: `${totals.live} answering right now` },
    { label: "Calls answered", value: String(totals.answered), note: "today, each in its own timezone" },
    {
      label: "Missed",
      value: String(totals.missed),
      note: totals.missed ? "reached us and nobody picked up" : "nothing slipped through",
    },
    { label: "Orders taken", value: String(totals.orders), note: `${money(totals.revenueCents)} booked` },
    { label: "Call spend", value: money(totals.spendCents), note: "what today cost us" },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Every restaurant</h1>
          <div className="text-muted sub">
            Operator console. Numbers are today in each restaurant&rsquo;s own
            timezone.
          </div>
        </div>
        <div className="actions">
          <Link href="/admin/new" className="btn btn-primary">
            Create a new restaurant
          </Link>
        </div>
      </div>

      <div className="stat-grid">
        {cards.map((c) => (
          <div key={c.label} className="card blueprint stat-card">
            <Corners />
            <div className="card-kicker">{c.label}</div>
            <div className="stat-value">{c.value}</div>
            <div className="text-muted stat-note">{c.note}</div>
          </div>
        ))}
      </div>

      <section className="panel">
        <h4>Accounts</h4>
        {rows.length === 0 ? (
          <p className="text-muted empty-note">
            No restaurants yet. Nobody signs themselves up — use{" "}
            <Link href="/admin/new">Create a new restaurant</Link> to make the first one.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Restaurant</th>
                  <th>Status</th>
                  <th>Answered</th>
                  <th>Missed</th>
                  <th>Orders</th>
                  <th>Revenue</th>
                  <th>Spend</th>
                  <th>Last call</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const health = HEALTH_LABEL[r.health];
                  return (
                    <tr key={r.location.id}>
                      <td>
                        <div>{r.location.name}</div>
                        <div className="caller-city">
                          {r.location.org_name} · {r.location.timezone}
                        </div>
                      </td>
                      <td>
                        <span className={health.tag}>{health.text}</span>
                      </td>
                      <td className="num">{r.answered}</td>
                      <td className={r.missed ? "num num-warn" : "num"}>{r.missed}</td>
                      <td className="num">{r.orders}</td>
                      <td className="num">{money(r.revenueCents)}</td>
                      <td className="num">{money(r.spendCents)}</td>
                      <td className="num">
                        {r.lastCallAt ? relative(r.lastCallAt) : "never"}
                      </td>
                      <td>
                        <Link href={`/admin/${r.location.id}`} className="row-link">
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
