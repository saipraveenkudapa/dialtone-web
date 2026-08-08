"use client";

import { useEffect, useMemo, useState } from "react";
import { Corners } from "./Corners";
import { useMenu } from "./MenuStore";
import { UNTIL_LABEL, type SoldOutUntil } from "@/lib/menu";
import { LOCATION } from "@/lib/demo";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function Clock() {
  const [now, setNow] = useState<string>("");
  useEffect(() => {
    const tick = () =>
      setNow(
        new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: LOCATION.timezone,
        }).format(new Date()),
      );
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);
  // Empty until mounted so the server and client markup agree.
  return <span suppressHydrationWarning>{now}</span>;
}

function SyncNote() {
  const { lastChangeAt } = useMenu();
  if (!lastChangeAt) {
    return (
      <span className="text-muted">
        In sync. Every call reads this list fresh.
      </span>
    );
  }
  return (
    <span className="text-muted" suppressHydrationWarning>
      Saved{" "}
      {new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZone: LOCATION.timezone,
      }).format(lastChangeAt)}{" "}
      · live on the next call
    </span>
  );
}

export function ManagerScreen() {
  const { categories, itemCount, soldOut, toggleSoldOut, setSoldOutUntil } =
    useMenu();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return categories
      .map((c) => ({
        ...c,
        items: q ? c.items.filter((it) => it.name.toLowerCase().includes(q)) : c.items,
      }))
      .filter((c) => c.items.length > 0);
  }, [categories, query]);

  const noResults = groups.length === 0;

  return (
    <div className="manager-wrap">
      <div className="manager-intro">
        <h1>The manager screen</h1>
        <p className="text-muted">
          One hand, mid-service, screen covered in flour. Tap once and the agent
          stops offering it on the next call. No dialog, no save button.
        </p>
        <div className="manager-facts">
          <div>56px minimum tap targets</div>
          <div>Nothing depends on hover</div>
          <div>Other staff&rsquo;s toggles arrive live</div>
          <div>
            Sold out <em>now</em> or <em>until close</em>
          </div>
        </div>
        <div className="manager-sync">
          <SyncNote />
        </div>
      </div>

      <div className="phone blueprint elev-lg">
        <Corners />

        <div className="phone-status num">
          <Clock />
          <span className="text-muted">{LOCATION.name}</span>
        </div>

        <div className="phone-search">
          <input
            className="input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the menu"
            aria-label="Search the menu"
          />
          <div className="phone-counts">
            <span className="tag tag-neutral">{itemCount} items</span>
            <span className={soldOut.length ? "tag tag-out" : "tag tag-neutral"}>
              {soldOut.length} sold out
            </span>
          </div>
        </div>

        <div className="lv-scroll">
          {groups.map((g) => (
            <section key={g.id}>
              <h2 className="lv-group">{g.name}</h2>
              {g.items.map((it) => {
                const out = it.soldOutUntil !== null;
                return (
                  <div key={it.id}>
                    <div className="lv-row">
                      <div className="lv-name">
                        <div className={out ? "name out" : "name"}>{it.name}</div>
                        <div className="meta num">
                          {money(it.priceCents)}
                          {out ? ` · ${UNTIL_LABEL[it.soldOutUntil!]}` : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={out ? "lv-toggle is-out" : "lv-toggle"}
                        aria-pressed={out}
                        onClick={() => toggleSoldOut(it.id)}
                      >
                        {out ? "Sold out" : "Available"}
                      </button>
                    </div>

                    {out ? (
                      <div className="lv-until" role="group" aria-label={`${it.name} — until when`}>
                        {(["reopen", "close"] as SoldOutUntil[]).map((u) => (
                          <button
                            key={u}
                            type="button"
                            className={
                              it.soldOutUntil === u ? "lv-until-opt is-on" : "lv-until-opt"
                            }
                            aria-pressed={it.soldOutUntil === u}
                            onClick={() => setSoldOutUntil(it.id, u)}
                          >
                            {UNTIL_LABEL[u]}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}

          {noResults ? (
            <div className="lv-empty">
              <p className="text-muted">Nothing matches &ldquo;{query}&rdquo;.</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
