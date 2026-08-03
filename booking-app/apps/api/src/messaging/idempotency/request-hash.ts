import { createHash } from 'node:crypto';

/**
 * A fingerprint of a request body, stable across encodings of the same request.
 *
 * The point is to tell "the client retried the same request" from "the client
 * reused a key for a different request". The first must replay the stored response;
 * the second must be refused, because replaying it would return a Checkout URL for
 * a booking the caller did not ask for.
 *
 * So the comparison has to ignore what carries no meaning — the order JSON
 * serialises object keys in, and the case and padding of an email address — while
 * preserving everything that does. In particular array order is meaningful and
 * `null` is not the same as absent: `{ employeeId: null }` asks for automatic
 * assignment, `{}` may mean the field was never sent.
 */

/** Field names whose value is compared case- and whitespace-insensitively. */
const NORMALISED_FIELDS = new Set(['email']);

/**
 * Rebuild a value with object keys in a fixed order and emails normalised.
 *
 * Recursive rather than a `JSON.stringify` replacer, because a replacer sees keys
 * in their original order and cannot reorder them.
 */
function canonicalise(value: unknown, key?: string): unknown {
  if (typeof value === 'string' && key !== undefined && NORMALISED_FIELDS.has(key)) {
    return value.trim().toLowerCase();
  }

  // Arrays keep their order: `[serviceA, serviceB]` is not `[serviceB, serviceA]`.
  if (Array.isArray(value)) return value.map((item) => canonicalise(item));

  if (value === null || typeof value !== 'object') return value;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` would be dropped by JSON.stringify anyway; dropping it here keeps
    // the sorted key list honest.
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return Object.fromEntries(entries.map(([name, item]) => [name, canonicalise(item, name)]));
}

/** The canonical JSON form, exported for tests and for diagnosing a mismatch. */
export function canonicalRequestJson(body: unknown): string {
  return JSON.stringify(canonicalise(body ?? null));
}

/** SHA-256, hex, of the canonical form. */
export function canonicalRequestHash(body: unknown): string {
  return createHash('sha256').update(canonicalRequestJson(body), 'utf8').digest('hex');
}
