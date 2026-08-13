"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Corners } from "./Corners";
import { signUp, type SignupState } from "@/app/signup/actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
      {pending ? "One moment…" : "Create account"}
    </button>
  );
}

export function SignupForm() {
  const [state, action] = useActionState<SignupState, FormData>(signUp, {});

  return (
    <div className="card blueprint auth-card">
      <Corners />

      {state.sent ? (
        <p className="text-muted auth-note">
          Check your email to confirm your account. The link finishes setting
          up your restaurant and signs you in.
        </p>
      ) : (
        <form action={action} className="auth-form">
          <div className="field">
            <label htmlFor="businessName">Restaurant name</label>
            <input
              id="businessName"
              className="input"
              type="text"
              name="businessName"
              autoComplete="organization"
              maxLength={120}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="signup-email">Email</label>
            <input
              id="signup-email"
              className="input"
              type="email"
              name="email"
              autoComplete="email"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="signup-password">Password</label>
            <input
              id="signup-password"
              className="input"
              type="password"
              name="password"
              autoComplete="new-password"
              minLength={6}
              required
            />
          </div>
          <Submit />
        </form>
      )}

      {state.error ? <p className="auth-error">{state.error}</p> : null}

      <p className="text-muted auth-note">
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </div>
  );
}
