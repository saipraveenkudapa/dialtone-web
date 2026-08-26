import { notFound } from "next/navigation";

export const metadata = { title: "Sign up · Dialtone" };

/** Public signup is closed, deliberately.
 *
 *  Restaurants do not create their own accounts. The operator creates the
 *  restaurant and hands its owner credentials, so that every account on
 *  the platform is one somebody agreed to. Leaving a public signup route
 *  live would let a stranger create an organization in this project and
 *  provision a voice assistant against it.
 *
 *  The operator-side flow is at /admin. */
export default function SignupPage() {
  notFound();
}
