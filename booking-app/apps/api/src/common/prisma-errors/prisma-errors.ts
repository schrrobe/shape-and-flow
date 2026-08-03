import { Prisma } from '../../prisma/client.js';

/**
 * Translating PostgreSQL integrity errors into domain outcomes.
 *
 * The implementation plan assumed exclusion violations would arrive as an
 * opaque PrismaClientUnknownRequestError with the SQLSTATE buried in a message,
 * and that matching would therefore be shape-fragile. Prisma 7's pg driver
 * adapter is better than that: a 23P01 arrives as a
 * PrismaClientKnownRequestError with code `P2039` and the SQLSTATE available as
 * structured data at `meta.driverAdapterError.cause.originalCode`, alongside the
 * original PostgreSQL message naming the constraint.
 *
 * So the structured path is primary here, with a message match kept only as a
 * fallback for other adapters. Every predicate is covered twice: by unit tests
 * over synthetic shapes, and by integration tests that provoke genuine
 * violations against a real PostgreSQL — which is what would catch a change in
 * this shape after a Prisma upgrade.
 */

/** SQLSTATEs this module reasons about. */
const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

interface DriverAdapterCause {
  originalCode?: unknown;
  code?: unknown;
  originalMessage?: unknown;
  message?: unknown;
  kind?: unknown;
  constraint?: { fields?: unknown; index?: unknown };
}

function driverCause(error: unknown): DriverAdapterCause | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return undefined;

  const meta = error.meta as { driverAdapterError?: { cause?: DriverAdapterCause } } | undefined;

  return meta?.driverAdapterError?.cause;
}

const isSqlState = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value);

/**
 * The five-character SQLSTATE behind a Prisma error, or undefined when the
 * error did not come from the database.
 */
export function sqlState(error: unknown): string | undefined {
  const cause = driverCause(error);

  if (isSqlState(cause?.originalCode)) return cause.originalCode;
  if (isSqlState(cause?.code)) return cause.code;

  // Fallback for adapters that only render the code into the message.
  if (error instanceof Error) {
    const match = /\bCode:\s*`([0-9A-Z]{5})`/.exec(error.message);
    if (match?.[1]) return match[1];
  }

  return undefined;
}

/** The original PostgreSQL message, which names the offending constraint. */
function databaseMessage(error: unknown): string {
  const cause = driverCause(error);

  if (typeof cause?.originalMessage === 'string') return cause.originalMessage;
  if (typeof cause?.message === 'string') return cause.message;
  return error instanceof Error ? error.message : '';
}

/**
 * True for a 23P01 exclusion violation.
 *
 * Always pass the constraint name at a call site that maps to a specific domain
 * error: a booking insert can only mean `bookings_no_overlap`, and mapping any
 * exclusion violation to "slot unavailable" would mask an unrelated one.
 */
export function isExclusionViolation(error: unknown, constraintName?: string): boolean {
  if (sqlState(error) !== SQLSTATE.EXCLUSION_VIOLATION) return false;
  if (constraintName === undefined) return true;
  return databaseMessage(error).includes(constraintName);
}

/** True for a 23514 check violation, optionally for one named constraint. */
export function isCheckViolation(error: unknown, constraintName?: string): boolean {
  if (sqlState(error) !== SQLSTATE.CHECK_VIOLATION) return false;
  if (constraintName === undefined) return true;
  return databaseMessage(error).includes(constraintName);
}

/** `providerEventId` → `provider_event_id`, so either spelling can be matched. */
function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * True for a unique violation, optionally for one named constraint or column.
 *
 * `target` may be a column name, an index name, or the Prisma **field** name. The
 * last one needs saying because it does not appear anywhere in the error: Prisma 7's
 * pg adapter reports `constraint.fields` as database columns (`stripe_event_id`) and
 * its own message says the same, so a call passing `stripeEventId` matched nothing
 * and the violation was rethrown as a 500 instead of being handled. Both spellings
 * are normalised here rather than at each call site, because the failure is silent
 * in exactly the case the caller was trying to handle.
 */
export function isUniqueViolation(error: unknown, target?: string): boolean {
  const isUnique =
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') ||
    sqlState(error) === SQLSTATE.UNIQUE_VIOLATION;

  if (!isUnique) return false;
  if (target === undefined) return true;

  const cause = driverCause(error);
  const fields = Array.isArray(cause?.constraint?.fields)
    ? (cause.constraint.fields as unknown[]).map(String)
    : [];
  const index = typeof cause?.constraint?.index === 'string' ? cause.constraint.index : '';

  const snake = toSnakeCase(target);
  const haystack = `${index} ${databaseMessage(error)} ${error instanceof Error ? error.message : ''}`;

  return (
    fields.includes(target) ||
    fields.includes(snake) ||
    haystack.includes(target) ||
    haystack.includes(snake)
  );
}

export function isForeignKeyViolation(error: unknown): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') ||
    sqlState(error) === SQLSTATE.FOREIGN_KEY_VIOLATION
  );
}

/**
 * True for a serialization failure or a deadlock — the two conditions that are
 * safe to retry because the transaction made no durable change.
 */
export function isSerializationFailure(error: unknown): boolean {
  const state = sqlState(error);
  return state === SQLSTATE.SERIALIZATION_FAILURE || state === SQLSTATE.DEADLOCK_DETECTED;
}
