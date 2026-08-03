import { beforeEach, describe, expect, it } from 'vitest';

import {
  AttendanceService,
  STALE_COMPLETION_AFTER_MS,
} from '../../src/booking/attendance.service.js';
import { CancellationService } from '../../src/booking/cancellation.service.js';
import { ReservationService } from '../../src/booking/reservation.service.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, makeBooking, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';

import type { ReserveInput } from '../../src/booking/reservation.service.js';
import type { BookingStatus } from '../../src/prisma/client.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';

/**
 * "Now" is set *after* the seeded Friday appointment, so the appointment is in the past
 * and completion is legitimate. Individual tests move the clock to test the guards.
 */
const AFTER_APPOINTMENT = new Date(SLOT_FRIDAY_0900.getTime() + 2 * 60 * 60_000);

/** Before the appointment, for the guards that must refuse. */
const BEFORE_APPOINTMENT = new Date('2026-08-10T06:00:00.000Z');

let ctx: SeedContext;
let clock: FixedClock;
let testApp: BookingTestApp;
let service: AttendanceService;
let cancellations: CancellationService;
let reservations: ReservationService;
let bookingId: string;

async function confirmedBooking(
  overrides: Parameters<typeof makeBooking>[1] = {},
  options: { paid?: boolean } = {},
): Promise<string> {
  const booking = await prisma.booking.create({
    data: {
      ...makeBooking(ctx, { status: 'CONFIRMED', expiresAt: null, ...overrides }),
      confirmedAt: BEFORE_APPOINTMENT,
    },
  });

  if (options.paid !== false) {
    await prisma.payment.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        stripeCheckoutSessionId: `cs_test_${booking.id}`,
        amountCents: booking.priceCentsSnapshot,
        currency: booking.currency,
        status: 'SUCCEEDED',
        paidAt: BEFORE_APPOINTMENT,
      },
    });
  }

  return booking.id;
}

function sameSlot(): ReserveInput {
  return {
    serviceId: ctx.service30.id,
    employeeId: ctx.employee1.id,
    startsAt: SLOT_FRIDAY_0900,
    customer: { email: 'bea@example.com', firstName: 'Bea', lastName: 'Kraus', locale: 'de' },
    locale: 'de',
  };
}

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);
  clock = new FixedClock(AFTER_APPOINTMENT);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock,
  });

  service = testApp.app.get(AttendanceService);
  cancellations = testApp.app.get(CancellationService);
  reservations = testApp.app.get(ReservationService);

  bookingId = await confirmedBooking();

  return testApp.close;
});

describe('completing an appointment', () => {
  it('marks it COMPLETED and stamps the time', async () => {
    await service.complete(bookingId, ctx.owner.id);

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(after.status).toBe('COMPLETED');
    expect(after.completedAt).toEqual(AFTER_APPOINTMENT);
  });

  it('audits it, naming the actor', async () => {
    await service.complete(bookingId, ctx.owner.id);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'BOOKING_MARKED_COMPLETED', entityId: bookingId },
    });
    expect(audit.officeUserId).toBe(ctx.owner.id);
    expect(audit.before).toMatchObject({ status: 'CONFIRMED' });
    expect(audit.after).toMatchObject({ status: 'COMPLETED' });
  });

  it('writes a history row', async () => {
    await service.complete(bookingId, ctx.owner.id);

    const history = await prisma.bookingStatusHistory.findMany({
      where: { bookingId, toStatus: 'COMPLETED' },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: 'CONFIRMED',
      actorType: 'OFFICE',
      actorOfficeUserId: ctx.owner.id,
    });
  });

  it('refuses an appointment that has not finished', async () => {
    // Mid-appointment: started, but not over.
    clock.set(new Date(SLOT_FRIDAY_0900.getTime() + 10 * 60_000));

    await expect(service.complete(bookingId, ctx.owner.id)).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
      details: { reason: 'TIME_GUARD' },
    });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(
      'CONFIRMED',
    );
  });

  it('refuses an appointment that has not started', async () => {
    clock.set(BEFORE_APPOINTMENT);

    await expect(service.complete(bookingId, ctx.owner.id)).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
    });
  });
});

describe('marking a no-show', () => {
  it('marks NO_SHOW once the appointment has started', async () => {
    // Knowable as soon as the appointment begins and nobody is there.
    clock.set(new Date(SLOT_FRIDAY_0900.getTime() + 60_000));

    await service.markNoShow(bookingId, ctx.owner.id);

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(
      'NO_SHOW',
    );
  });

  it('refuses before the appointment starts', async () => {
    clock.set(BEFORE_APPOINTMENT);

    await expect(service.markNoShow(bookingId, ctx.owner.id)).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
      details: { reason: 'TIME_GUARD' },
    });
  });

  it('audits it', async () => {
    await service.markNoShow(bookingId, ctx.owner.id);

    expect(
      await prisma.auditLog.count({
        where: { action: 'BOOKING_MARKED_NO_SHOW', entityId: bookingId },
      }),
    ).toBe(1);
  });

  it('does not free the slot, because the time was consumed', async () => {
    await service.markNoShow(bookingId, ctx.owner.id);

    // The employee was there whether or not the customer was. The past is not bookable
    // either, which is the answer the reservation path gives.
    await expect(reservations.reserve(sameSlot())).rejects.toMatchObject({
      code: 'OUTSIDE_BOOKING_WINDOW',
    });
  });

  it('leaves completedAt null, since nothing was completed', async () => {
    await service.markNoShow(bookingId, ctx.owner.id);

    expect(
      (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).completedAt,
    ).toBeNull();
  });
});

describe('bookings that are already settled', () => {
  const settled: BookingStatus[] = [
    'COMPLETED',
    'NO_SHOW',
    'CANCELED_BY_CUSTOMER',
    'CANCELED_BY_BUSINESS',
    'EXPIRED',
  ];

  it.each(settled)('refuses to complete a %s booking', async (status) => {
    await prisma.booking.update({ where: { id: bookingId }, data: { status } });

    await expect(service.complete(bookingId, ctx.owner.id)).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
    });
  });

  it.each(settled)('refuses to mark a %s booking as no-show', async (status) => {
    await prisma.booking.update({ where: { id: bookingId }, data: { status } });

    await expect(service.markNoShow(bookingId, ctx.owner.id)).rejects.toMatchObject({
      code: 'INVALID_STATUS_TRANSITION',
    });
  });

  it('distinguishes a status refusal from a time refusal', async () => {
    await prisma.booking.update({ where: { id: bookingId }, data: { status: 'COMPLETED' } });

    // The status table refused, not the clock — the office needs to know which.
    await expect(service.complete(bookingId, ctx.owner.id)).rejects.toMatchObject({
      details: { from: 'COMPLETED', to: 'COMPLETED' },
    });
  });

  it('refuses a booking that does not exist', async () => {
    await expect(service.complete('cms9gryv30000ja32145w5gke', ctx.owner.id)).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });
});

describe('business cancellation', () => {
  it('records the reason and the actor, refunds, and audits', async () => {
    // Reuses the path built in Task 6.2; these are the cases specific to closing out.
    clock.set(BEFORE_APPOINTMENT);

    const { refundId } = await cancellations.cancelByBusiness({
      bookingId,
      officeUserId: ctx.owner.id,
      reason: 'Krankheit',
      mayIssueRefunds: true,
      refundAmountCents: ctx.service30.priceCents,
    });

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(after).toMatchObject({
      status: 'CANCELED_BY_BUSINESS',
      cancellationReason: 'Krankheit',
      canceledByOfficeUserId: ctx.owner.id,
    });

    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId ?? '' } });
    expect(refund).toMatchObject({
      issuedByOfficeUserId: ctx.owner.id,
      reason: 'BUSINESS_CANCELLATION',
      amountCents: ctx.service30.priceCents,
    });

    expect(
      await prisma.auditLog.count({ where: { action: 'BOOKING_CANCELED', entityId: bookingId } }),
    ).toBe(1);
  });

  it('cancels without a refund when none is asked for', async () => {
    clock.set(BEFORE_APPOINTMENT);

    const { refundId } = await cancellations.cancelByBusiness({
      bookingId,
      officeUserId: ctx.owner.id,
      reason: 'Umbau',
      mayIssueRefunds: true,
    });

    // Absent and zero are different: one is a decision not to refund.
    expect(refundId).toBeNull();
    expect(await prisma.refund.count({ where: { bookingId } })).toBe(0);
  });

  it('cancels a past appointment, unlike the customer path', async () => {
    // Correcting a mistaken entry is a real thing an office needs to do.
    await expect(
      cancellations.cancelByBusiness({
        bookingId,
        officeUserId: ctx.owner.id,
        reason: 'Fehleintrag',
        mayIssueRefunds: true,
      }),
    ).resolves.toBeDefined();
  });

  it('closes an open cancellation request rather than orphaning it', async () => {
    clock.set(BEFORE_APPOINTMENT);

    await prisma.organizationSettings.updateMany({
      data: { cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 50 },
    });

    // A request opened inside the fee window, then overtaken by the business cancelling.
    await prisma.cancellationRequest.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId,
        suggestedRetainedAmountCents: ctx.service30.priceCents / 2,
      },
    });

    await cancellations.cancelByBusiness({
      bookingId,
      officeUserId: ctx.owner.id,
      reason: 'Kulanz',
      mayIssueRefunds: true,
      refundAmountCents: ctx.service30.priceCents,
    });

    const req = await prisma.cancellationRequest.findFirstOrThrow({ where: { bookingId } });

    // APPROVED: the customer asked for the booking to go, and it is gone.
    expect(req).toMatchObject({
      decision: 'APPROVED',
      decisionNote: 'closed by business cancellation',
      decidedByOfficeUserId: ctx.owner.id,
    });
  });

  it('closes an open reschedule request as rejected', async () => {
    clock.set(BEFORE_APPOINTMENT);

    await prisma.rescheduleRequest.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId,
        requestedStartsAt: new Date(SLOT_FRIDAY_0900.getTime() + 3 * 60 * 60_000),
      },
    });

    await cancellations.cancelByBusiness({
      bookingId,
      officeUserId: ctx.owner.id,
      reason: 'Umbau',
      mayIssueRefunds: true,
    });

    // REJECTED: the appointment they wanted to move no longer exists.
    expect(
      (await prisma.rescheduleRequest.findFirstOrThrow({ where: { bookingId } })).decision,
    ).toBe('REJECTED');
  });

  it('refuses a booking that is already settled', async () => {
    await service.complete(bookingId, ctx.owner.id);

    await expect(
      cancellations.cancelByBusiness({
        bookingId,
        officeUserId: ctx.owner.id,
        reason: 'zu spät',
        mayIssueRefunds: true,
      }),
    ).rejects.toMatchObject({ code: 'BOOKING_NOT_CANCELLABLE' });
  });
});

describe('the stale-completion report', () => {
  it('counts appointments nobody has closed out', async () => {
    clock.set(new Date(SLOT_FRIDAY_0900.getTime() + STALE_COMPLETION_AFTER_MS + 60 * 60_000));

    expect(await service.reportStaleCompletions()).toEqual({ count: 1 });
  });

  it('ignores one that only just finished', async () => {
    // A business closed over a weekend should not be nagged.
    expect(await service.reportStaleCompletions()).toEqual({ count: 0 });
  });

  it('ignores one that has been marked', async () => {
    await service.complete(bookingId, ctx.owner.id);
    clock.set(new Date(SLOT_FRIDAY_0900.getTime() + STALE_COMPLETION_AFTER_MS + 60 * 60_000));

    expect(await service.reportStaleCompletions()).toEqual({ count: 0 });
  });

  it('does not complete anything itself', async () => {
    clock.set(new Date(SLOT_FRIDAY_0900.getTime() + STALE_COMPLETION_AFTER_MS + 60 * 60_000));

    await service.reportStaleCompletions();

    // Auto-completing would manufacture the observation this service exists to record.
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(
      'CONFIRMED',
    );
  });
});
