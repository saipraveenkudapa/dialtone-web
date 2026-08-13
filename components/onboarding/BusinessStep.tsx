"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Corners } from "@/components/Corners";
import { saveBusinessStep, type BusinessState } from "@/app/onboarding/actions";
import type { LocationRow } from "@/lib/supabase/types";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : "Continue"}
    </button>
  );
}

export function BusinessStep({
  location,
  suggestedName,
  timezones,
  onSaved,
}: {
  location: LocationRow | null;
  suggestedName: string | null;
  timezones: string[];
  onSaved: (location: LocationRow) => void;
}) {
  const [state, action] = useActionState<BusinessState, FormData>(async (prev, formData) => {
    const result = await saveBusinessStep(prev, formData);
    if (result.location) onSaved(result.location);
    return result;
  }, {});

  return (
    <div className="card blueprint onboard-card">
      <Corners />
      <h2>Tell us about the restaurant</h2>
      <p className="text-muted sub">
        This is what the AI assistant tells callers, and where it sends anything it can&rsquo;t
        handle itself.
      </p>
      <form action={action} className="onboard-form">
        <div className="field">
          <label htmlFor="ob-name">Restaurant name</label>
          <input
            id="ob-name"
            className="input"
            name="name"
            type="text"
            maxLength={120}
            defaultValue={location?.name ?? suggestedName ?? ""}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="ob-address">Address</label>
          <input
            id="ob-address"
            className="input"
            name="address"
            type="text"
            placeholder="1412 Telegraph Ave, Oakland, CA"
            defaultValue={location?.address ?? ""}
            required
          />
        </div>

        <div className="onboard-row">
          <div className="field">
            <label htmlFor="ob-timezone">Timezone</label>
            <select
              id="ob-timezone"
              className="input"
              name="timezone"
              defaultValue={location?.timezone ?? "America/Los_Angeles"}
              required
            >
              {timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="ob-phone">Display phone (optional)</label>
            <input
              id="ob-phone"
              className="input"
              name="businessPhone"
              type="tel"
              placeholder="(510) 555-0119"
              defaultValue={location?.business_phone ?? ""}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="ob-fallback">Fallback number</label>
          <input
            id="ob-fallback"
            className="input"
            name="fallbackNumber"
            type="tel"
            placeholder="(510) 555-0100"
            defaultValue={location?.fallback_human_number ?? ""}
            required
          />
          <p className="text-muted onboard-note">
            Where the assistant transfers a catering question or anything about an allergy. The
            AI assistant can&rsquo;t be created without this.
          </p>
        </div>

        {state.error ? <p className="onboard-error">{state.error}</p> : null}

        <div className="onboard-actions">
          <span />
          <Submit />
        </div>
      </form>
    </div>
  );
}
