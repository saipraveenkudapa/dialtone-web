import Link from "next/link";
import { notFound } from "next/navigation";
import { Corners } from "@/components/Corners";
import { getAdminLocation } from "@/lib/admin/data";
import { UNTIL_LABEL } from "@/lib/menu";
import { OUTCOME_TAG, money, relative, timeIn } from "@/lib/format";

export default async function AdminLocationPage({
  params,
}: {
  params: Promise<{ locationId: string }>;
}) {
  const { locationId } = await params;

  // A malformed id would otherwise reach Postgres as a bad uuid cast.
  if (!/^[0-9a-f-]{36}$/i.test(locationId)) notFound();

  const data = await getAdminLocation(locationId);
  if (!data) notFound();

  const { location, calls, orders, soldOut } = data;
  const tz = location.timezone;

  const facts = [
    { label: "Organization", value: location.organizations?.name ?? "—" },
    { label: "Plan", value: location.organizations?.plan ?? "—" },
    { label: "Timezone", value: tz },
    { label: "Our number", value: location.twilio_number ?? "not provisioned" },
    { label: "Their number", value: location.business_phone ?? "—" },
    { label: "Falls back to", value: location.fallback_human_number ?? "not set" },
    { label: "Carrier", value: location.carrier_name ?? "unknown" },
    {
      label: "Forwarding",
      value: location.forwarding_verified_at
        ? `verified ${relative(location.forwarding_verified_at)}`
        : "never verified",
    },
    {
      label: "Recording",
      value: location.recording_enabled
        ? `on, kept ${location.recording_retention_days} days`
        : "off",
    },
    { label: "Live", value: location.is_live ? "yes" : "no" },
    { label: "Kill switch", value: location.kill_switch_on ? "ON" : "off" },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/admin" className="row-link">
            ← Every restaurant
          </Link>
          <h1>{location.name}</h1>
          <div className="text-muted sub">
            {location.address ?? "no address on file"}
          </div>
        </div>
      </div>

      <div className="split">
        <section className="panel">
          <h4>Recent calls</h4>
          {calls.length === 0 ? (
            <p className="text-muted empty-note">No calls yet.</p>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Caller</th>
                    <th>Outcome</th>
                    <th>Length</th>
                    <th>Cost</th>
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
                      <td className="num">
                        {money(c.telephony_cost_cents + c.llm_cost_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="panel">
          <div className="card blueprint admin-facts">
            <Corners />
            <div className="card-kicker">Account</div>
            <dl>
              {facts.map((f) => (
                <div key={f.label} className="fact-row">
                  <dt className="text-muted">{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <section className="panel">
            <h4>Sold out</h4>
            {soldOut.length === 0 ? (
              <p className="text-muted empty-note">Whole menu on offer.</p>
            ) : (
              <div className="soldout-list">
                {soldOut.map((s) => (
                  <div key={s.id} className="soldout-row">
                    <span>{s.name}</span>
                    <span className="until">{UNTIL_LABEL[s.sold_out_until]}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <h4>Recent orders</h4>
            {orders.length === 0 ? (
              <p className="text-muted empty-note">No orders yet.</p>
            ) : (
              <div className="soldout-list">
                {orders.map((o) => (
                  <div key={o.id} className="soldout-row">
                    <span>
                      #{o.order_number} · {o.customer_name ?? "—"}
                    </span>
                    <span className="until">
                      {o.status} · {money(o.total_cents)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
