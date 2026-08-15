import Link from "next/link";
import { notFound } from "next/navigation";
import { Corners } from "@/components/Corners";
import { CallPlayer } from "@/components/CallPlayer";
import { CallCostCard, CallTimelineCard } from "@/components/CallFacts";
import { CallNotes } from "@/components/CallNotes";
import { getCall, getCurrentLocation, getRecordingUrl } from "@/lib/data";
import { OUTCOME_TAG, money, relative, timeIn } from "@/lib/format";

export default async function CallDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [location, data] = await Promise.all([getCurrentLocation(), getCall(id)]);
  if (!location || !data) notFound();

  const { call, order, booking, messages } = data;
  const tz = location.timezone;
  const recordingUrl = await getRecordingUrl(call.recording_path);

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/dashboard/calls" className="row-link">
            ← All calls
          </Link>
          <h1>{call.from_number ?? "Unknown caller"}</h1>
          <div className="text-muted sub">
            {[call.from_city, call.from_state].filter(Boolean).join(", ")}
            {call.from_city ? " · " : ""}
            {timeIn(tz, call.started_at)} · {relative(call.started_at)}
          </div>
        </div>
        <div className="actions">
          {call.outcome ? (
            <span className={OUTCOME_TAG[call.outcome]}>{call.outcome}</span>
          ) : (
            <span className="tag tag-neutral">{call.status}</span>
          )}
        </div>
      </div>

      <div className="split">
        <div className="panel">
          <CallPlayer
            src={recordingUrl}
            lines={call.transcript?.lines ?? []}
            durationSeconds={call.duration_seconds}
          />
          <CallNotes callId={call.id} notes={call.notes ?? ""} />
        </div>

        <div className="panel">
          {/* Shared with the operator's copy of this screen; the
              handed-off row is this screen's own and rides inside the
              same <dl>. See components/CallFacts.tsx. */}
          <CallTimelineCard call={call} timezone={tz}>
            {call.transferred_to_human ? (
              <div className="fact-row">
                <dt className="text-muted">Handed off</dt>
                <dd>{call.transfer_reason ?? "to a person"}</dd>
              </div>
            ) : null}
          </CallTimelineCard>

          {/* Above the order and the booking, deliberately: an order and a
              booking are already done, while a message is the one thing on
              this page that is still somebody's job. Every call that used
              to be handed to a human for anything other than catering or
              an allergy now lands here instead, so this card is the whole
              record of it -- if it is not read, nobody rings the caller
              back. Rendered as a list because one call can leave more than
              one (see getCall). */}
          {messages.map((message) => (
            <div key={message.id} className="card blueprint admin-facts">
              <Corners />
              <div className="card-kicker">Message · {timeIn(tz, message.taken_at)}</div>
              {/* Already redacted and length-bounded on the way in
                  (lib/agent/messages.ts), so what a caller said is safe to
                  render as-is. */}
              <p className="card-body">{message.body}</p>
              <dl>
                <div className="fact-row">
                  <dt className="text-muted">From</dt>
                  <dd>{message.caller_name ?? "—"}</dd>
                </div>
                <div className="fact-row">
                  <dt className="text-muted">Call back</dt>
                  <dd className="num">{message.callback_phone ?? "—"}</dd>
                </div>
                <div className="fact-row">
                  <dt className="text-muted">Status</dt>
                  <dd>
                    {message.handled && message.handled_at ? (
                      <span className="tag tag-neutral">
                        handled {timeIn(tz, message.handled_at)}
                      </span>
                    ) : (
                      <span className="tag tag-accent">needs a callback</span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          ))}

          {order ? (
            <section className="panel">
              <h4>Order #{order.order_number}</h4>
              <div className="soldout-list">
                {order.order_items.map((item) => (
                  <div key={item.id} className="soldout-row">
                    <span>
                      {item.quantity} × {item.name_snapshot}
                    </span>
                    <span className="until num">
                      {money(item.price_cents_snapshot * item.quantity)}
                    </span>
                  </div>
                ))}
                <div className="soldout-row">
                  <span>Total · paid by SMS link</span>
                  <span className="until num">{money(order.total_cents)}</span>
                </div>
              </div>
              <Link href="/dashboard/orders" className="btn btn-ghost">
                Open in orders
              </Link>
            </section>
          ) : null}

          {booking ? (
            <section className="panel">
              <h4>Booking</h4>
              <div className="soldout-list">
                <div className="soldout-row">
                  <span>{booking.customer_name ?? "—"}</span>
                  <span className="until">
                    party of {booking.party_size} · {timeIn(tz, booking.requested_at)}
                  </span>
                </div>
              </div>
            </section>
          ) : null}

          <CallCostCard call={call} />
        </div>
      </div>
    </>
  );
}
