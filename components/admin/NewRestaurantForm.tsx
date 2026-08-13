"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Corners } from "@/components/Corners";
import { createRestaurantAction } from "@/app/admin/new/actions";
import { WEEKDAYS } from "@/lib/provisioning/constants";
import { formatBasisPointsAsPercent, parseDollarsToCents, parsePercentToBasisPoints } from "@/lib/money";
import { money } from "@/lib/format";
import type {
  DraftMenuCategory,
  RestaurantDraft,
} from "@/lib/provisioning/draft";
import type { CreatedRestaurant } from "@/lib/provisioning/create-restaurant";

/** Everything the operator types, in one form, submitted once.
 *
 *  Deliberately not a wizard. The old owner-facing /onboarding was a
 *  four-step resumable flow because the person filling it in was
 *  learning the product as they went and might close the tab. This is a
 *  different job: the operator has the restaurant's details in front of
 *  them -- on a call, or in an email -- and fills them in one sitting.
 *  Nothing is written until Start, so there is no half-made restaurant
 *  to resume into. */

type LocalItem = { key: number; name: string; description: string; priceDollars: string };
type LocalCategory = { key: number; name: string; items: LocalItem[] };

const DEFAULT_OPEN = "09:00";
const DEFAULT_CLOSE = "21:00";

type HoursState = { closed: boolean; open: string; close: string };

const INITIAL_HOURS: HoursState[] = WEEKDAYS.map(() => ({
  closed: false,
  open: DEFAULT_OPEN,
  close: DEFAULT_CLOSE,
}));

export function NewRestaurantForm({ timezones }: { timezones: string[] }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [businessPhone, setBusinessPhone] = useState("");
  const [fallbackNumber, setFallbackNumber] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");

  const [hours, setHours] = useState<HoursState[]>(INITIAL_HOURS);

  const [taxPercent, setTaxPercent] = useState("");
  const [orderTypes, setOrderTypes] = useState("both");
  const [pickupPromiseMinutes, setPickupPromiseMinutes] = useState("25");
  const [deliveryPromiseMinutes, setDeliveryPromiseMinutes] = useState("45");
  const [seats, setSeats] = useState("40");
  const [maxPartySize, setMaxPartySize] = useState("8");
  const [reservationSlotMinutes, setReservationSlotMinutes] = useState("90");

  const [categories, setCategories] = useState<LocalCategory[]>([]);
  const [nextKey, setNextKey] = useState(1);

  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedRestaurant | null>(null);
  const [pending, startTransition] = useTransition();

  function claimKey() {
    const key = nextKey;
    setNextKey(key + 1);
    return key;
  }

  function setDay(day: number, patch: Partial<HoursState>) {
    setHours((prev) => prev.map((h, i) => (i === day ? { ...h, ...patch } : h)));
  }

  function addCategory() {
    setCategories((prev) => [...prev, { key: claimKey(), name: "", items: [] }]);
  }

  function patchCategory(key: number, patch: Partial<LocalCategory>) {
    setCategories((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  }

  function removeCategory(key: number) {
    setCategories((prev) => prev.filter((c) => c.key !== key));
  }

  function addItem(categoryKey: number) {
    const key = claimKey();
    setCategories((prev) =>
      prev.map((c) =>
        c.key === categoryKey
          ? { ...c, items: [...c.items, { key, name: "", description: "", priceDollars: "" }] }
          : c,
      ),
    );
  }

  function patchItem(categoryKey: number, itemKey: number, patch: Partial<LocalItem>) {
    setCategories((prev) =>
      prev.map((c) =>
        c.key === categoryKey
          ? { ...c, items: c.items.map((it) => (it.key === itemKey ? { ...it, ...patch } : it)) }
          : c,
      ),
    );
  }

  function removeItem(categoryKey: number, itemKey: number) {
    setCategories((prev) =>
      prev.map((c) =>
        c.key === categoryKey ? { ...c, items: c.items.filter((it) => it.key !== itemKey) } : c,
      ),
    );
  }

  function handleStart() {
    setError(null);
    const menu: DraftMenuCategory[] = categories.map((c) => ({
      name: c.name,
      items: c.items.map((it) => ({
        name: it.name,
        description: it.description,
        priceDollars: it.priceDollars,
      })),
    }));

    const draft: RestaurantDraft = {
      name,
      address,
      timezone,
      businessPhone,
      fallbackNumber,
      ownerEmail,
      hours: hours.map((h, day) => ({
        dayOfWeek: day,
        closed: h.closed,
        open: h.open,
        close: h.close,
      })),
      taxPercent,
      orderTypes,
      pickupPromiseMinutes,
      deliveryPromiseMinutes,
      seats,
      maxPartySize,
      reservationSlotMinutes,
      menu,
    };

    startTransition(async () => {
      const result = await createRestaurantAction(draft);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.restaurant) setCreated(result.restaurant);
    });
  }

  // Once the restaurant exists, the form is gone. The credentials below
  // are the only copy of that password anywhere, and re-rendering the
  // form underneath them would invite a second Start.
  if (created) return <HandoverPanel restaurant={created} />;

  const previewBps = parsePercentToBasisPoints(taxPercent.trim());
  const itemCount = categories.reduce((sum, c) => sum + c.items.length, 0);

  return (
    <>
      <section className="card blueprint setup-card">
        <Corners />
        <h2>The business</h2>
        <p className="text-muted sub">
          What the assistant tells callers, and where it sends anything it can&rsquo;t handle
          itself.
        </p>

        <div className="setup-form">
          <div className="field">
            <label htmlFor="nr-name">Restaurant name</label>
            <input
              id="nr-name"
              className="input"
              type="text"
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-muted setup-note">
              Names the organization and the location, and is what the assistant says on the
              phone.
            </p>
          </div>

          <div className="field">
            <label htmlFor="nr-address">Address</label>
            <input
              id="nr-address"
              className="input"
              type="text"
              placeholder="1412 Telegraph Ave, Oakland, CA"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>

          <div className="setup-row">
            <div className="field">
              <label htmlFor="nr-timezone">Timezone</label>
              <select
                id="nr-timezone"
                className="input"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
              <p className="text-muted setup-note">
                Every time this restaurant sees is rendered in this zone; the database stores UTC.
              </p>
            </div>

            <div className="field">
              <label htmlFor="nr-phone">Display phone (optional)</label>
              <input
                id="nr-phone"
                className="input"
                type="tel"
                placeholder="(510) 555-0119"
                value={businessPhone}
                onChange={(e) => setBusinessPhone(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="nr-fallback">Fallback number</label>
            <input
              id="nr-fallback"
              className="input"
              type="tel"
              placeholder="(510) 555-0100"
              value={fallbackNumber}
              onChange={(e) => setFallbackNumber(e.target.value)}
            />
            <p className="text-muted setup-note">
              Where the assistant transfers a catering question or anything about an allergy. The
              AI assistant cannot be created without one.
            </p>
          </div>

          <div className="field">
            <label htmlFor="nr-owner-email">Owner&rsquo;s email</label>
            <input
              id="nr-owner-email"
              className="input"
              type="email"
              placeholder="owner@therestaurant.com"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
            />
            <p className="text-muted setup-note">
              This becomes their username. A temporary password is generated on Start and shown to
              you once, to hand over -- they are asked to replace it the first time they sign in.
            </p>
          </div>
        </div>
      </section>

      <section className="card blueprint setup-card">
        <Corners />
        <h2>Hours</h2>
        <p className="text-muted sub">
          The assistant checks these before it books a table or promises when an order will be
          ready.
        </p>
        <div className="hours-grid">
          {WEEKDAYS.map((label, day) => (
            <div key={label} className="hours-row">
              <span className="hours-day">{label}</span>
              <div className="hours-times">
                <label className="hours-closed">
                  <input
                    type="checkbox"
                    checked={hours[day].closed}
                    onChange={(e) => setDay(day, { closed: e.target.checked })}
                  />
                  Closed
                </label>
                <input
                  className="input"
                  type="time"
                  aria-label={`${label} opens`}
                  value={hours[day].open}
                  disabled={hours[day].closed}
                  onChange={(e) => setDay(day, { open: e.target.value })}
                />
                <span className="text-muted">to</span>
                <input
                  className="input"
                  type="time"
                  aria-label={`${label} closes`}
                  value={hours[day].close}
                  disabled={hours[day].closed}
                  onChange={(e) => setDay(day, { close: e.target.value })}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card blueprint setup-card">
        <Corners />
        <h2>Money &amp; service</h2>
        <p className="text-muted sub">
          Sales tax is typed as a percentage and stored as whole basis points -- the database can
          only hold a whole number of them, so a rate like 6.625% is rounded to the nearest one.
        </p>

        <div className="setup-form">
          <div className="field">
            <label htmlFor="nr-tax">Sales tax rate (%)</label>
            <input
              id="nr-tax"
              className="input"
              type="text"
              inputMode="decimal"
              placeholder="8.75"
              value={taxPercent}
              onChange={(e) => setTaxPercent(e.target.value)}
            />
            <p className="text-muted tax-preview">
              {previewBps === null
                ? "Enter a plain percentage, e.g. 8.75."
                : `Will store ${previewBps} basis points (${formatBasisPointsAsPercent(previewBps)}).`}
            </p>
          </div>

          <div className="field">
            <span className="field-label">Order types</span>
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
              <label htmlFor="nr-pickup">Pickup ready in (minutes)</label>
              <input
                id="nr-pickup"
                className="input"
                type="number"
                min={5}
                max={180}
                value={pickupPromiseMinutes}
                onChange={(e) => setPickupPromiseMinutes(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="nr-delivery">Delivery ready in (minutes)</label>
              <input
                id="nr-delivery"
                className="input"
                type="number"
                min={5}
                max={180}
                value={deliveryPromiseMinutes}
                onChange={(e) => setDeliveryPromiseMinutes(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="nr-seats">Seats</label>
              <input
                id="nr-seats"
                className="input"
                type="number"
                min={1}
                value={seats}
                onChange={(e) => setSeats(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="nr-party">Max party size</label>
              <input
                id="nr-party"
                className="input"
                type="number"
                min={1}
                max={40}
                value={maxPartySize}
                onChange={(e) => setMaxPartySize(e.target.value)}
              />
            </div>
            <div className="field span-2">
              <label htmlFor="nr-slot">Reservation length (minutes)</label>
              <input
                id="nr-slot"
                className="input"
                type="number"
                min={30}
                max={240}
                step={15}
                value={reservationSlotMinutes}
                onChange={(e) => setReservationSlotMinutes(e.target.value)}
              />
              <p className="text-muted setup-note">How long one table is held for a reservation.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="card blueprint setup-card">
        <Corners />
        <h2>Menu</h2>
        <p className="text-muted sub">
          Prices are typed in dollars and stored as whole cents. What will actually be stored is
          shown next to each price -- a wrong one is money out of the owner&rsquo;s pocket, and the
          assistant quotes it to a caller within seconds.
        </p>

        {categories.length === 0 ? (
          <p className="text-muted empty-note">
            No categories yet. The menu can also be filled in later from the owner&rsquo;s
            dashboard.
          </p>
        ) : (
          categories.map((category) => (
            <div key={category.key} className="card menu-category">
              <div className="menu-category-head">
                <div className="field">
                  <label htmlFor={`nr-cat-${category.key}`}>Category</label>
                  <input
                    id={`nr-cat-${category.key}`}
                    className="input"
                    type="text"
                    placeholder="Pasta"
                    maxLength={80}
                    value={category.name}
                    onChange={(e) => patchCategory(category.key, { name: e.target.value })}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => removeCategory(category.key)}
                >
                  Remove category
                </button>
              </div>

              {category.items.map((item) => {
                const cents = parseDollarsToCents(item.priceDollars.trim());
                return (
                  <div key={item.key} className="add-item-form">
                    <div className="field">
                      <label htmlFor={`nr-item-${item.key}`}>Item</label>
                      <input
                        id={`nr-item-${item.key}`}
                        className="input"
                        type="text"
                        placeholder="Cacio e Pepe"
                        maxLength={120}
                        value={item.name}
                        onChange={(e) => patchItem(category.key, item.key, { name: e.target.value })}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`nr-desc-${item.key}`}>Description (optional)</label>
                      <input
                        id={`nr-desc-${item.key}`}
                        className="input"
                        type="text"
                        value={item.description}
                        onChange={(e) =>
                          patchItem(category.key, item.key, { description: e.target.value })
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`nr-price-${item.key}`}>Price ($)</label>
                      <input
                        id={`nr-price-${item.key}`}
                        className="input"
                        type="text"
                        inputMode="decimal"
                        placeholder="22.00"
                        value={item.priceDollars}
                        onChange={(e) =>
                          patchItem(category.key, item.key, { priceDollars: e.target.value })
                        }
                      />
                    </div>
                    <span className="price-preview text-muted">
                      {item.priceDollars.trim() === ""
                        ? "Enter a price."
                        : cents === null
                          ? "Not a valid price."
                          : `Stores ${cents}¢ (${money(cents)}).`}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      aria-label={`Remove ${item.name || "item"}`}
                      onClick={() => removeItem(category.key, item.key)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}

              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => addItem(category.key)}
              >
                Add item
              </button>
            </div>
          ))
        )}

        <div className="setup-actions">
          <span className="text-muted setup-note">
            {itemCount} item{itemCount === 1 ? "" : "s"} across {categories.length}{" "}
            categor{categories.length === 1 ? "y" : "ies"}
          </span>
          <button type="button" className="btn btn-secondary" onClick={addCategory}>
            Add category
          </button>
        </div>
      </section>

      <section className="card blueprint setup-card">
        <Corners />
        <h2>Start</h2>
        <p className="text-muted sub">
          This creates the organization, the location, its hours and menu, generates the tool
          secret the phone agent authenticates with, creates the AI assistant on Vapi, and creates
          the owner&rsquo;s login. Nothing has been written until you press it. It does not buy a
          phone number -- that spends money, so it stays a separate step.
        </p>

        {error ? <p className="setup-error">{error}</p> : null}

        <div className="setup-actions">
          <Link href="/admin" className="btn btn-ghost">
            Cancel
          </Link>
          <button type="button" className="btn btn-primary" onClick={handleStart} disabled={pending}>
            {pending ? "Creating…" : "Start"}
          </button>
        </div>
      </section>
    </>
  );
}

/** The one screen that shows the owner's password. It is rendered from
 *  the value the server action returned to this component, in this
 *  browser tab, once. Reloading loses it: nothing on the server can
 *  produce it again, because nothing on the server kept it. */
function HandoverPanel({ restaurant }: { restaurant: CreatedRestaurant }) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      // Clipboard blocked or unavailable. Both boxes below are still
      // selectable text, so nothing is actually lost.
    }
  }

  // What the operator pastes into a message or reads down a phone. The
  // last line is not decoration: without it the owner signs in, is asked
  // for a new password, and concludes the credential they were just given
  // is broken.
  const both =
    `Dialtone sign-in for ${restaurant.locationName}\n` +
    `URL: /login\n` +
    `Email: ${restaurant.ownerEmail}\n` +
    `Temporary password: ${restaurant.ownerPassword}\n` +
    `This password is temporary. Dialtone will ask you to set your own the first time you sign in.`;

  return (
    <>
      <section className="card blueprint setup-card">
        <Corners />
        <h2>{restaurant.locationName} exists</h2>
        <p className="text-muted sub">
          The organization, location, hours, menu and AI assistant are all created, and the owner
          is attached to it.
        </p>

        <div className="cred-warn">
          <strong>Copy these now.</strong> This password is shown on this screen once and is stored
          nowhere -- not in the database, not in a log. If you lose it before handing it over, the
          owner needs a password reset.
        </div>

        <div className="cred-warn">
          <strong>Say that it is temporary.</strong> You have read this password, so it cannot stay
          theirs. The first time they sign in, Dialtone asks them to set their own and opens nothing
          else until they do. Tell them that when you hand it over -- otherwise the credential you
          just gave them looks broken the moment they use it. &ldquo;Copy both&rdquo; below includes
          the sentence.
        </div>

        <div className="field">
          <span className="field-label">Email</span>
          <div className="secret-box">{restaurant.ownerEmail}</div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => copy("email", restaurant.ownerEmail)}
          >
            {copied === "email" ? "Copied" : "Copy email"}
          </button>
        </div>

        <div className="field">
          <span className="field-label">Temporary password</span>
          <div className="secret-box">{restaurant.ownerPassword}</div>
          <div className="cred-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => copy("password", restaurant.ownerPassword)}
            >
              {copied === "password" ? "Copied" : "Copy password"}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => copy("both", both)}>
              {copied === "both" ? "Copied both" : "Copy both"}
            </button>
          </div>
        </div>
      </section>

      <section className="card blueprint setup-card">
        <Corners />
        <h2>Before this phone rings</h2>
        <ul className="missing-list">
          {restaurant.stillMissing.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="field">
          <span className="field-label">Vapi assistant</span>
          <p className="setup-note">{restaurant.assistantId}</p>
        </div>
        <div className="setup-actions">
          <Link href="/admin" className="btn btn-ghost">
            Every restaurant
          </Link>
          <Link href={`/admin/${restaurant.locationId}`} className="btn btn-primary">
            Open {restaurant.locationName}
          </Link>
        </div>
      </section>
    </>
  );
}
