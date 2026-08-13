import { SignupForm } from "@/components/SignupForm";

export const metadata = { title: "Sign up · Dialtone" };

export default function SignupPage() {
  return (
    <div className="auth-page">
      <div className="auth-head">
        <div className="sidebar-brand">Dialtone</div>
        <p className="text-muted">Set up your restaurant.</p>
      </div>
      <SignupForm />
    </div>
  );
}
