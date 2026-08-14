import Link from "next/link";
import { notFound } from "next/navigation";
import { Corners } from "@/components/Corners";
import { GoLive } from "@/components/admin/GoLive";
import { getAdminLocation } from "@/lib/admin/data";
import { getGoLiveState } from "@/lib/provisioning/go-live";
import { UNTIL_LABEL } from "@/lib/menu";
import { OUTCOME_TAG, money, relative, timeIn } from "@/lib/format";

/* How long a server action on this route may run.
 *
 * Route segment config, so it covers the actions in ./actions.ts as well
 * as this page -- and "Make it live" is why it is here. One press can
 * cost three full derivations at three Vapi reads each, an assistant
 * provisioning, and a POST /phone-number, every one of them against a
 * third party whose own ceiling is twenty seconds. That is minutes in
 * the worst case, against a platform default of ten to fifteen seconds.
 *
 * The failure this prevents is specific and it is the only one in the
 * feature that loses money silently: a request killed between
 * `createPhoneNumber` resolving and the column write landing leaves a
 * real, billed, dialable number that exists on no screen and in no
 * column. Every other timeout is a run that has to be pressed again.
 *
 * 300 is the ceiling this asks for; a plan whose limit is lower clamps
 * it, which is still further than the default gets. */
export const maxDuration = 300;

/* The RFC shape. The old test here was /^[0-9a-f-]{36}$/i, which happily
   accepts thirty-six dashes and hands PostgREST a malformed uuid cast. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminLocationPage({
  params,
}: {
  params: Promise<{ locationId: string }>;
}) {
  const { locationId } = await params;
  if (!UUID.test(locationId)) notFound();

  // Two independent reads. getAdminLocation is the account's history;
  // getGoLiveState is what callers get right now, and it deliberately
  // asks Vapi rather than trusting the columns -- a cached answer is
  // exactly what let a live restaurant's assistant id drift to null
  // without anyone noticing.
  const [data, goLive] = await Promise.all([
    getAdminLocation(locationId),
    getGoLiveState(locationId),
  ]);
  if (!data || !goLive) notFound();

  const { location, calls, orders, soldOut } = data;
  const tz = location.timezone;

  const answering = location.is_live && !location.kill_switch_on;

  // Borrowed from the readiness panel rather than counted again here.
  // "Whole menu on offer" is a lie on a restaurant that has no menu, and
  // a brand-new restaurant is exactly who is looking at this page.
  const hasMenu = goLive.checks.find((c) => c.key === "menu")?.status === "ok";

  const noCallsYet = !location.is_live
    ? "Nothing yet. This restaurant is not answering — the panel above says what is in the way."
    : location.kill_switch_on
      ? "Nothing yet. The kill switch is on, so calls are going straight to a person instead."
      : "Nothing yet. The line is open, so the next caller lands here.";

  /* `num` marks the rows whose value is a figure rather than prose --
     phone numbers and the assistant's uuid. The house sets those in
     tabular figures everywhere else (app/dashboard/calls/[id] renders a
     caller's number as <dd className="num">), and a phone number in
     proportional type is the specific thing that makes a screen look
     unlike the mockup. */
  const facts: { label: string; value: string; num?: boolean }[] = [
    { label: "Organization", value: location.organizations?.name ?? "—" },
    { label: "Plan", value: location.organizations?.plan ?? "—" },
    { label: "Timezone", value: tz },
    { label: "Our number", value: location.twilio_number ?? "not provisioned", num: true },
    { label: "Their number", value: location.business_phone ?? "—", num: true },
    { label: "Falls back to", value: location.fallback_human_number ?? "not set", num: true },
    { label: "Assistant", value: location.vapi_assistant_id ?? "none on file", num: true },
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
          {/* The same .row-link every other detail page in this product
              puts above its h1 (/admin/new, /dashboard/calls/<id>). It
              was a bare 13px anchor jammed against a 38px heading and
              read as a caption rather than as the way out; app.css now
              gives .page-head .row-link its own line, an underline and a
              real target, so all four back links changed together. */}
          <Link href="/admin" className="row-link">
            ← Every restaurant
          </Link>
          <h1>{location.name}</h1>
          <div className="text-muted sub">
            {location.address ?? "no address on file"}
          </div>
        </div>
      </div>

      {/* The readiness panel leads the wide column, and the call log sits
          under it. Before this, the wide column held nothing but the call
          log, so a restaurant that had never rung -- which is every
          restaurant on the day it is created, and exactly when an
          operator is on this page -- rendered as one line of grey text
          beside a tall stack of facts, and looked broken rather than new.
          Now the emptiest restaurant has the fullest panel: the checklist
          is longest, and the controls for it are all here. */}
      <div className="split">
        <div className="panel">
          <GoLive state={goLive} />

          <section className="panel">
            <h4>Recent calls</h4>
            {calls.length === 0 ? (
              <p className="text-muted empty-note">{noCallsYet}</p>
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
        </div>

        <div className="panel">
          {/* Kept whole. The panel above is the authority on whether this
              restaurant answers; this is the record of what is on file,
              and an operator reading a support ticket still needs every
              line of it. */}
          <div className="card blueprint admin-facts">
            <Corners />
            <div className="card-kicker">Account</div>
            <dl>
              {facts.map((f) => (
                <div key={f.label} className="fact-row">
                  <dt className="text-muted">{f.label}</dt>
                  <dd className={f.num ? "num" : undefined}>{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <section className="panel">
            <h4>Sold out</h4>
            {soldOut.length === 0 ? (
              <p className="text-muted empty-note">
                {hasMenu
                  ? "Whole menu on offer."
                  : "No menu yet, so there is nothing to sell out."}
              </p>
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
              <p className="text-muted empty-note">
                {answering
                  ? "No orders yet. The assistant takes them straight from the call."
                  : "No orders yet — nobody can place one until this restaurant is answering."}
              </p>
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
