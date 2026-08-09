import {
  auditActionSchema,
  availabilityExceptionKindSchema,
  bookingOriginSchema,
  bookingStatusSchema,
  cancellationFeePolicySchema,
  entityTypeSchema,
  localeSchema,
  manualPaymentMethodSchema,
  notificationChannelSchema,
  notificationKindSchema,
  notificationStatusSchema,
  officeUserRoleSchema,
  paymentStatusSchema,
  refundReasonSchema,
  refundStatusSchema,
  requestDecisionSchema,
  timeOffStatusSchema,
  weekdaySchema,
} from '@shape-and-flow/booking-contracts';
import { describe, expect, it } from 'vitest';

import {
  AuditAction,
  AvailabilityExceptionKind,
  BookingOrigin,
  BookingStatus,
  CancellationFeePolicy,
  EntityType,
  Locale,
  ManualPaymentMethod,
  NotificationChannel,
  NotificationKind,
  NotificationStatus,
  OfficeUserRole,
  PaymentStatus,
  RefundReason,
  RefundStatus,
  RequestDecision,
  TimeOffStatus,
  Weekday,
} from './client.js';

/**
 * The contracts package declares its enums as Zod schemas rather than importing
 * them from Prisma, because it has to be importable from the browser. That
 * duplication is only safe if something notices when the two diverge.
 *
 * This is that something. A member added to the schema but not the contract — or
 * the reverse — fails here, naming the enum, instead of surfacing as a runtime
 * validation error on a value the database can legitimately produce.
 */
const PAIRS = [
  ['BookingStatus', BookingStatus, bookingStatusSchema.options],
  ['BookingOrigin', BookingOrigin, bookingOriginSchema.options],
  ['CancellationFeePolicy', CancellationFeePolicy, cancellationFeePolicySchema.options],
  ['Locale', Locale, localeSchema.options],
  ['OfficeUserRole', OfficeUserRole, officeUserRoleSchema.options],
  ['Weekday', Weekday, weekdaySchema.options],
  ['AvailabilityExceptionKind', AvailabilityExceptionKind, availabilityExceptionKindSchema.options],
  ['TimeOffStatus', TimeOffStatus, timeOffStatusSchema.options],
  ['PaymentStatus', PaymentStatus, paymentStatusSchema.options],
  ['ManualPaymentMethod', ManualPaymentMethod, manualPaymentMethodSchema.options],
  ['RefundStatus', RefundStatus, refundStatusSchema.options],
  ['RefundReason', RefundReason, refundReasonSchema.options],
  ['RequestDecision', RequestDecision, requestDecisionSchema.options],
  ['AuditAction', AuditAction, auditActionSchema.options],
  ['EntityType', EntityType, entityTypeSchema.options],
  ['NotificationKind', NotificationKind, notificationKindSchema.options],
  ['NotificationChannel', NotificationChannel, notificationChannelSchema.options],
  ['NotificationStatus', NotificationStatus, notificationStatusSchema.options],
] as const;

describe('contract enums match the Prisma schema', () => {
  it.each(PAIRS)('%s has identical members', (_name, prismaEnum, contractOptions) => {
    expect([...contractOptions].sort()).toEqual(Object.values(prismaEnum).sort());
  });

  it('is not vacuous', () => {
    for (const [name, , options] of PAIRS) {
      expect(options.length, name).toBeGreaterThan(1);
    }
  });
});
