import { z } from 'zod';

import { bookingStatusSchema } from '../enums.js';
import { cuidSchema, isoInstantSchema, localeSchema, moneySchema } from '../primitives.js';

/** Long enough for a real note, short enough that it cannot be used as storage. */
export const CUSTOMER_NOTE_MAX_LENGTH = 500;

export const bookingCustomerSchema = z.object({
  email: z.email(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  /**
   * Loose on purpose. A phone number is for a human to dial, and a strict pattern
   * rejects legitimate international formats far more often than it catches a typo.
   */
  phone: z.string().trim().min(5).max(30).optional(),
});

/**
 * `POST /public/bookings`.
 *
 * `successUrl` and `cancelUrl` are validated as URLs here and checked against the
 * configured origin in the controller — the schema cannot see configuration, and an
 * unchecked redirect target would make an open redirect available through Stripe.
 */
export const createBookingRequestSchema = z.object({
  serviceId: cuidSchema,
  /** `null` asks the server to choose. Absent means the same thing. */
  employeeId: cuidSchema.nullable().optional(),
  startsAt: isoInstantSchema,
  customer: bookingCustomerSchema,
  locale: localeSchema,
  customerNote: z.string().trim().max(CUSTOMER_NOTE_MAX_LENGTH).optional(),
  successUrl: z.url(),
  cancelUrl: z.url(),
});

export type CreateBookingRequest = z.infer<typeof createBookingRequestSchema>;

export const createBookingResponseSchema = z.object({
  bookingId: cuidSchema,
  reference: z.string(),
  status: bookingStatusSchema,
  /** The resolved employee, which the customer may not have chosen. */
  employeeId: cuidSchema,
  employeeDisplayName: z.string(),
  startsAt: isoInstantSchema,
  endsAt: isoInstantSchema,
  price: moneySchema,
  /** When the reservation lapses if payment has not completed. */
  expiresAt: isoInstantSchema,
  /**
   * The hosted payment page.
   *
   * Only ever returned to whoever holds the Idempotency-Key, which is why a replay
   * of the same key returns this same URL: a customer who reloads mid-payment lands
   * back on the session they already started rather than a second one.
   */
  checkoutUrl: z.url(),
});

export type CreateBookingResponse = z.infer<typeof createBookingResponseSchema>;

/**
 * `GET /public/bookings/by-session/:checkoutSessionId`.
 *
 * The post-Checkout landing page polls this. Deliberately thin: it is reachable by
 * anyone holding a session id, so it carries no customer data at all and no
 * management token — the token travels by email.
 */
export const bookingBySessionResponseSchema = z.object({
  reference: z.string(),
  status: bookingStatusSchema,
  startsAt: isoInstantSchema,
  endsAt: isoInstantSchema,
  employeeDisplayName: z.string(),
  serviceName: z.string(),
  price: moneySchema,
  /** Whether the confirmation email's management link has been issued yet. */
  managementUrlIssued: z.boolean(),
});

export type BookingBySessionResponse = z.infer<typeof bookingBySessionResponseSchema>;
