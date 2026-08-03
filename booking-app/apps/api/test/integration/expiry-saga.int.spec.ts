import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { BookingConfirmationService } from '../../src/booking/booking-confirmation.service.js';
import { BLOCKING_BOOKING_STATUSES } from '../../src/booking/booking-status.machine.js';
import { ExpiryService } from '../../src/booking/expiry.service.js';
import { ExpirySweeper, STUCK_EXPIRING_AFTER_MS } from '../../src/booking/expiry.sweeper.js';
import { ExpiryProcessor } from '../../src/booking/processors/expiry.processor.js';
import { ReservationService } from '../../src/booking/reservation.service.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { JOB } from '../../src/messaging/queues/job-contracts.js';
import { PUBLIC_WEB_ORIGIN, createBookingTestApp, enqueued } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';

import type { ReserveInput } from '../../src/booking/reservation.service.js';
import type { FakePaymentProvider } from '../../src/providers/payment/fake-payment.provider.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/**
 * Real "now", not a fictional instant.
 *
 * `updatedAt` is written by Prisma at real time, and the stuck-EXPIRING sweep compares
 * against it. A clock pinned days into the future would make every row look stale and
 * the sweep would claim everything. So the clock tracks reality and a reservation is
 * made overdue by backdating its `expiresAt` — moving the row, not the clock, which is
 * the same lesson the outbox and inbox suites record.
 */
const NOW = new Date();

let ctx: SeedContext;
let clock: FixedClock;
let testApp: BookingTestApp;
let server: () => Server;
let payments: FakePaymentProvider;
let expiry: ExpiryService;
let sweeper: ExpirySweeper;
let processor: ExpiryProcessor;
let reservations: ReservationService;
let confirmations: BookingConfirmationService;

interface Reserved {
  id: string;
  sessionId: string | null;
}

/** Book a slot through the real endpoint, so the session and payment row exist. */
async function reserve(startsAt = SLOT_FRIDAY_0900): Promise<Reserved> {
  const response = await request(server())
    .post('/public/bookings')
    .set('Idempotency-Key', randomUUID())
    .send({
      serviceId: ctx.service30.id,
      employeeId: ctx.employee1.id,
      startsAt: startsAt.toISOString(),
      customer: { email: 'anna@example.com', firstName: 'Anna', lastName: 'Becker' },
      locale: 'de',
      successUrl: `${PUBLIC_WEB_ORIGIN}/booking/success`,
      cancelUrl: `${PUBLIC_WEB_ORIGIN}/booking/canceled`,
    })
    .expect(201);

  const created = response.body as { bookingId: string };
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: created.bookingId } });

  return { id: booking.id, sessionId: booking.stripeCheckoutSessionId };
}

/** A reservation whose five minutes have run out. */
async function overdue(startsAt = SLOT_FRIDAY_0900): Promise<Reserved> {
  const booking = await reserve(startsAt);

  await prisma.booking.update({
    where: { id: booking.id },
    data: { expiresAt: new Date(clock.now().getTime() - 60_000) },
  });

  return booking;
}

/**
 * The same slot the given booking holds, for proving it is still blocked.
 *
 * The start time is read off the booking rather than assumed to be `SLOT_FRIDAY_0900`. With
 * the argument discarded, a future test reserving a different slot and passing that booking
 * here would assert against an unrelated slot and could pass for the wrong reason.
 */
async function sameSlot(booking: { id: string }): Promise<ReserveInput> {
  const row = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });

  return {
    serviceId: ctx.service30.id,
    employeeId: ctx.employee1.id,
    startsAt: row.startsAt,
    customer: {
      email: 'bea@example.com',
      firstName: 'Bea',
      lastName: 'Kraus',
      locale: 'de',
    },
    locale: 'de',
  };
}

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);
  clock = new FixedClock(NOW);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock,
  });

  server = testApp.server;
  payments = testApp.payments;
  expiry = testApp.app.get(ExpiryService);
  sweeper = testApp.app.get(ExpirySweeper);
  processor = testApp.app.get(ExpiryProcessor);
  reservations = testApp.app.get(ReservationService);
  confirmations = testApp.app.get(BookingConfirmationService);

  return testApp.close;
});

describe('phase one', () => {
  it('moves to EXPIRING and keeps the slot blocked', async () => {
    const booking = await overdue();

    expect(await expiry.beginExpiry(booking.id)).toBe('BEGAN');

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('EXPIRING');
    expect(BLOCKING_BOOKING_STATUSES).toContain(after.status);

    // The whole point of the intermediate status, proven the only way that matters: a
    // competing reservation still cannot have the slot.
    await expect(reservations.reserve(await sameSlot(booking))).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });

  it('asks for phase two through the outbox', async () => {
    const booking = await overdue();
    await expiry.beginExpiry(booking.id);

    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: booking.id, eventType: JOB.BOOKING_EXPIRY_REQUESTED },
      }),
      // One from the reservation arming the timer, one from phase one asking to finish.
    ).toBe(2);
  });

  it('writes one history row', async () => {
    const booking = await overdue();
    await expiry.beginExpiry(booking.id);

    const history = await prisma.bookingStatusHistory.findMany({
      where: { bookingId: booking.id, toStatus: 'EXPIRING' },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: 'PENDING_PAYMENT', actorType: 'SYSTEM' });
  });

  it('refuses while the reservation is not yet due', async () => {
    const booking = await reserve();

    expect(await expiry.beginExpiry(booking.id)).toBe('NOT_DUE');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'PENDING_PAYMENT',
    );
  });

  it('is a no-op the second time', async () => {
    const booking = await overdue();

    expect(await expiry.beginExpiry(booking.id)).toBe('BEGAN');
    expect(await expiry.beginExpiry(booking.id)).toBe('NOT_APPLICABLE');

    expect(
      await prisma.bookingStatusHistory.count({
        where: { bookingId: booking.id, toStatus: 'EXPIRING' },
      }),
    ).toBe(1);
  });

  it('is a no-op for a booking that was already confirmed', async () => {
    const booking = await reserve();
    await prisma.booking.update({
      where: { id: booking.id },
      data: { status: 'CONFIRMED', expiresAt: null, confirmedAt: clock.now() },
    });

    expect(await expiry.beginExpiry(booking.id)).toBe('NOT_APPLICABLE');
  });
});

describe('phase two', () => {
  it('releases the slot only after Stripe reports the session expired', async () => {
    const booking = await overdue();
    await expiry.beginExpiry(booking.id);

    expect(await expiry.completeExpiry(booking.id)).toBe('EXPIRED');

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('EXPIRED');
    expect(after.expiresAt).toBeNull();

    // Released for real: the next customer can now have it.
    await expect(reservations.reserve(await sameSlot(booking))).resolves.toBeDefined();
  });

  it('confirms instead when the customer paid inside the window', async () => {
    const booking = await overdue();
    await payments.markPaid(booking.sessionId ?? '');
    await expiry.beginExpiry(booking.id);

    expect(await expiry.completeExpiry(booking.id)).toBe('CONFIRMED');

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('CONFIRMED');
    expect(after.expiresAt).toBeNull();

    // No refund, and exactly one management token: the saga went through the same
    // confirmation path the webhook uses.
    expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(0);
    expect(await prisma.managementToken.count({ where: { bookingId: booking.id } })).toBe(1);
    expect(
      await prisma.payment.count({ where: { bookingId: booking.id, status: 'SUCCEEDED' } }),
    ).toBe(1);
  });

  it('keeps the slot blocked when Stripe is unreachable', async () => {
    const booking = await overdue();
    await expiry.beginExpiry(booking.id);
    payments.failNextWith(new Error('ETIMEDOUT'));

    await expect(expiry.completeExpiry(booking.id)).rejects.toThrow('ETIMEDOUT');

    // Without Stripe's answer we do not know whether the customer paid, so failing
    // means over-blocking rather than releasing on a guess.
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'EXPIRING',
    );
    await expect(reservations.reserve(await sameSlot(booking))).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });

  it('expires directly when no session id was ever attached', async () => {
    const booking = await overdue();
    await prisma.booking.update({
      where: { id: booking.id },
      data: { stripeCheckoutSessionId: null },
    });

    await expiry.beginExpiry(booking.id);
    expect(await expiry.completeExpiry(booking.id)).toBe('EXPIRED');
    // Nothing to ask Stripe about, so nothing was asked.
    expect(payments.callOrder()).not.toContain('expireCheckoutSession');
  });

  it('never opens a transaction around the Stripe call', async () => {
    const booking = await overdue();
    await expiry.beginExpiry(booking.id);
    await expiry.completeExpiry(booking.id);

    // A transaction spanning the call would hold this booking's row locks for as long as
    // Stripe takes, on the exact row a paying customer's webhook needs.
    expect(payments.callOrder()).toEqual(['createCheckoutSession', 'expireCheckoutSession']);
  });

  it('is a no-op the second time, with one history row', async () => {
    const booking = await overdue();
    await expiry.beginExpiry(booking.id);

    expect(await expiry.completeExpiry(booking.id)).toBe('EXPIRED');
    expect(await expiry.completeExpiry(booking.id)).toBe('EXPIRED');

    expect(
      await prisma.bookingStatusHistory.count({
        where: { bookingId: booking.id, toStatus: 'EXPIRED' },
      }),
    ).toBe(1);
  });

  it('reports the settled outcome for a booking that never entered the saga', async () => {
    const booking = await reserve();
    expect(await expiry.completeExpiry(booking.id)).toBe('NOT_APPLICABLE');
  });
});

describe('the race with the webhook', () => {
  it('produces one payment, one token and one history row whichever wins', async () => {
    const booking = await overdue();
    await payments.markPaid(booking.sessionId ?? '');
    await expiry.beginExpiry(booking.id);

    // Both paths reach BookingConfirmationService at once. Its FOR UPDATE lock is what
    // makes the loser a no-op rather than a second set of side effects.
    await Promise.all([
      expiry.completeExpiry(booking.id),
      confirmations.confirmPaid({
        bookingId: booking.id,
        sessionId: booking.sessionId ?? '',
        amountTotalCents: ctx.service30.priceCents,
        paidAt: clock.now(),
        cause: { kind: 'WEBHOOK', reference: 'evt_race' },
      }),
    ]);

    expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
    expect(await prisma.managementToken.count({ where: { bookingId: booking.id } })).toBe(1);
    expect(
      await prisma.bookingStatusHistory.count({
        where: { bookingId: booking.id, toStatus: 'CONFIRMED' },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: booking.id, eventType: JOB.BOOKING_CONFIRMED },
      }),
    ).toBe(1);
  });
});

describe('the processor', () => {
  it('runs both phases from one job', async () => {
    const booking = await overdue();

    // One job type serves both phases: each phase no-ops unless the booking is in the
    // status it applies to.
    await processor.handle({ organizationId: ctx.organization.id, bookingId: booking.id });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'EXPIRED',
    );
  });

  it('does nothing for a job that fires early', async () => {
    const booking = await reserve();

    await processor.handle({ organizationId: ctx.organization.id, bookingId: booking.id });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'PENDING_PAYMENT',
    );
  });

  it('confirms when the customer paid, driven entirely from the job', async () => {
    const booking = await overdue();
    await payments.markPaid(booking.sessionId ?? '');

    await processor.handle({ organizationId: ctx.organization.id, bookingId: booking.id });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'CONFIRMED',
    );
  });
});

describe('the sweeper', () => {
  it('begins expiry for overdue reservations', async () => {
    const booking = await overdue();

    expect(await sweeper.sweepOverdue()).toBe(1);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      'EXPIRING',
    );
  });

  it('leaves a reservation that is still within its window', async () => {
    await reserve();
    expect(await sweeper.sweepOverdue()).toBe(0);
  });

  it('re-drives a booking stuck in EXPIRING', async () => {
    const booking = await overdue();
    await expiry.beginExpiry(booking.id);

    // The worker died mid-saga: still EXPIRING, and not touched for a while.
    await prisma.booking.updateMany({
      where: { id: booking.id },
      data: { updatedAt: new Date(clock.now().getTime() - STUCK_EXPIRING_AFTER_MS - 60_000) },
    });

    enqueued.length = 0;
    expect(await sweeper.sweepStuckExpiring()).toBe(1);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      name: JOB.BOOKING_EXPIRY_REQUESTED,
      data: { bookingId: booking.id },
    });
  });

  it('leaves a recently updated EXPIRING booking alone', async () => {
    const booking = await overdue();
    await expiry.beginExpiry(booking.id);

    // Phase two normally finishes in the time one Stripe call takes, so a fresh
    // EXPIRING row is in flight rather than stuck.
    expect(await sweeper.sweepStuckExpiring()).toBe(0);
  });

  it('uses one job id per stuck booking, so repeated sweeps collapse', async () => {
    const booking = await overdue();
    await expiry.beginExpiry(booking.id);
    await prisma.booking.updateMany({
      where: { id: booking.id },
      data: { updatedAt: new Date(clock.now().getTime() - STUCK_EXPIRING_AFTER_MS - 60_000) },
    });

    enqueued.length = 0;
    await sweeper.sweepStuckExpiring();
    await sweeper.sweepStuckExpiring();

    const jobIds = enqueued.map((job) => (job.options as { jobId: string }).jobId);
    expect(new Set(jobIds).size).toBe(1);
  });
});
