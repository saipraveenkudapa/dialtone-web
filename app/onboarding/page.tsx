import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard";
import { getOnboardingHours, getOnboardingLocation, getOwnOrgName } from "@/lib/onboarding/data";
import { getMenu } from "@/lib/data";

export const metadata = { title: "Set up your restaurant · Dialtone" };

// Deliberately NOT `redirect("/dashboard")` here for an already-finished
// location, tempting as that looks. Next.js re-renders this Server
// Component as part of reconciling ANY "use server" action's response
// for this route -- not only ones that call revalidatePath, that is just
// how the Server Actions protocol works -- and finishOnboarding's own
// database write (setting agent_secret_hash) happens inside the very
// request that also asks this page to re-render. A redirect() here would
// therefore fire the instant finishOnboarding succeeds, yanking the
// owner to /dashboard before they have seen -- let alone copied -- the
// one-time secret sitting in that same response. Confirmed by
// instrumenting history.replaceState during manual testing: removing
// every revalidatePath call from finishOnboarding did not stop it: this
// redirect was still firing on the very re-render Next performs to
// produce that action's own response.
//
// OnboardingWizard decides what to show instead, using only the location
// as it was at the moment this page first loaded (see its own
// `alreadyDone` state, captured once via useState's lazy initializer) --
// a value that cannot retroactively change just because a server action
// invoked later in the same client session caused this Server Component
// to run again in the background.
export default async function OnboardingPage() {
  const location = await getOnboardingLocation();

  const [hours, menu, orgName] = await Promise.all([
    location ? getOnboardingHours(location.id) : Promise.resolve([]),
    location ? getMenu(location.id) : Promise.resolve([]),
    getOwnOrgName(),
  ]);

  // Every IANA zone Node knows, sorted -- not a hand-picked shortlist,
  // since restaurants using this exist wherever Vapi and Twilio can reach
  // them, not only in the handful of US timezones a shortlist would
  // assume.
  const timezones = Intl.supportedValuesOf("timeZone");

  return (
    <OnboardingWizard
      initialLocation={location}
      initialHours={hours}
      initialMenu={menu}
      suggestedName={orgName}
      timezones={timezones}
    />
  );
}
