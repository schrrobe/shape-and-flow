import { z } from 'zod';

import { bookingStatusSchema, displayStatusSchema } from '../enums.js';
import { cuidSchema, isoInstantSchema, localDateSchema, moneySchema } from '../primitives.js';

/**
 * The customer's own view of one booking, reached with a management token.
 *
 * Nothing here identifies anything but the booking itself. No organization id, no
 * customer id, no employee id, no Stripe identifier: a management link travels by
 * email and ends up in browser history, so what it can reveal has to be worth
 * revealing to whoever finds it.
 *
 * Note what is absent for a different reason: no route under `/manage` accepts a
 * booking id. The token *is* the selector, which is what makes a valid token unable
 * to be aimed at somebody else's appointment.
 */

/**
 * What cancelling now would cost, so the interface can say it before the customer acts.
 *
 * `freeUntil` is the instant the free window closes. Past it a fee may be retained,
 * and `suggestedRetained` is what the business would propose — a suggestion, because
 * the office decides the final amount when it approves the request.
 */
export const cancellationPolicySchema = z.object({
  feePolicy: z.enum(['NONE', 'FIXED_AMOUNT', 'PERCENTAGE']),
  freeUntil: isoInstantSchema,
  /** True when cancelling at this moment would fall inside the fee window. */
  feeApplies: z.boolean(),
  suggestedRetained: moneySchema,
  suggestedRefund: moneySchema,
  /** False once the appointment has started: cancelling is no longer possible. */
  cancellable: z.boolean(),
});

export const manageBookingResponseSchema = z.object({
  reference: z.string(),
  status: bookingStatusSchema,
  displayStatus: displayStatusSchema,
  startsAt: isoInstantSchema,
  endsAt: isoInstantSchema,
  timezone: z.string(),
  serviceName: z.string(),
  durationMinutes: z.number().int(),
  employeeDisplayName: z.string(),
  price: moneySchema,
  /** What has actually been received, which is zero for an unpaid manual booking. */
  paid: moneySchema,
  refunded: moneySchema,
  customerNote: z.string().nullable(),
  cancellationPolicy: cancellationPolicySchema,
});

export type ManageBookingResponse = z.infer<typeof manageBookingResponseSchema>;

/**
 * Query for `GET /manage/availability`.
 *
 * No `serviceId`: the service is the one the booking already has. Offering a choice
 * would let a reschedule change what was bought.
 */
export const manageAvailabilityQuerySchema = z.object({
  from: localDateSchema,
  to: localDateSchema,
});

export const manageCancelRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const manageCancelResponseSchema = z.object({
  outcome: z.enum(['CANCELED', 'REQUESTED']),
  /** Present when the cancellation took effect immediately. */
  refundExpected: moneySchema.nullable(),
  /** Present when a request was opened for the office to decide. */
  suggestedRetained: moneySchema.nullable(),
});

export type ManageCancelResponse = z.infer<typeof manageCancelResponseSchema>;

export const manageRescheduleRequestSchema = z.object({
  requestedStartsAt: isoInstantSchema,
  /** Absent keeps the current employee. */
  requestedEmployeeId: cuidSchema.optional(),
  reason: z.string().trim().max(500).optional(),
});

export const manageRescheduleResponseSchema = z.object({
  requestId: cuidSchema,
  requestedStartsAt: isoInstantSchema,
});

export type ManageRescheduleResponse = z.infer<typeof manageRescheduleResponseSchema>;
