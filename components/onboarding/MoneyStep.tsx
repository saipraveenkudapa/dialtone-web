"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Corners } from "@/components/Corners";
import { saveMoneyStep, type MoneyState } from "@/app/onboarding/actions";
import { formatBasisPointsAsPercent, parsePercentToBasisPoints } from "@/lib/money";
import type { LocationRow } from "@/lib/supabase/types";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary" disabled={pending}>
      {pending ? "Saving…" : "Continue"}
    </button>
  );
}

export function MoneyStep({
  location,
  onSaved,
}: {
  location: LocationRow | null;
  onSaved: (location: LocationRow) => void;
}) {
  const [state, action] = useActionState<MoneyState, FormData>(async (prev, formData) => {
    const result = await saveMoneyStep(prev, formData);
    if (result.location) onSaved(result.location);
    return result;
  }, {});

  const [taxInput, setTaxInput] = useState(
    location ? (location.tax_rate_bps / 100).toString() : "",
  );
  const [orderTypes, setOrderTypes] = useState(location?.order_types ?? "both");

  const previewBps = parsePercentToBasisPoints(taxInput);

  return (
    <div className="card blueprint onboard-card">
      <Corners />
      <h2>Money &amp; service</h2>
      <p className="text-muted sub">
        Sales tax is typed as a percentage and stored as whole basis points -- the database can
        only hold a whole number of them, so a rate like 6.625% is rounded to the nearest one.
      </p>
      <form action={action} className="onboard-form">
        <div className="field">
          <label htmlFor="ob-tax">Sales tax rate (%)</label>
          <input
            id="ob-tax"
            className="input"
            name="taxPercent"
            type="text"
            inputMode="decimal"
            placeholder="8.75"
            value={taxInput}
            onChange={(e) => setTaxInput(e.target.value)}
            required
          />
          <p className="text-muted tax-preview">
            {previewBps === null
              ? "Enter a plain percentage, e.g. 8.75."
              : `Will store ${previewBps} basis points (${formatBasisPointsAsPercent(previewBps)}).`}
          </p>
        </div>

        <div className="field">
          <label>Order types</label>
          <div className="seg">
            {(["pickup", "delivery", "both"] as const).map((type) => (
              <label key={type} className="seg-opt">
                <input
                  type="radio"
                  name="orderTypes"
                  value={type}
                  checked={orderTypes === type}
                  onChange={() => setOrderTypes(type)}
                />
                {type === "both" ? "Pickup & delivery" : type[0].toUpperCase() + type.slice(1)}
              </label>
            ))}
          </div>
        </div>

        <div className="money-grid">
          <div className="field">
            <label htmlFor="ob-pickup-promise">Pickup ready in (minutes)</label>
            <input
              id="ob-pickup-promise"
              className="input"
              name="pickupPromiseMinutes"
              type="number"
              min={5}
              max={180}
              defaultValue={location?.pickup_promise_minutes ?? 25}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="ob-delivery-promise">Delivery ready in (minutes)</label>
            <input
              id="ob-delivery-promise"
              className="input"
              name="deliveryPromiseMinutes"
              type="number"
              min={5}
              max={180}
              defaultValue={location?.delivery_promise_minutes ?? 45}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="ob-seats">Seats</label>
            <input
              id="ob-seats"
              className="input"
              name="seats"
              type="number"
              min={1}
              defaultValue={location?.seats ?? 40}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="ob-max-party">Max party size</label>
            <input
              id="ob-max-party"
              className="input"
              name="maxPartySize"
              type="number"
              min={1}
              max={40}
              defaultValue={location?.max_party_size ?? 8}
              required
            />
          </div>
          <div className="field span-2">
            <label htmlFor="ob-slot">Reservation length (minutes)</label>
            <input
              id="ob-slot"
              className="input"
              name="reservationSlotMinutes"
              type="number"
              min={30}
              max={240}
              step={15}
              defaultValue={location?.reservation_slot_minutes ?? 90}
              required
            />
            <p className="text-muted onboard-note">How long one table is held for a reservation.</p>
          </div>
        </div>

        {state.error ? <p className="onboard-error">{state.error}</p> : null}
        {state.storedTaxDisplay ? (
          <p className="onboard-note text-muted">Sales tax saved as {state.storedTaxDisplay}.</p>
        ) : null}

        <div className="onboard-actions">
          <span />
          <Submit />
        </div>
      </form>
    </div>
  );
}
