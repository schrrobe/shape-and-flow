import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { CancellationService } from '../../src/booking/cancellation.service.js';
import { ReservationService } from '../../src/booking/reservation.service.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { ManageModule } from '../../src/manage/manage.module.js';
import { ManagementTokenService } from '../../src/manage/management-token.service.js';
import { JOB } from '../../src/messaging/queues/job-contracts.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, makeBooking, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';

import type { ReserveInput } from '../../src/booking/reservation.service.js';
import type { BookingStatus } from '../../src/prisma/client.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/** Monday. The seeded Friday slot is four days out — comfortably outside 72 hours. */
const NOW = new Date('2026-08-10T06:00:00.000Z');

/** A day before the Friday appointment: inside the 72-hour free-cancellation window. */
const INSIDE_WINDOW = new Date('2026-08-13T06:00:00.000Z');

let ctx: SeedContext;
let clock: FixedClock;
let testApp: BookingTestApp;
let server: () => Server;
let service: CancellationService;
let reservations: ReservationService;
let tokens: ManagementTokenService;

interface Booked {
  id: string;
  reference: string;
}

/** A confirmed booking with a settled payment — what a cancellation acts on. */
async function confirmedPaid(
  overrides: Parameters<typeof makeBooking>[1] = {},
  paidCents = ctx.service30.priceCents,
): Promise<Booked> {
  const booking = await prisma.booking.create({
    data: {
      ...makeBooking(ctx, { status: 'CONFIRMED', expiresAt: null, ...overrides }),
      confirmedAt: NOW,
    },
  });

  await prisma.payment.create({
    data: {
      organizationId: ctx.organization.id,
      bookingId: booking.id,
      stripeCheckoutSessionId: `cs_test_${booking.id}`,
      amountCents: paidCents,
      currency: booking.currency,
      status: 'SUCCEEDED',
      paidAt: NOW,
    },
  });

  return { id: booking.id, reference: booking.reference };
}

/** A confirmed booking with no payment — the manual, pay-on-site case. */
async function confirmedUnpaid(overrides: Parameters<typeof makeBooking>[1] = {}): Promise<Booked> {
  const booking = await prisma.booking.create({
    data: {
      ...makeBooking(ctx, { status: 'CONFIRMED', expiresAt: null, ...overrides }),
      confirmedAt: NOW,
      origin: 'OFFICE',
    },
  });

  return { id: booking.id, reference: booking.reference };
}

/** The slot the seeded booking holds, for proving whether it is free. */
function sameSlot(): ReserveInput {
  return {
    serviceId: ctx.service30.id,
    employeeId: ctx.employee1.id,
    startsAt: SLOT_FRIDAY_0900,
    customer: { email: 'bea@example.com', firstName: 'Bea', lastName: 'Kraus', locale: 'de' },
    locale: 'de',
  };
}

/** Rebuild the app so a settings change is picked up — settings are cached at bootstrap. */
async function withSettings(data: Record<string, unknown>): Promise<void> {
  await prisma.organizationSettings.updateMany({ data });
  await testApp.close();

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock,
    extraImports: [ManageModule],
  });

  server = testApp.server;
  service = testApp.app.get(CancellationService);
  reservations = testApp.app.get(ReservationService);
  tokens = testApp.app.get(ManagementTokenService);
}

/** An open request, with the policy set so the window applies. */
async function openRequest(paidCents = ctx.service30.priceCents): Promise<{
  booking: Booked;
  requestId: string;
}> {
  await withSettings({ cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 50 });
  const booking = await confirmedPaid({}, paidCents);
  clock.set(INSIDE_WINDOW);

  const result = await service.cancelByCustomer(booking.id);
  if (result.outcome !== 'REQUESTED') throw new Error('expected a request');

  return { booking, requestId: result.requestId };
}

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);
  clock = new FixedClock(NOW);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock,
    extraImports: [ManageModule],
  });

  server = testApp.server;
  service = testApp.app.get(CancellationService);
  reservations = testApp.app.get(ReservationService);
  tokens = testApp.app.get(ManagementTokenService);

  return async () => {
    await testApp.close();
  };
});

describe('outside the fee window', () => {
  it('cancels immediately and refunds in full', async () => {
    const booking = await confirmedPaid();

    const result = await service.cancelByCustomer(booking.id, 'Termin passt nicht');
    expect(result).toMatchObject({ outcome: 'CANCELED' });

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('CANCELED_BY_CUSTOMER');
    expect(after.canceledAt).toEqual(NOW);
    expect(after.cancellationReason).toBe('Termin passt nicht');

    const refund = await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } });
    expect(refund).toMatchObject({
      status: 'PENDING',
      amountCents: ctx.service30.priceCents,
      reason: 'CUSTOMER_CANCELLATION',
      // Nobody in the office decided this: the policy did.
      issuedByOfficeUserId: null,
    });
    expect(refund.idempotencyKey).toEqual(expect.any(String) as string);
  });

  it('asks for the money to move through the outbox, not inline', async () => {
    const booking = await confirmedPaid();
    await service.cancelByCustomer(booking.id);

    // The provider call happens in a worker, so a crash between deciding to refund and
    // Stripe accepting it does not lose the refund.
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: booking.id, eventType: JOB.BOOKING_CANCELED },
      }),
    ).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { eventType: JOB.REFUND_REQUESTED } })).toBe(1);
  });

  it('releases the slot', async () => {
    const booking = await confirmedPaid();
    await service.cancelByCustomer(booking.id);

    await expect(reservations.reserve(sameSlot())).resolves.toBeDefined();
  });

  it('writes one history row naming the customer as the actor', async () => {
    const booking = await confirmedPaid();
    await service.cancelByCustomer(booking.id);

    const history = await prisma.bookingStatusHistory.findMany({
      where: { bookingId: booking.id, toStatus: 'CANCELED_BY_CUSTOMER' },
    });

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: 'CONFIRMED', actorType: 'CUSTOMER' });
  });

  it('cancels an unpaid booking with no refund', async () => {
    const booking = await confirmedUnpaid();

    expect(await service.cancelByCustomer(booking.id)).toMatchObject({
      outcome: 'CANCELED',
      refundId: null,
    });
    expect(await prisma.refund.count()).toBe(0);
  });
});

describe('inside the fee window', () => {
  it('opens a request and leaves the booking confirmed', async () => {
    await withSettings({ cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 50 });
    const booking = await confirmedPaid();
    clock.set(INSIDE_WINDOW);

    const result = await service.cancelByCustomer(booking.id, 'krank');
    expect(result.outcome).toBe('REQUESTED');

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'CONFIRMED',
    );

    const req = await prisma.cancellationRequest.findFirstOrThrow({
      where: { bookingId: booking.id },
    });
    expect(req).toMatchObject({
      decision: 'PENDING',
      suggestedRetainedAmountCents: ctx.service30.priceCents / 2,
      reason: 'krank',
    });
  });

  it('keeps the slot blocked while the office decides', async () => {
    await withSettings({ cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 50 });
    const booking = await confirmedPaid();
    clock.set(INSIDE_WINDOW);
    await service.cancelByCustomer(booking.id);

    // Releasing early would let somebody else take the appointment before the business
    // had agreed to give it up.
    await expect(reservations.reserve(sameSlot())).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });

  it('creates no refund yet, because nothing has been decided', async () => {
    const { booking } = await openRequest();

    expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(0);
  });

  it('freezes the suggestion against a later policy change', async () => {
    const { booking } = await openRequest();

    await prisma.organizationSettings.updateMany({ data: { cancellationFeePercent: 100 } });

    // The customer was shown half; deciding against the new policy would charge them
    // something they never saw.
    expect(
      (await prisma.cancellationRequest.findFirstOrThrow({ where: { bookingId: booking.id } }))
        .suggestedRetainedAmountCents,
    ).toBe(ctx.service30.priceCents / 2);
  });

  it('refuses a second open request', async () => {
    const { booking } = await openRequest();

    await expect(service.cancelByCustomer(booking.id)).rejects.toMatchObject({
      code: 'BOOKING_NOT_CANCELLABLE',
    });
    expect(await prisma.cancellationRequest.count({ where: { bookingId: booking.id } })).toBe(1);
  });
});

describe('bookings that cannot be cancelled', () => {
  const terminal: BookingStatus[] = [
    'EXPIRED',
    'CANCELED_BY_CUSTOMER',
    'CANCELED_BY_BUSINESS',
    'COMPLETED',
    'NO_SHOW',
  ];

  it.each(terminal)('refuses a %s booking', async (status) => {
    const booking = await prisma.booking.create({
      data: makeBooking(ctx, { status, expiresAt: null }),
    });

    await expect(service.cancelByCustomer(booking.id)).rejects.toMatchObject({
      code: 'BOOKING_NOT_CANCELLABLE',
    });
  });

  it('refuses an appointment that has already started', async () => {
    const booking = await confirmedPaid();
    clock.set(new Date(SLOT_FRIDAY_0900.getTime() + 60_000));

    await expect(service.cancelByCustomer(booking.id)).rejects.toMatchObject({
      code: 'BOOKING_NOT_CANCELLABLE',
    });
  });

  it('refuses a booking that does not exist', async () => {
    await expect(service.cancelByCustomer('cms9gryv30000ja32145w5gke')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('deciding a request', () => {
  it('approving cancels, refunds paid minus retained, and audits it', async () => {
    const { booking, requestId } = await openRequest();

    await service.decideRequest({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'APPROVED',
      retainedAmountCents: 1000,
      note: 'Kulanz',
    });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'CANCELED_BY_CUSTOMER',
    );

    const req = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(req).toMatchObject({
      decision: 'APPROVED',
      retainedAmountCents: 1000,
      // Both numbers kept: what the policy suggested and what the office chose.
      suggestedRetainedAmountCents: ctx.service30.priceCents / 2,
      decidedByOfficeUserId: ctx.owner.id,
    });

    const refund = await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } });
    expect(refund.amountCents).toBe(ctx.service30.priceCents - 1000);
    expect(refund.issuedByOfficeUserId).toBe(ctx.owner.id);

    expect(
      await prisma.auditLog.count({
        where: { action: 'CANCELLATION_REQUEST_DECIDED', entityId: requestId },
      }),
    ).toBe(1);
  });

  it('falls back to the frozen suggestion when no amount is given', async () => {
    const { booking, requestId } = await openRequest();

    await service.decideRequest({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' });

    const refund = await prisma.refund.findFirstOrThrow({ where: { bookingId: booking.id } });
    expect(refund.amountCents).toBe(ctx.service30.priceCents / 2);
  });

  it('releases the slot once approved', async () => {
    const { requestId } = await openRequest();

    await service.decideRequest({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' });

    await expect(reservations.reserve(sameSlot())).resolves.toBeDefined();
  });

  it('rejecting leaves the booking confirmed and the slot held', async () => {
    const { booking, requestId } = await openRequest();

    await service.decideRequest({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'REJECTED',
      note: 'zu kurzfristig',
    });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'CONFIRMED',
    );
    expect(
      (await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: requestId } })).decision,
    ).toBe('REJECTED');
    expect(await prisma.refund.count()).toBe(0);

    await expect(reservations.reserve(sameSlot())).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });

  it('refuses a retained amount above what was paid', async () => {
    const { requestId } = await openRequest();

    await expect(
      service.decideRequest({
        requestId,
        officeUserId: ctx.owner.id,
        decision: 'APPROVED',
        retainedAmountCents: ctx.service30.priceCents + 500,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a second decision', async () => {
    const { requestId } = await openRequest();

    await service.decideRequest({ requestId, officeUserId: ctx.owner.id, decision: 'REJECTED' });

    await expect(
      service.decideRequest({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' }),
    ).rejects.toMatchObject({ code: 'REQUEST_ALREADY_DECIDED' });
  });

  it('leaves the request open when the retained amount is refused', async () => {
    const { requestId } = await openRequest();

    await expect(
      service.decideRequest({
        requestId,
        officeUserId: ctx.owner.id,
        decision: 'APPROVED',
        retainedAmountCents: -1,
      }),
    ).rejects.toThrow();

    // The whole transaction rolled back, so the office can decide again.
    expect(
      (await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: requestId } })).decision,
    ).toBe('PENDING');
  });
});

describe('POST /manage/cancel', () => {
  it('returns 200 and the expected refund for an immediate cancellation', async () => {
    const booking = await confirmedPaid();
    const { token } = await prisma.$transaction((tx) =>
      tokens.issue(tx, booking.id, ctx.organization.id, SLOT_FRIDAY_0900),
    );

    const response = await request(server())
      .post('/manage/cancel')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Termin passt nicht' })
      .expect(200);

    expect(response.body).toMatchObject({
      outcome: 'CANCELED',
      refundExpected: { amountCents: ctx.service30.priceCents, currency: 'EUR' },
      suggestedRetained: null,
    });
  });

  it('returns 202 when a decision is needed, which is a different answer', async () => {
    await withSettings({ cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 50 });
    const booking = await confirmedPaid();
    clock.set(INSIDE_WINDOW);

    const { token } = await prisma.$transaction((tx) =>
      tokens.issue(tx, booking.id, ctx.organization.id, SLOT_FRIDAY_0900),
    );

    const response = await request(server())
      .post('/manage/cancel')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(202);

    expect(response.body).toMatchObject({
      outcome: 'REQUESTED',
      refundExpected: null,
      suggestedRetained: { amountCents: ctx.service30.priceCents / 2 },
    });
  });

  it('takes no booking id, so a link cannot cancel someone else appointment', async () => {
    const mine = await confirmedPaid();
    const other = await confirmedPaid({
      employeeId: ctx.employee2.id,
      startsAt: new Date(SLOT_FRIDAY_0900.getTime() + 60 * 60_000),
    });

    const { token } = await prisma.$transaction((tx) =>
      tokens.issue(tx, mine.id, ctx.organization.id, SLOT_FRIDAY_0900),
    );

    await request(server())
      .post('/manage/cancel')
      .set('Authorization', `Bearer ${token}`)
      .send({ bookingId: other.id })
      .expect(200);

    // The body's bookingId was ignored: the token decided.
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe(
      'CANCELED_BY_CUSTOMER',
    );
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      'CONFIRMED',
    );
  });

  it('requires a token', async () => {
    await request(server()).post('/manage/cancel').send({}).expect(401);
  });

  it('reports a booking that cannot be cancelled as 409', async () => {
    const booking = await confirmedPaid();
    const { token } = await prisma.$transaction((tx) =>
      tokens.issue(tx, booking.id, ctx.organization.id, SLOT_FRIDAY_0900),
    );

    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'COMPLETED' } });

    const response = await request(server())
      .post('/manage/cancel')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(409);

    expect(response.body).toMatchObject({ code: 'BOOKING_NOT_CANCELLABLE' });
  });
});
