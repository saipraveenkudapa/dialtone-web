/* The one fact that says "this account is still using the password an
 * operator read off a screen", and the rules for what that account may
 * reach until it is not.
 *
 * WHERE THE FLAG LIVES, AND WHY IT IS NOT user_metadata
 * -----------------------------------------------------
 * Supabase gives every auth user two metadata bags, and only one of them
 * is a place to keep a permission:
 *
 *   * `user_metadata` is writable by the user themselves. Any signed-in
 *     account can POST `auth.updateUser({ data: { ... } })` with the
 *     anon key and its own token and set whatever it likes in there.
 *     A flag stored in it would be a flag its subject can clear -- the
 *     owner would open the console, wipe it, and walk straight past the
 *     gate still holding the password their operator knows.
 *   * `app_metadata` is writable only through the admin API, which needs
 *     the service-role key. In this app that key exists in exactly one
 *     module (lib/supabase/admin.ts) and never leaves the server, so the
 *     only things that can set or clear this flag are the provisioning
 *     path that creates the account and the action that finishes a
 *     genuine password change.
 *
 * It also travels in the JWT and comes back from `getUser()`, so the
 * middleware can decide on it without a database round trip per request.
 *
 * A column on a table was the alternative and would have worked, but it
 * would have needed its own RLS policy to stop the owner updating it,
 * plus a query in the middleware on every single request. app_metadata is
 * already exactly this: server-owned state attached to an auth user.
 *
 * WHO GETS IT
 * -----------
 * Only accounts minted by lib/provisioning/create-restaurant.ts, at the
 * moment they are created. Nothing else in the product writes it. The
 * operator's own platform-admin login was not created by that path, so it
 * is not flagged and /admin never disappears from under them.
 *
 * This module deliberately holds no imports. The middleware runs in the
 * edge runtime and cannot see `next/headers`; the server actions need
 * something they can call. Both need the same answer, so the answer lives
 * here on its own and the two callers bring their own user object.
 */

/** The key inside `app_metadata`. */
export const MUST_CHANGE_PASSWORD_CLAIM = "must_change_password";

/** Where a flagged account is sent, and the only page it can render. */
export const SET_PASSWORD_PATH = "/set-password";

/** The floor a chosen password has to clear, enforced on the server in
 *  app/set-password/actions.ts. Twelve rather than Supabase's own default
 *  of six: this is the credential to a screen that shows every call, every
 *  order and every caller's phone number, and the person choosing it is
 *  doing so once, today, with the prompt in front of them. */
export const MINIMUM_PASSWORD_LENGTH = 12;

/** Only ever read `app_metadata`. Passing a user object whose flag sits
 *  in `user_metadata` returns false on purpose -- see the header. */
type UserLike = {
  app_metadata?: Record<string, unknown> | null;
} | null | undefined;

export function mustChangePassword(user: UserLike): boolean {
  return user?.app_metadata?.[MUST_CHANGE_PASSWORD_CLAIM] === true;
}

/** What a signed-in account still carrying its temporary password may
 *  load. Everything absent from this list is a redirect to
 *  SET_PASSWORD_PATH -- the dashboard, the calls, the orders, the menu,
 *  the manager screen, and /admin too.
 *
 *  Two exemptions, each for a reason:
 *
 *    * SET_PASSWORD_PATH itself, or the redirect would loop. Server
 *      actions POST to the URL they were rendered on, so this is also
 *      what lets "set my password" and "sign out" run at all.
 *    * /auth/*, which is the magic-link exchange. It has to be able to
 *      turn a link into a session; the gate then catches the very next
 *      request and sends them here anyway.
 *    * /api/*, which is not this session's business. Those routes carry
 *      Vapi's and Twilio's own credentials and no browser cookie, so a
 *      user flag can neither reach them nor authorise them -- and a
 *      redirect there would answer a live phone call with a 307. */
export function reachableWithTemporaryPassword(pathname: string): boolean {
  return (
    pathname === SET_PASSWORD_PATH ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/api/")
  );
}
