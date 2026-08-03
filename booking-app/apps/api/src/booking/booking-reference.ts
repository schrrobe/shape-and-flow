import { randomInt } from 'node:crypto';

/**
 * Crockford base32: no `I`, `L`, `O` or `U`.
 *
 * `I`/`L` versus `1`, and `O` versus `0`, are the pairs people get wrong reading a
 * code down the phone — which is the only thing this alphabet exists to survive. `U`
 * is dropped so a random six-character reference cannot spell something unfortunate.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const LENGTH = 6;

/** Matches what {@link generateBookingReference} produces. Used by tests and by parsing. */
export const BOOKING_REFERENCE_PATTERN = /^SF-[0-9A-HJKMNP-TV-Z]{6}$/;

/**
 * A short reference a customer can read out.
 *
 * Not a credential, and nothing may authenticate with it: 32^6 is about a billion,
 * which is plenty against collision and nowhere near enough against guessing. The
 * `/manage` surface requires a ManagementToken for exactly this reason.
 *
 * `randomInt` rather than `Math.random` — not because guessing matters here, but
 * because a reference generator that is only *almost* uniform produces collisions
 * sooner than the arithmetic suggests, and the caller's retry budget is small.
 */
export function generateBookingReference(): string {
  const characters = Array.from({ length: LENGTH }, () =>
    ALPHABET.charAt(randomInt(ALPHABET.length)),
  );

  return `SF-${characters.join('')}`;
}
