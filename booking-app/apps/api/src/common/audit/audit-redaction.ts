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
 * Anything that is not JSON — a Date, a Map, a class instance — is stringified by the
 * caller's `JSON.stringify` on the way into the JSONB column; this only walks plain
 * objects and arrays, which is all a response body or a Prisma row ever is.
 */
export function redactForAudit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForAudit);

  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      AUDIT_REDACTED_KEYS.has(key.toLowerCase()) ? REDACT_CENSOR : redactForAudit(entry),
    ]),
  );
}
