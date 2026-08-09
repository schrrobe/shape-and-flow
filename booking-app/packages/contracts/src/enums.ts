import { z } from 'zod';

/**
 * Enums the API exposes.
 *
 * Declared here rather than imported from Prisma, because this package must be
 * importable from the browser. That duplication is guarded: the API has a test
 * asserting these lists equal the generated Prisma enums exactly, so the two
 * cannot drift.
 */

export const bookingStatusSchema = z.enum([
  'PENDING_PAYMENT',
  'EXPIRING',
  'EXPIRED',
  'CONFIRMED',
  'PAYMENT_FAILED',
  'CANCELED_BY_CUSTOMER',
  'CANCELED_BY_BUSINESS',
  'COMPLETED',
  'NO_SHOW',
]);

export type BookingStatus = z.infer<typeof bookingStatusSchema>;

/**
 * What the office UI renders.
 *
 * CANCELLATION_REQUESTED and RESCHEDULE_REQUESTED are **not** persisted booking
 * statuses. They are derived from the presence of an open request while the
 * booking itself stays CONFIRMED — which is what keeps the slot blocking while
 * the office decides, and what lets the two conditions coexist.
 */
export const displayStatusSchema = z.enum([
  ...bookingStatusSchema.options,
  'CANCELLATION_REQUESTED',
  'RESCHEDULE_REQUESTED',
]);

export type DisplayStatus = z.infer<typeof displayStatusSchema>;

export const bookingOriginSchema = z.enum(['ONLINE', 'OFFICE']);
export type BookingOrigin = z.infer<typeof bookingOriginSchema>;

export const cancellationFeePolicySchema = z.enum(['NONE', 'FIXED_AMOUNT', 'PERCENTAGE']);
export type CancellationFeePolicy = z.infer<typeof cancellationFeePolicySchema>;

export const officeUserRoleSchema = z.enum(['OWNER', 'ADMIN', 'EMPLOYEE']);
export type OfficeUserRole = z.infer<typeof officeUserRoleSchema>;

export const weekdaySchema = z.enum([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
]);

export type Weekday = z.infer<typeof weekdaySchema>;

/**
 * A one-off override of an employee's recurring hours.
 *
 * `EXTRA_HOURS` *replaces* the weekday's hours rather than adding to them — an office
 * setting special Saturday hours means "these hours", not "these plus the usual" — and
 * `CLOSED` empties the day. The two carry different fields, which is why the request
 * schema is a discriminated union rather than one object with nullable minutes.
 */
export const availabilityExceptionKindSchema = z.enum(['EXTRA_HOURS', 'CLOSED']);
export type AvailabilityExceptionKind = z.infer<typeof availabilityExceptionKindSchema>;

/**
 * Where a leave request stands.
 *
 * Only `APPROVED` removes the days from availability. `REQUESTED` deliberately does
 * not: a request nobody has decided must not quietly free an employee's calendar.
 */
export const timeOffStatusSchema = z.enum(['REQUESTED', 'APPROVED', 'REJECTED']);
export type TimeOffStatus = z.infer<typeof timeOffStatusSchema>;

/**
 * Where a card payment stands.
 *
 * `PARTIALLY_REFUNDED` and `REFUNDED` still count as money that was received: the
 * refund is a second movement, not an undoing of the first, which is why the ledger
 * export lists both rather than netting them.
 */
export const paymentStatusSchema = z.enum([
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/** How money arrived outside Stripe. `CARD` is the terminal in the studio, not Stripe. */
export const manualPaymentMethodSchema = z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'OTHER']);
export type ManualPaymentMethod = z.infer<typeof manualPaymentMethodSchema>;

export const refundStatusSchema = z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED']);
export type RefundStatus = z.infer<typeof refundStatusSchema>;

/**
 * Why money went back.
 *
 * Recorded rather than derived, because the same amount returned for a customer
 * cancellation and as goodwill are different facts to a bookkeeper.
 */
export const refundReasonSchema = z.enum([
  'CUSTOMER_CANCELLATION',
  'BUSINESS_CANCELLATION',
  'GOODWILL',
  'DUPLICATE_PAYMENT',
]);
export type RefundReason = z.infer<typeof refundReasonSchema>;

export const requestDecisionSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED']);
export type RequestDecision = z.infer<typeof requestDecisionSchema>;

/**
 * Every office action that leaves a permanent trace.
 *
 * In the contracts package because the audit log is filterable by action, and a client
 * offering a filter needs the list. `enum-drift.spec.ts` cross-checks it against Prisma,
 * so a value added on one side and forgotten on the other fails a test rather than
 * silently making a filter option that matches nothing.
 */
export const auditActionSchema = z.enum([
  'BOOKING_CREATED_MANUALLY',
  'BOOKING_CANCELED',
  'BOOKING_RESCHEDULED',
  'BOOKING_MARKED_NO_SHOW',
  'BOOKING_MARKED_COMPLETED',
  'CANCELLATION_REQUEST_DECIDED',
  'RESCHEDULE_REQUEST_DECIDED',
  'MANUAL_PAYMENT_RECORDED',
  'REFUND_ISSUED',
  'SETTINGS_UPDATED',
  'EMPLOYEE_CREATED',
  'EMPLOYEE_UPDATED',
  'EMPLOYEE_ARCHIVED',
  'SERVICE_CREATED',
  'SERVICE_UPDATED',
  'SERVICE_ARCHIVED',
  'OFFICE_USER_CREATED',
  'OFFICE_USER_UPDATED',
  'OFFICE_USER_ARCHIVED',
  'WORKING_HOURS_REPLACED',
  'EMPLOYEE_SERVICES_REPLACED',
  'AVAILABILITY_EXCEPTION_CREATED',
  'AVAILABILITY_EXCEPTION_DELETED',
  'TIME_OFF_CREATED',
  'TIME_OFF_UPDATED',
  'BLOCKED_TIME_CREATED',
  'BLOCKED_TIME_DELETED',
  'CLOSED_DAY_CREATED',
  'CLOSED_DAY_DELETED',
  'SERVICE_CATEGORY_CREATED',
  'SERVICE_CATEGORY_UPDATED',
  'SERVICE_CATEGORY_ARCHIVED',
  'CUSTOMER_UPDATED',
  'CUSTOMER_ERASED',
  'ORGANIZATION_ONBOARDING_LINK_REQUESTED',
  'ORGANIZATION_ACCOUNT_SESSION_CREATED',
  'ORGANIZATION_DOMAIN_ADDED',
  'ORGANIZATION_DOMAIN_REMOVED',
]);
export type AuditAction = z.infer<typeof auditActionSchema>;

/**
 * What a notification is about.
 *
 * Here rather than only in Prisma because the notification-templates package is
 * browser-importable and must not reach for the database client to learn the set of
 * things it has to be able to render. `enum-drift.spec.ts` cross-checks the two.
 */
export const notificationKindSchema = z.enum([
  'BOOKING_CONFIRMATION',
  'BOOKING_CANCELED_BY_CUSTOMER',
  'BOOKING_CANCELED_BY_BUSINESS',
  'BOOKING_RESCHEDULED',
  'REMINDER_24H',
  'CANCELLATION_REQUEST_RECEIVED',
  'CANCELLATION_REQUEST_DECIDED',
  'RESCHEDULE_REQUEST_RECEIVED',
  'RESCHEDULE_REQUEST_DECIDED',
  'REFUND_ISSUED',
  'OFFICE_NEW_BOOKING',
  'OFFICE_CANCELLATION_REQUEST',
  'OFFICE_PASSWORD_RESET',
]);

export type NotificationKind = z.infer<typeof notificationKindSchema>;

export const notificationChannelSchema = z.enum(['EMAIL', 'SMS']);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const notificationStatusSchema = z.enum([
  'PENDING',
  'SENDING',
  'SENT',
  'DELIVERED',
  'FAILED',
]);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;

export const entityTypeSchema = z.enum(['INDIVIDUAL', 'SOLE_PROPRIETORSHIP', 'ORGANIZATION']);
export type EntityType = z.infer<typeof entityTypeSchema>;
