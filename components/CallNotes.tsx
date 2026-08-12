"use client";

import { useState, useTransition } from "react";
import { Corners } from "./Corners";
import { saveCallNotes } from "@/app/dashboard/calls/actions";

export function CallNotes({ callId, notes }: { callId: string; notes: string }) {
  const [value, setValue] = useState(notes);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const dirty = value !== notes;

  const save = () =>
    startTransition(async () => {
      const result = await saveCallNotes(callId, value);
      if (result?.error) {
        setError(result.error);
        setSaved(null);
      } else {
        setError(null);
        setSaved("Saved");
      }
    });

  return (
    <div className="card blueprint call-notes">
      <Corners />
      <div className="card-kicker">Notes</div>
      <textarea
        className="input"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(null);
        }}
        placeholder="What happened on this call?"
        aria-label="Notes about this call"
      />
      <div className="call-notes-foot">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={save}
          disabled={pending || !dirty}
        >
          {pending ? "Saving…" : "Save notes"}
        </button>
        {error ? <span className="auth-error">{error}</span> : null}
        {saved ? <span className="text-muted">{saved}</span> : null}
      </div>
    </div>
  );
}
