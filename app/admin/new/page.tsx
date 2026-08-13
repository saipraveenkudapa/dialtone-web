import Link from "next/link";
import { notFound } from "next/navigation";
import { currentPlatformAdmin } from "@/lib/admin/auth";
import { NewRestaurantForm } from "@/components/admin/NewRestaurantForm";

export const metadata = { title: "Create a new restaurant · Dialtone" };

export default async function NewRestaurantPage() {
  // app/admin/layout.tsx already refuses a non-admin, and the server
  // action refuses again before it writes anything. This third check
  // costs one cached call and means the page cannot be rendered by
  // anyone who should not see it even if the layout is ever restructured.
  const admin = await currentPlatformAdmin();
  if (!admin) notFound();

  // Every IANA zone Node knows, sorted -- not a hand-picked shortlist,
  // since restaurants using this exist wherever Vapi and Twilio can
  // reach them, not only in the handful of US zones a shortlist assumes.
  const timezones = Intl.supportedValuesOf("timeZone");

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/admin" className="row-link">
            ← Every restaurant
          </Link>
          <h1>Create a new restaurant</h1>
          <div className="text-muted sub">
            Fill this in from the customer&rsquo;s details, then press Start. You walk away with a
            login to hand them.
          </div>
        </div>
      </div>

      <div className="setup-stack">
        <NewRestaurantForm timezones={timezones} />
      </div>
    </>
  );
}
