import { LoginForm } from "@/components/LoginForm";

export const metadata = { title: "Sign in · Dialtone" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = typeof params.next === "string" ? params.next : "/dashboard";
  const linkError = params.error === "link";

  return (
    <div className="auth-page">
      <div className="auth-head">
        <div className="sidebar-brand">Dialtone</div>
        <p className="text-muted">Stop missing calls.</p>
      </div>
      <LoginForm next={next} linkError={linkError} />
    </div>
  );
}
