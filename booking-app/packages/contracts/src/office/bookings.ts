import { z } from 'zod';

import {
  bookingOriginSchema,
  bookingStatusSchema,
  displayStatusSchema,
  manualPaymentMethodSchema,
  notificationChannelSchema,
  notificationKindSchema,
  notificationStatusSchema,
  paymentStatusSchema,
  refundReasonSchema,
  refundStatusSchema,
  requestDecisionSchema,
} from '../enums.js';
import { cursorPageSchema, cursorQuerySchema } from '../pagination.js';
import {
  cuidSchema,
  isoInstantSchema,
  localDateSchema,
  localeSchema,
  moneySchema,
} from '../primitives.js';

/**
 * The office's write surface over bookings and money.
 *
 * Two shapes recur and are worth naming up front. **Sorting is a closed set**, not a
 * column name — a free-text sort key is an invitation to order by a column that has no
 * index, or one that was never meant to leave the database. And **every amount is
 * integer cents with its currency**, never a formatted string, because the CSV export
 * and the UI need to agree about a number a bookkeeper will reconcile.
 */

/* ── listing ──────────────────────────────────────────────────────────────────── */

/**
 * The orders a list may be asked for.
 *
 * Closed rather than `field:direction` parsed at runtime: the plan's own test asks that
 * `priceCentsSnapshot:desc` be a 400, and the only way to make that reliably true is for
 * the permitted set to be the type.
 */
export const bookingSortSchema = z.enum([
  'startsAt:asc',
  'startsAt:desc',
  'createdAt:asc',
  'createdAt:desc',
]);

export type BookingSort = z.infer<typeof bookingSortSchema>;

export const officeBookingListQuerySchema = cursorQuerySchema.extend({
  /**
   * Repeatable. A single `?status=CONFIRMED` arrives as a string and a repeated one as
   * an array, so both are accepted and normalised — a client should not have to know
   * which it sent.
   */
  status: z
    .union([bookingStatusSchema, z.array(bookingStatusSchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  employeeId: cuidSchema.optional(),
  serviceId: cuidSchema.optional(),
  customerId: cuidSchema.optional(),
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
  /** Free text over the reference, the customer's last name and their email. */
  q: z.string().trim().min(1).max(120).optional(),
  sort: bookingSortSchema.default('startsAt:desc'),
});

export type OfficeBookingListQuery = z.infer<typeof officeBookingListQuerySchema>;

/** A row in the office list. Deliberately not the detail: no notes, no payments. */
export const officeBookingListItemSchema = z.object({
  id: cuidSchema,
  reference: z.string(),
  status: bookingStatusSchema,
  displayStatus: displayStatusSchema,
  origin: bookingOriginSchema,
  startsAt: isoInstantSchema,
  endsAt: isoInstantSchema,
  employeeId: cuidSchema,
  employeeName: z.string(),
  serviceName: z.string(),
  customerId: cuidSchema,
  customerName: z.string(),
  price: moneySchema,
  /** Card plus cash received against this booking, so "unpaid" is visible in a list. */
  paid: moneySchema,
  createdAt: isoInstantSchema,
});

export type OfficeBookingListItem = z.infer<typeof officeBookingListItemSchema>;

export const officeBookingListResponseSchema = cursorPageSchema(officeBookingListItemSchema);
export type OfficeBookingListResponse = z.infer<typeof officeBookingListResponseSchema>;

/* ── detail ───────────────────────────────────────────────────────────────────── */

export const bookingPaymentSchema = z.object({
  id: cuidSchema,
  amount: moneySchema,
  status: paymentStatusSchema,
  paymentMethodType: z.string().nullable(),
  refundedAmountCents: z.number().int(),
  paidAt: isoInstantSchema.nullable(),
});

export const bookingManualPaymentSchema = z.object({
  id: cuidSchema,
  amount: moneySchema,
  method: manualPaymentMethodSchema,
  paidAt: isoInstantSchema,
  recordedByOfficeUserId: cuidSchema,
  note: z.string().nullable(),
});

export const bookingRefundSchema = z.object({
  id: cuidSchema,
  amount: moneySchema,
  status: refundStatusSchema,
  reason: refundReasonSchema,
  issuedByOfficeUserId: cuidSchema.nullable(),
  failureReason: z.string().nullable(),
  requestedAt: isoInstantSchema,
  settledAt: isoInstantSchema.nullable(),
});

export const bookingStatusHistorySchema = z.object({
  id: cuidSchema,
  fromStatus: bookingStatusSchema.nullable(),
  toStatus: bookingStatusSchema,
  actorType: z.string(),
  actorOfficeUserId: cuidSchema.nullable(),
  reason: z.string().nullable(),
  createdAt: isoInstantSchema,
});

export const bookingNotificationSchema = z.object({
  id: cuidSchema,
  kind: notificationKindSchema,
  channel: notificationChannelSchema,
  status: notificationStatusSchema,
  sentAt: isoInstantSchema.nullable(),
  failureReason: z.string().nullable(),
});

export type BookingPayment = z.infer<typeof bookingPaymentSchema>;
export type BookingManualPayment = z.infer<typeof bookingManualPaymentSchema>;
export type BookingRefund = z.infer<typeof bookingRefundSchema>;

export const openCancellationRequestSchema = z.object({
  id: cuidSchema,
  reason: z.string().nullable(),
  requestedAt: isoInstantSchema,
  suggestedRetainedAmountCents: z.number().int(),
});

export const openRescheduleRequestSchema = z.object({
  id: cuidSchema,
  requestedStartsAt: isoInstantSchema,
  requestedEmployeeId: cuidSchema.nullable(),
  reason: z.string().nullable(),
  requestedAt: isoInstantSchema,
});

/**
 * Everything about one booking, in one read.
 *
 * A single response rather than seven endpoints, because the office detail screen shows
 * all of it at once and a screen assembled from seven calls is a screen that renders in
 * seven stages.
 */
export const officeBookingDetailSchema = officeBookingListItemSchema.extend({
  serviceId: cuidSchema,
  blockStartsAt: isoInstantSchema,
  blockEndsAt: isoInstantSchema,
  durationMinutes: z.number().int(),
  prepBufferMinutes: z.number().int(),
  cleanupBufferMinutes: z.number().int(),
  locale: localeSchema,
  customerNote: z.string().nullable(),
  confirmedAt: isoInstantSchema.nullable(),
  canceledAt: isoInstantSchema.nullable(),
  completedAt: isoInstantSchema.nullable(),
  expiresAt: isoInstantSchema.nullable(),
  createdByOfficeUserId: cuidSchema.nullable(),
  canceledByOfficeUserId: cuidSchema.nullable(),
  cancellationReason: z.string().nullable(),
  customer: z.object({
    id: cuidSchema,
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    phone: z.string().nullable(),
  }),
  payments: z.array(bookingPaymentSchema),
  manualPayments: z.array(bookingManualPaymentSchema),
  refunds: z.array(bookingRefundSchema),
  statusHistory: z.array(bookingStatusHistorySchema),
  notifications: z.array(bookingNotificationSchema),
  openCancellationRequest: openCancellationRequestSchema.nullable(),
  openRescheduleRequest: openRescheduleRequestSchema.nullable(),
});

export type OfficeBookingDetail = z.infer<typeof officeBookingDetailSchema>;

/* ── manual booking ───────────────────────────────────────────────────────────── */

/** A customer the office types, or one it already has. */
export const manualBookingCustomerSchema = z.union([
  z.object({ customerId: cuidSchema }),
  z.object({
    email: z.email().max(320),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    phone: z.string().trim().max(50).optional(),
    locale: localeSchema.optional(),
  }),
]);

/**
 * `POST /office/bookings`.
 *
 * `employeeId` is required, unlike the public route's optional one. "Any available
 * employee" is a convenience for a customer choosing from a screen; an office taking a
 * booking on the phone already knows who is doing it, and letting the server pick would
 * make the answer depend on a load-balancing rule nobody in the room can see.
 *
 * §6.5 lists a separate office `note`, which this deliberately does not have. There is
 * no column for one — `Booking` carries `customerNote` and nothing else — and the note
 * an office types while a customer talks on the phone *is* the customer's note. Adding a
 * column would be a schema change this task explicitly excludes, and a second free-text
 * field on the same row would mostly collect the same sentence written twice. A note
 * about the *person* rather than the appointment goes on the customer's `internalNote`,
 * which does exist.
 */
export const createManualBookingSchema = z.object({
  serviceId: cuidSchema,
  employeeId: cuidSchema,
  startsAt: isoInstantSchema,
  customer: manualBookingCustomerSchema,
  customerNote: z.string().trim().max(2000).optional(),
});

export type CreateManualBookingRequest = z.infer<typeof createManualBookingSchema>;

export const createManualBookingResponseSchema = z.object({
  bookingId: cuidSchema,
  reference: z.string(),
  status: bookingStatusSchema,
  startsAt: isoInstantSchema,
  endsAt: isoInstantSchema,
  employeeId: cuidSchema,
  price: moneySchema,
});

export type CreateManualBookingResponse = z.infer<typeof createManualBookingResponseSchema>;

/* ── money ────────────────────────────────────────────────────────────────────── */

/**
 * Recording money that did not come through Stripe.
 *
 * A **negative amount requires a note**, and zero is never allowed. Negative is how a
 * mis-keyed cash payment is corrected, and a correction with no explanation is
 * indistinguishable from a mistake when somebody reads the ledger a quarter later. Zero
 * records nothing and is refused rather than stored.
 */
export const createManualPaymentSchema = z
  .object({
    amountCents: z
      .number()
      .int()
      .min(-10_000_000)
      .max(10_000_000)
      .refine((value) => value !== 0, {
        message: 'a payment of zero records nothing',
      }),
    method: manualPaymentMethodSchema,
    /** Absent means now, which is what recording a payment at the desk means. */
    paidAt: isoInstantSchema.optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .refine((body) => body.amountCents > 0 || body.note !== undefined, {
    message: 'a negative correction needs a note explaining it',
    path: ['note'],
  });

export type CreateManualPaymentRequest = z.infer<typeof createManualPaymentSchema>;

export const createRefundSchema = z.object({
  amountCents: z.number().int().min(1).max(10_000_000),
  reason: refundReasonSchema,
  note: z.string().trim().max(500).optional(),
});

export type CreateRefundRequest = z.infer<typeof createRefundSchema>;

export const refundListResponseSchema = z.object({ items: z.array(bookingRefundSchema) });
export type RefundListResponse = z.infer<typeof refundListResponseSchema>;

/* ── status changes ───────────────────────────────────────────────────────────── */

/**
 * The business cancelling a booking.
 *
 * `refund` absent and `refund: { amountCents: 0 }` are different requests: one says
 * nothing about money, the other says the decision was to return nothing. Keeping them
 * distinct is what lets an audit row answer "did anybody consider a refund".
 */
export const cancelBookingSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  refund: z.object({ amountCents: z.number().int().min(0).max(10_000_000) }).optional(),
});

export type CancelBookingRequest = z.infer<typeof cancelBookingSchema>;

/* ── requests ─────────────────────────────────────────────────────────────────── */

export const requestListQuerySchema = z.object({
  decision: requestDecisionSchema.default('PENDING'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type RequestListQuery = z.infer<typeof requestListQuerySchema>;

/** Enough of the booking to decide without opening it. */
const requestBookingSchema = z.object({
  id: cuidSchema,
  reference: z.string(),
  startsAt: isoInstantSchema,
  employeeId: cuidSchema,
  serviceName: z.string(),
  customerName: z.string(),
  price: moneySchema,
  paid: moneySchema,
});

export const officeCancellationRequestSchema = z.object({
  id: cuidSchema,
  booking: requestBookingSchema,
  reason: z.string().nullable(),
  requestedAt: isoInstantSchema,
  decision: requestDecisionSchema,
  /** Frozen at request time, so a later policy change cannot move it. */
  suggestedRetainedAmountCents: z.number().int(),
  retainedAmountCents: z.number().int().nullable(),
  decidedAt: isoInstantSchema.nullable(),
  decisionNote: z.string().nullable(),
});

export type OfficeCancellationRequest = z.infer<typeof officeCancellationRequestSchema>;

export const cancellationRequestListResponseSchema = z.object({
  items: z.array(officeCancellationRequestSchema),
});

export type CancellationRequestListResponse = z.infer<typeof cancellationRequestListResponseSchema>;

export const officeRescheduleRequestSchema = z.object({
  id: cuidSchema,
  booking: requestBookingSchema,
  requestedStartsAt: isoInstantSchema,
  requestedEmployeeId: cuidSchema.nullable(),
  reason: z.string().nullable(),
  requestedAt: isoInstantSchema,
  decision: requestDecisionSchema,
  decidedAt: isoInstantSchema.nullable(),
  decisionNote: z.string().nullable(),
  resultingBookingId: cuidSchema.nullable(),
});

export type OfficeRescheduleRequest = z.infer<typeof officeRescheduleRequestSchema>;

export const rescheduleRequestListResponseSchema = z.object({
  items: z.array(officeRescheduleRequestSchema),
});

export type RescheduleRequestListResponse = z.infer<typeof rescheduleRequestListResponseSchema>;

export const decideCancellationSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  /** Absent on approval falls back to the frozen suggestion. */
  retainedAmountCents: z.number().int().min(0).max(10_000_000).optional(),
  note: z.string().trim().max(500).optional(),
});

export type DecideCancellationRequest = z.infer<typeof decideCancellationSchema>;

export const decideRescheduleSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  note: z.string().trim().max(500).optional(),
});

export type DecideRescheduleRequest = z.infer<typeof decideRescheduleSchema>;

/* ── exports ──────────────────────────────────────────────────────────────────── */

export const exportQuerySchema = z.object({
  from: localDateSchema,
  to: localDateSchema,
  status: z
    .union([bookingStatusSchema, z.array(bookingStatusSchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  /**
   * Off by default.
   *
   * The customer's note is free text they wrote about themselves, and a spreadsheet
   * mailed to a bookkeeper is not where it belongs unless somebody decided it does.
   */
  includeCustomerNote: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type ExportQuery = z.infer<typeof exportQuerySchema>;
