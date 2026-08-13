"use server";

export type SignupState = { error?: string; sent?: boolean };

/** Public signup is closed, deliberately.
 *
 *  Restaurants do not create their own accounts. The operator creates the
 *  restaurant at /admin and hands its owner credentials, so every account
 *  on this platform is one somebody agreed to.
 *
 *  Hiding the page would not be enough — a server action stays reachable
 *  once it exists — so the refusal lives here, in the thing that would
 *  otherwise do the writing. The organization-creating SQL function it
 *  used to call is still in place and is now reached only by the
 *  operator-side flow.
 */
export async function signUp(): Promise<SignupState> {
  return {
    error: "Accounts are created by Dialtone. Ask your contact for a login.",
  };
}
