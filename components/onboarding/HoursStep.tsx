"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Corners } from "@/components/Corners";
import { saveHoursStep, type HoursState } from "@/app/onboarding/actions";
import { WEEKDAYS } from "@/lib/onboarding/constants";
import type { HoursRow } from "@/lib/agent/hours";
import type { LocationRow } from "@/lib/supabase/types";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : "Continue"}
    </button>
  );
}

const DEFAULT_OPEN = "09:00";
const DEFAULT_CLOSE = "21:00";

export function HoursStep({
  initialHours,
  onSaved,
}: {
  initialHours: HoursRow[];
  onSaved: (location: LocationRow, hours: HoursRow[]) => void;
}) {
  const [state, action] = useActionState<HoursState, FormData>(async (prev, formData) => {
    const result = await saveHoursStep(prev, formData);
    if (result.location && result.hours) onSaved(result.location, result.hours);
    return result;
  }, {});

  const byDay = new Map(initialHours.map((h) => [h.day_of_week, h]));

  return (
    <div className="card blueprint onboard-card">
      <Corners />
      <h2>Hours</h2>
      <p className="text-muted sub">
        The assistant checks these before it books a table or promises when an order will be
        ready.
      </p>
      <form action={action} className="onboard-form">
        <div className="hours-grid">
          {WEEKDAYS.map((label, day) => {
            const existing = byDay.get(day);
            return (
              <HourRow
                key={day}
                day={day}
                label={label}
                defaultClosed={existing?.is_closed ?? false}
                defaultOpen={existing?.open_time?.slice(0, 5) ?? DEFAULT_OPEN}
                defaultClose={existing?.close_time?.slice(0, 5) ?? DEFAULT_CLOSE}
              />
            );
          })}
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

/** Its own component only so `closed` can live in local state -- toggling
 *  it needs to grey out (and stop requiring) that day's time inputs
 *  immediately, which has no business living in the step's shared
 *  server-action state. */
function HourRow({
  day,
  label,
  defaultClosed,
  defaultOpen,
  defaultClose,
}: {
  day: number;
  label: string;
  defaultClosed: boolean;
  defaultOpen: string;
  defaultClose: string;
}) {
  const [closed, setClosed] = useState(defaultClosed);

  return (
    <div className="hours-row">
      <span className="hours-day">{label}</span>
      <div className="hours-times">
        <label className="hours-closed">
          <input
            type="checkbox"
            name={`day-${day}-closed`}
            checked={closed}
            onChange={(e) => setClosed(e.target.checked)}
          />
          Closed
        </label>
        <input
          className="input"
          type="time"
          name={`day-${day}-open`}
          defaultValue={defaultOpen}
          disabled={closed}
          required={!closed}
        />
        <span className="text-muted">to</span>
        <input
          className="input"
          type="time"
          name={`day-${day}-close`}
          defaultValue={defaultClose}
          disabled={closed}
          required={!closed}
        />
      </div>
    </div>
  );
}
