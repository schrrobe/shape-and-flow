import { REDACT_CENSOR, REDACT_PATHS } from '../logging/redaction.js';

/**
 * The field names an audit row must not carry, derived from the log redaction list.
 *
 * Derived rather than restated. An audit row is as readable as a log line — more so,
 * because it is queried by name and kept for years — so the two lists have to agree, and
 * a second hand-written list is a second thing to forget when a field is added. Taking
 * the last segment of each pino path gives exactly the field names, and widens the rule
 * on purpose: pino's `body.customerNote` is anchored, while `customerNote` here matches
 * wherever it appears in a nested `before`/`after`.
 */
export const AUDIT_REDACTED_KEYS: ReadonlySet<string> = new Set(
  REDACT_PATHS.map(lastSegment).map((key) => key.toLowerCase()),
);

/** `req.headers["set-cookie"]` → `set-cookie`; `*.token` → `token`. */
function lastSegment(path: string): string {
  const bracketed = /\["([^"]+)"\]$/.exec(path);
  if (bracketed?.[1] !== undefined) return bracketed[1];

  const segments = path.split('.');
  return segments[segments.length - 1] ?? path;
}

/**
 * A value safe to store in `before` or `after`.
 *
 * Redacts by key name at every depth and leaves the shape intact, because the shape is
 * what makes an audit row readable a year later: `{ email: "[Redacted]" }` says an email
 * changed, while a dropped key says nothing happened.
 *
 * Anything that is not JSON — a Date, a Decimal, a Map — is handed back as the instance it
 * came in as, so the caller's `JSON.stringify` can still reach its `toJSON`. Rebuilding one
 * from its own enumerable properties would replace a Prisma `startsAt` with `{}`: a `Date`
 * has none, and once the instance is gone there is no `toJSON` left to call.
 */
export function redactForAudit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForAudit);

  if (value === null || typeof value !== 'object') return value;

  if (!isPlainObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      AUDIT_REDACTED_KEYS.has(key.toLowerCase()) ? REDACT_CENSOR : redactForAudit(entry),
    ]),
  );
}

/**
 * Whether a value is an object literal rather than an instance of something.
 *
 * A `null` prototype counts, because that is what `Object.fromEntries` and a parsed JSON
 * body with `__proto__` produce. Everything else is left whole — which does mean a class
 * instance carrying a redacted field would pass through unredacted, and is safe here
 * because the interceptor is only ever handed Prisma rows and response DTOs, whose
 * non-plain values are timestamps and numbers.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
