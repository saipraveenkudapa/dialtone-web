/* The password the operator reads off the screen and hands to the
 * restaurant owner.
 *
 * Two constraints pull against each other and both are real:
 *
 *   * It has to survive being copied out of a browser, pasted into a
 *     message, and quite possibly read aloud down a phone line. Anything
 *     built from an alphabet containing 0/O, 1/l/I, or 5/S turns into a
 *     support call the first time somebody types it by hand.
 *   * It has to be strong enough that it never needs rotating, because
 *     nothing in this product will remind anyone to rotate it.
 *
 * 20 characters from a 58-character unambiguous alphabet is ~117 bits of
 * entropy -- far past anything guessable, while still being a string a
 * human can transcribe. It is grouped into blocks of five with hyphens
 * purely so the eye can track position while retyping; the hyphens are
 * part of the password and count for nothing, which is why the entropy
 * above counts only the 20 random characters.
 *
 * crypto.randomInt, not `Math.random()` and not `randomBytes[i] % n`:
 * the first is not a CSPRNG at all, and the second skews toward the
 * start of the alphabet whenever 256 is not a multiple of the alphabet
 * length (it isn't, for 58). randomInt rejects and re-draws internally,
 * so every character is uniform.
 *
 * Nothing here ever writes the result anywhere. See
 * lib/provisioning/create-restaurant.ts for the one path it takes: into
 * Supabase's own createUser call, and into the server action's return
 * value, which is rendered once and never persisted. */

import crypto from "node:crypto";

/** No 0/O, no 1/l/I, no 5/S, no 2/Z, no 8/B. What's left is still
 *  plenty, and every character survives being read down a phone. */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzACDEFGHJKLMNPQRTUVWXY34679";

const LENGTH = 20;
const GROUP = 5;

export function generateOwnerPassword(): string {
  let raw = "";
  for (let i = 0; i < LENGTH; i++) {
    raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }

  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += GROUP) groups.push(raw.slice(i, i + GROUP));
  return groups.join("-");
}

/** Exported for the test that proves the alphabet has no character an
 *  operator could misread as another one. */
export const OWNER_PASSWORD_ALPHABET = ALPHABET;
export const OWNER_PASSWORD_LENGTH = LENGTH;
