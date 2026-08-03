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
