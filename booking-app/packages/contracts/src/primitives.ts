import { z } from 'zod';

/**
 * Primitives every request and response schema is built from.
 *
 * This package depends on nothing but Zod, deliberately: it has to be importable
 * from the Node API and from the browser bundle, so it can never reach for Prisma,
 * Nest or anything Node-only.
 */

/** A cuid, as generated for every primary key. Opaque to clients. */
export const cuidSchema = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-z0-9]+$/, 'must be a cuid');

/** ISO-8601 UTC with milliseconds, which is how every instant is serialised. */
export const isoInstantSchema = z.iso.datetime({ offset: false });

/** `YYYY-MM-DD` in the organization's timezone, and a real date. */
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === (month ?? 1) - 1 &&
      date.getUTCDate() === day
    );
  }, 'must be a real calendar date');

/**
 * Money on the wire: integer minor units and a currency, never a formatted
 * string and never a float.
 */
export const moneySchema = z.object({
  amountCents: z.number().int(),
  currency: z.string().length(3),
});

export type MoneyDto = z.infer<typeof moneySchema>;

/**
 * The client-generated idempotency key.
 *
 * A random UUID rather than a hash of the request: identity-based deduplication
 * would merge genuinely distinct attempts, and would let anyone who guessed the
 * tuple retrieve a Stripe Checkout URL.
 */
export const idempotencyKeySchema = z.uuid();

/** Minutes from local midnight. 1440 is legal and means the next midnight. */
export const minuteOfDaySchema = z.number().int().min(0).max(1440);

/**
 * A boolean carried in a query string.
 *
 * Query values are always strings, so the accepted forms are the two literals and
 * nothing else — `?flag`, `?flag=1` and `?flag=yes` are rejected rather than guessed
 * at, because a flag that silently reads as `false` is worse than one that 400s.
 */
export const booleanQuery = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

/** A database-backed integer range, shared by settings and catalog contracts. */
export const boundedInt = (bounds: { min: number; max: number }) =>
  z.number().int().min(bounds.min).max(bounds.max);

/** A customer-facing locale. Lowercase, because it appears in URLs and paths. */
export const localeSchema = z.enum(['de', 'en']);
export type Locale = z.infer<typeof localeSchema>;
