"use client";

import { useCallback, useState, useTransition, type FormEvent } from "react";
import Link from "next/link";
import { Corners } from "@/components/Corners";
import { MenuUpload } from "@/components/MenuUpload";
import { uploadMenuFile } from "@/lib/menu-imports/upload";
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

  const [stagedMenuFiles, setStagedMenuFiles] = useState<File[]>([]);
  const [menuFileNotes, setMenuFileNotes] = useState<string[]>([]);

  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedRestaurant | null>(null);
  const [pending, startTransition] = useTransition();

  // Stable identity on purpose: MenuUpload calls this on every change to
  // the staged files, and a new function each render would make that a
  // loop.
  const takeStagedFiles = useCallback((files: File[]) => setStagedMenuFiles(files), []);

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

  /* Start, and Enter in any of the thirty-seven fields above it.
   *
   *  It stays an imperative call inside startTransition rather than
   *  becoming <form action={createRestaurantAction}>, and that is the
   *  deliberate half of what used to be a type="button": this action
   *  returns a password that is rendered once, in this tab, from this
   *  component's own state, and an action form would re-render the form
   *  underneath the panel showing it. What was NOT deliberate is that
   *  there was no <form> at all -- so Enter did nothing, and thirty-seven
   *  fields went to the server without the browser ever being asked
   *  whether the required ones were filled in. */
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      if (!result.restaurant) return;

      // Only now is there a location id, and the first segment of every
      // menu-upload path is one. The files have been sitting in this tab
      // waiting for it.
      setMenuFileNotes(await storeStagedMenuFiles(result.restaurant.locationId, stagedMenuFiles));
      setCreated(result.restaurant);
    });
  }

  // Once the restaurant exists, the form is gone. The credentials below
  // are the only copy of that password anywhere, and re-rendering the
  // form underneath them would invite a second Start.
  if (created) return <HandoverPanel restaurant={created} menuFileNotes={menuFileNotes} />;

  const previewBps = parsePercentToBasisPoints(taxPercent.trim());
  const itemCount = categories.reduce((sum, c) => sum + c.items.length, 0);

  return (
    /* .setup-stack a second time, on purpose: app/admin/new/page.tsx
       renders this into one, and without it here the six sections
       become children of the form and lose the column and the gap the
       page was laying them out with. No new CSS, and no display:
       contents, which drops the form's own role in several browsers. */
    <form className="setup-stack" onSubmit={handleSubmit}>
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
              required
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
              required
              placeholder="1412 Telegraph Ave, Oakland, CA"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>

          {/* A GRID, NOT .setup-row. .setup-row is "a field and the
              buttons that act on it, bottom-aligned" -- align-items:
              flex-end is the whole point of it and is right for that
              job. Two FIELDS in it are only aligned while they are the
              same height, and these two are not: the note under the
              timezone select is 37px of text plus its 4px step, so at
              1280px the display-phone input sat 41px below the select
              beside it (measured). .money-grid is the two-column field
              pair this same form already uses further down -- equal
              columns, tops aligned, and it collapses to one column at
              the same 700px .setup-row does. */}
          <div className="money-grid">
            <div className="field">
              <label htmlFor="nr-timezone">Timezone</label>
              <select
                id="nr-timezone"
                className="input"
                required
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
              required
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
              required
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
                {/* And none here either: required on a checkbox means
                    "must be ticked", and this one means the opposite of
                    what it would then be demanding. */}
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
                  /* Required while the day is open, and silent while it
                     is closed -- a disabled control is excluded from
                     constraint validation, which is verbatim what
                     validateRestaurantDraft does with a closed day. */
                  required
                  aria-label={`${label} opens`}
                  value={hours[day].open}
                  disabled={hours[day].closed}
                  onChange={(e) => setDay(day, { open: e.target.value })}
                />
                <span className="text-muted">to</span>
                <input
                  className="input"
                  type="time"
                  required
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
              required
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

          {/* NO required ON THESE, deliberately. The validator does
              demand one of the three -- but one is always checked, a
              radio cannot be un-checked, and .seg-opt inputs are
              position: absolute with zero size. A required radio group
              that is somehow empty and not focusable makes the browser
              refuse to submit while reporting nothing anybody can see,
              which is a worse failure than the one it guards against. */}
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
                required
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
                required
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
                required
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
                required
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
                required
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
                    /* The menu as a whole is optional -- a restaurant
                       can be created with none of it. A category that
                       has been ADDED is not: "Every menu category needs
                       a name," says the validator, and so does this. */
                    required
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
                        required
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
                        /* An item with no price is refused by the
                           validator, and a price is the one thing on
                           this form the assistant reads out loud. The
                           description beside it is optional in both
                           places, so it carries nothing. */
                        required
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

      {/* The same component the owner uses on /dashboard/menu. There is
          no restaurant yet, so it holds the files rather than sending
          them: Start creates the location, and these go up against its
          id straight after. */}
      <MenuUpload
        locationId={null}
        timezone={timezone}
        onStagedFilesChange={takeStagedFiles}
        disabled={pending}
      />

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
          {/* A real submit button, so Enter anywhere in the form does
              what pressing this does -- and so the browser runs its own
              constraint check over the required fields first. */}
          <button type="submit" className="btn btn-primary" disabled={pending}>
            {pending ? "Creating…" : "Start"}
          </button>
        </div>
      </section>
    </form>
  );
}

/** The menu files the operator picked before the restaurant existed.
 *
 *  Deliberately after creation and deliberately not fatal. The location
 *  is real, the login below is real, and a file that did not make it is
 *  a line on the handover screen rather than a rolled-back restaurant --
 *  the owner can upload it again from their own dashboard. Uploaded one
 *  at a time so a single bad file is named, not the whole batch. */
async function storeStagedMenuFiles(locationId: string, files: File[]): Promise<string[]> {
  if (files.length === 0) return [];

  const batchId = crypto.randomUUID();
  const notes: string[] = [];
  let stored = 0;

  for (const file of files) {
    const result = await uploadMenuFile({ locationId, batchId, file });
    if ("menuImport" in result) stored += 1;
    else notes.push(`${file.name} did not upload: ${result.error}`);
  }

  if (stored > 0) {
    notes.unshift(
      `${stored} menu file${stored === 1 ? "" : "s"} stored, waiting to be read. Nothing in ` +
        "them is on the menu yet -- somebody has to confirm every price first.",
    );
  }
  return notes;
}

/** The one screen that shows the owner's password. It is rendered from
 *  the value the server action returned to this component, in this
 *  browser tab, once. Reloading loses it: nothing on the server can
 *  produce it again, because nothing on the server kept it. */
function HandoverPanel({
  restaurant,
  menuFileNotes,
}: {
  restaurant: CreatedRestaurant;
  menuFileNotes: string[];
}) {
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
        {menuFileNotes.length > 0 ? (
          <div className="field">
            <span className="field-label">Menu files</span>
            <ul className="missing-list">
              {menuFileNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}
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
