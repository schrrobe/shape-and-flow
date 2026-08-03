import { z } from 'zod';

/**
 * Primitives every request and response schema is built from.
 *
 * This package depends on nothing but Zod, deliberately: it has to be importable
 * from the Node API and from the browser bundle, so it can never reach for Prisma,
 * Nest or anything Node-only.
 */

/** A cuid, as generated for every primary key. Opaque to clients. */
// Prisma still generates CUID v1; accepting CUID2 here would make the wire contract
// disagree with every persisted identifier.
// eslint-disable-next-line @typescript-eslint/no-deprecated
export const cuidSchema = z.cuid();

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
  currency: z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 currency code'),
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

/** A customer-facing locale. Lowercase, because it appears in URLs and paths. */
export const localeSchema = z.enum(['de', 'en']);
export type Locale = z.infer<typeof localeSchema>;
