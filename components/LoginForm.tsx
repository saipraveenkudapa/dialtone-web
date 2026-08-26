"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Corners } from "./Corners";
import {
  sendMagicLink,
  signInWithPassword,
  type AuthState,
} from "@/app/login/actions";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
      {pending ? "One moment…" : label}
    </button>
  );
}

export function LoginForm({
  next,
  linkError,
}: {
  next: string;
  linkError: boolean;
}) {
  const [mode, setMode] = useState<"password" | "link">("password");
  const [pwState, pwAction] = useActionState<AuthState, FormData>(
    signInWithPassword,
    {},
  );
  const [linkState, linkAction] = useActionState<AuthState, FormData>(
    sendMagicLink,
    {},
  );

  const state = mode === "password" ? pwState : linkState;

  return (
    <div className="card blueprint auth-card">
      <Corners />

      <div className="seg auth-seg">
        <label className="seg-opt">
          <input
            type="radio"
            name="mode"
            checked={mode === "password"}
            onChange={() => setMode("password")}
          />
          Password
        </label>
        <label className="seg-opt">
          <input
            type="radio"
            name="mode"
            checked={mode === "link"}
            onChange={() => setMode("link")}
          />
          Email me a link
        </label>
      </div>

      {linkError ? (
        <p className="auth-error">That link has expired. Ask for a new one.</p>
      ) : null}

      {mode === "password" ? (
        <form action={pwAction} className="auth-form">
          <input type="hidden" name="next" value={next} />
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              className="input"
              type="email"
              name="email"
              autoComplete="email"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="input"
              type="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </div>
          <Submit label="Sign in" />
        </form>
      ) : (
        <form action={linkAction} className="auth-form">
          <input type="hidden" name="next" value={next} />
          <div className="field">
            <label htmlFor="magic-email">Email</label>
            <input
              id="magic-email"
              className="input"
              type="email"
              name="email"
              autoComplete="email"
              required
            />
          </div>
          {linkState.sent ? (
            <p className="text-muted auth-note">
              Check your email. The link signs you straight in.
            </p>
          ) : (
            <Submit label="Send the link" />
          )}
        </form>
      )}

      {state.error ? <p className="auth-error">{state.error}</p> : null}

      <p className="text-muted auth-note">
        </p>
    </div>
  );
}
