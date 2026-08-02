import { SetMetadata } from '@nestjs/common';

/** Metadata key the interceptor reads. */
export const IDEMPOTENCY_SCOPE = 'idempotency:scope';

/**
 * The operations a key can be minted for.
 *
 * A closed set rather than free text, because the scope is half of what decides
 * whether a stored response may be replayed: a key minted for a booking must never
 * replay a refund. A typo in a string would silently create a scope of one.
 */
export type IdempotencyScope = 'booking.create' | 'refund.create' | 'manual-payment.create';

/**
 * Require and honour an `Idempotency-Key` header on this route.
 *
 * The header is mandatory on a decorated route: a mutation that moves money or
 * creates a booking has no safe behaviour when retried without one, so a missing
 * key is a 400 rather than a silent pass-through.
 *
 * **The key is a credential.** For `POST /public/bookings` it is the only thing that
 * will return the Stripe Checkout URL again, so whoever holds it can reach the
 * payment page for that booking. It must never be logged: `req.headers`
 * `idempotency-key` and any `idempotencyKey` field are in REDACT_PATHS, and
 * redaction.spec.ts fails if that stops being true.
 */
export const Idempotent = (scope: IdempotencyScope): MethodDecorator =>
  SetMetadata(IDEMPOTENCY_SCOPE, scope);
