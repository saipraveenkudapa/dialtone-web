import { Corners } from "@/components/Corners";
import { SectionLink } from "@/components/admin/ConsoleTabs";
import { dateTimeIn, relative } from "@/lib/format";
import type { EditableLocation } from "@/lib/admin/edit";

/* ── class B: facts, never disabled inputs ─────────────────────────── */

/** What the system manages.
 *
 *  Set as facts rather than as greyed-out fields, reusing the block the
 *  console already uses for the same rows. A disabled input is a promise
 *  that the field is editable somewhere, sometime; these are not fields
 *  at all. And a free text box for twilio_number is not a convenience --
 *  it is a typo that silently points a restaurant's calls at nothing,
 *  which is the whole reason the go-live panel exists.
 *
 *  The tool secret and the Stripe customer are reported as PRESENCE,
 *  never as value. A hash in a response body is still a secret in a
 *  response body; lib/admin/edit.ts already refuses to hand either one
 *  out, and this card would have nothing to print even if it wanted to.
 *
 *  Moved here whole out of app/admin/[locationId]/edit/page.tsx when the
 *  editor and the overview became one console. Not one character of what
 *  it reports changed -- only where the panel it lives in is reached
 *  from, and the link at the foot, which used to be a route out of the
 *  editor and is now a tab on this same page. */
export function SystemTab({
  location,
  org,
  timezone,
}: {
  location: EditableLocation;
  org: { stripe_customer_on_file: boolean };
  timezone: string;
}) {
  /* `num` marks the rows whose value is a figure rather than prose --
     phone numbers, SIDs and the assistant's uuid. The house sets those
     in tabular figures everywhere else. */
  const facts: { label: string; value: string; num?: boolean }[] = [
    { label: "Live", value: location.is_live ? "yes" : "no" },
    { label: "Kill switch", value: location.kill_switch_on ? "ON" : "off" },
    { label: "Our number", value: location.twilio_number ?? "not provisioned", num: true },
    { label: "Number SID", value: location.twilio_number_sid ?? "—", num: true },
    { label: "Assistant", value: location.vapi_assistant_id ?? "none on file", num: true },
    {
      label: "Forwarding",
      value: location.forwarding_verified_at
        ? `verified ${relative(location.forwarding_verified_at)}`
        : "never verified",
    },
    { label: "Onboarding step", value: location.onboarding_step },
    { label: "Tool secret", value: location.tool_secret_on_file ? "set" : "not set" },
    { label: "Stripe customer", value: org.stripe_customer_on_file ? "on file" : "none" },
    { label: "Created", value: stamp(timezone, location.created_at) },
    { label: "Updated", value: stamp(timezone, location.updated_at) },
  ];

  return (
    <section id="managed" className="card blueprint setup-card">
      <Corners />
      <h2>What the system manages</h2>
      <p className="text-muted sub">
        Set by the go-live panel and by the assistant itself. Nothing on this page can type over
        them.
      </p>

      <div className="card blueprint admin-facts">
        <Corners />
        <dl>
          {facts.map((fact) => (
            <div key={fact.label} className="fact-row">
              <dt className="text-muted">{fact.label}</dt>
              <dd className={fact.num ? "num" : undefined}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="text-muted setup-note">
        Our number, the assistant and the state of the line are provisioned, checked against Vapi
        and written by the go-live panel. A number typed by hand is a typo that silently points a
        restaurant&rsquo;s calls at nothing. The tool secret and the Stripe customer are shown as
        set or not set and never as a value.{" "}
        <SectionLink section="line" className="row-link">
          Go-live panel →
        </SectionLink>
      </p>
    </section>
  );
}

/** A UTC timestamp in the restaurant's own clock, with the same guard the
 *  editor uses for the same reason: a zone Intl does not know throws, and
 *  a broken timezone is one of the things an operator comes to this
 *  console to correct. Falling back to UTC and saying so beats a 500 on
 *  the only screen that can fix it. */
function stamp(timezone: string, iso: string): string {
  try {
    return dateTimeIn(timezone, iso);
  } catch {
    return `${dateTimeIn("UTC", iso)} UTC`;
  }
}
