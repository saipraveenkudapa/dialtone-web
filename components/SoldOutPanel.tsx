"use client";

import Link from "next/link";
import { useMenu } from "./MenuStore";
import { UNTIL_LABEL } from "@/lib/menu";

export function SoldOutPanel() {
  const { soldOut } = useMenu();

  return (
    <section className="panel">
      <h4>Sold out right now</h4>
      {soldOut.length === 0 ? (
        <p className="text-muted empty-note">
          Nothing is flagged. The agent is offering the whole menu.
        </p>
      ) : (
        <div className="soldout-list">
          {soldOut.map((s) => (
            <div key={s.id} className="soldout-row">
              <span>{s.name}</span>
              <span className="until">{UNTIL_LABEL[s.until]}</span>
            </div>
          ))}
        </div>
      )}
      <Link href="/dashboard/menu/live" className="btn btn-ghost">
        Edit on the manager screen
      </Link>
    </section>
  );
}
