import { beforeEach, describe, expect, it } from 'vitest';

import { Money } from '../../src/domain/money/money.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { PaymentModule } from '../../src/payment/payment.module.js';
import { RefundService } from '../../src/payment/refund.service.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, makeBooking, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';

import type { FakePaymentProvider } from '../../src/providers/payment/fake-payment.provider.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';

const NOW = new Date('2026-08-10T06:00:00.000Z');

let ctx: SeedContext;
let clock: FixedClock;
let testApp: BookingTestApp;
let payments: FakePaymentProvider;
let service: RefundService;
let bookingId: string;
let unpaidBookingId: string;

const PRICE = 4500;

/**
 * A confirmed booking whose payment has a charge the provider actually knows.
 *
 * The session is created through the fake and marked paid, so the charge id is one the
 * provider can refund against — inventing an id here would make every refund fail for a
 * reason production would never hit.
 */
async function paidBooking(
  options: { withCharge?: boolean; hoursLater?: number } = {},
): Promise<string> {
  const booking = await prisma.booking.create({
    data: {
      ...makeBooking(ctx, {
        status: 'CONFIRMED',
        expiresAt: null,
        // Distinct slots, because the exclusion constraint will not have two bookings
        // overlapping for one employee.
        startsAt: new Date(SLOT_FRIDAY_0900.getTime() + (options.hoursLater ?? 0) * 60 * 60_000),
      }),
      confirmedAt: NOW,
    },
  });

  const session = await payments.createCheckoutSession(
    { organizationId: ctx.organization.id },
    {
      bookingId: booking.id,
      clientReferenceId: booking.id,
      amount: Money.fromCents(PRICE, 'EUR'),
      description: 'Test',
      customerEmail: 'anna@example.com',
      successUrl: 'http://localhost:5173/s',
      cancelUrl: 'http://localhost:5173/c',
      locale: 'de',
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    },
  );

  const withCharge = options.withCharge !== false;
  if (withCharge) payments.markPaid(session.sessionId);

  await prisma.payment.create({
    data: {
      organizationId: ctx.organization.id,
      bookingId: booking.id,
      stripeCheckoutSessionId: session.sessionId,
      ...(withCharge ? { stripeChargeId: payments.chargeIdFor(session.sessionId) } : {}),
      amountCents: PRICE,
      currency: 'EUR',
      status: 'SUCCEEDED',
      paidAt: NOW,
    },
  });

  return booking.id;
}

/** A booking with nothing settled — the manual, pay-on-site case. */
async function unpaidBooking(): Promise<string> {
  const booking = await prisma.booking.create({
    data: {
      ...makeBooking(ctx, {
        status: 'CONFIRMED',
        expiresAt: null,
        employeeId: ctx.employee2.id,
        startsAt: new Date(SLOT_FRIDAY_0900.getTime() + 2 * 60 * 60_000),
      }),
      confirmedAt: NOW,
      origin: 'OFFICE',
    },
  });

  return booking.id;
}

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);
  clock = new FixedClock(NOW);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock,
    extraImports: [PaymentModule],
  });

  payments = testApp.payments;
  service = testApp.app.get(RefundService);

  bookingId = await paidBooking();
  unpaidBookingId = await unpaidBooking();

  return testApp.close;
});

describe('requesting a refund', () => {
  it('creates the row PENDING before any provider call', async () => {
    const { refundId } = await service.request({
      bookingId,
      amountCents: 2000,
      reason: 'GOODWILL',
      officeUserId: ctx.owner.id,
    });

    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    expect(refund).toMatchObject({
      status: 'PENDING',
      amountCents: 2000,
      reason: 'GOODWILL',
      issuedByOfficeUserId: ctx.owner.id,
    });

    // The money never moves without something durable saying it was supposed to.
    expect(payments.refundCalls()).toHaveLength(0);
  });

  it('asks a worker to do the moving', async () => {
    const { refundId } = await service.request({
      bookingId,
      amountCents: 2000,
      reason: 'GOODWILL',
    });

    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: refundId, eventType: 'refund.requested' },
      }),
    ).toBe(1);
  });

  it('refuses more than the remaining refundable amount', async () => {
    const first = await service.request({ bookingId, amountCents: 4000, reason: 'GOODWILL' });
    await service.execute(first.refundId);

    await expect(
      service.request({ bookingId, amountCents: 1000, reason: 'GOODWILL' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE' });
  });

  it('refuses a zero or negative amount', async () => {
    await expect(
      service.request({ bookingId, amountCents: 0, reason: 'GOODWILL' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE' });
  });

  it('refuses a booking with nothing settled', async () => {
    await expect(
      service.request({ bookingId: unpaidBookingId, amountCents: 100, reason: 'GOODWILL' }),
    ).rejects.toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE' });
  });
});

describe('executing a refund', () => {
  it('passes the stored idempotency key to the provider', async () => {
    const { refundId } = await service.request({
      bookingId,
      amountCents: 2000,
      reason: 'GOODWILL',
    });
    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });

    await service.execute(refundId);

    // The stored key, not a fresh one: a retry after a lost response must reach Stripe
    // with the same key and get the original refund back.
    expect(payments.refundCalls()[0]?.idempotencyKey).toBe(row.idempotencyKey);
  });

  it('settles the refund and records the provider id', async () => {
    const { refundId } = await service.request({
      bookingId,
      amountCents: 2000,
      reason: 'GOODWILL',
    });

    expect(await service.execute(refundId)).toBe('SUCCEEDED');

    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    expect(refund.status).toBe('SUCCEEDED');
    expect(refund.stripeRefundId).not.toBeNull();
    expect(refund.settledAt).toEqual(NOW);
  });

  it('is safe under a repeated job: the provider key settles one refund, not two', async () => {
    const { refundId } = await service.request({
      bookingId,
      amountCents: 2000,
      reason: 'GOODWILL',
    });
    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });

    await Promise.all([service.execute(refundId), service.execute(refundId)]);

    // Two invocations, deliberately. The status check before the call is a cheap filter, not a
    // lock — two workers handed the same job both see PENDING. What makes that safe is the
    // stored idempotency key: Stripe returns the *first* refund for the second call rather
    // than creating another, so only one refund exists and only one amount moves.
    //
    // Asserted through `callOrder`, which counts invocations. `refundCalls()` would read 1
    // either way, because the fake records the refund only when it actually creates one.
    const calls = payments.callOrder().filter((call) => call === 'createRefund');
    expect(calls).toHaveLength(2);
    expect(payments.refundCalls()).toHaveLength(1);
    expect(payments.refundCalls()[0]?.idempotencyKey).toBe(row.idempotencyKey);

    expect(await prisma.refund.count({ where: { bookingId } })).toBe(1);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).status).toBe(
      'SUCCEEDED',
    );
  });

  it('does nothing for an already settled refund', async () => {
    const { refundId } = await service.request({
      bookingId,
      amountCents: 2000,
      reason: 'GOODWILL',
    });
    await service.execute(refundId);

    expect(await service.execute(refundId)).toBe('SUCCEEDED');
    expect(payments.refundCalls()).toHaveLength(1);
  });

  it('records FAILED with the reason when the provider rejects', async () => {
    const { refundId } = await service.request({
      bookingId,
      amountCents: 2000,
      reason: 'GOODWILL',
    });

    payments.failNextWith(new Error('charge_already_refunded'));

    expect(await service.execute(refundId)).toBe('FAILED');

    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });
    expect(refund.status).toBe('FAILED');
    expect(refund.failureReason).toContain('charge_already_refunded');
  });

  it('fails a refund whose payment has no charge, rather than retrying forever', async () => {
    const noCharge = await paidBooking({ withCharge: false, hoursLater: 4 });

    const { refundId } = await service.request({
      bookingId: noCharge,
      amountCents: 1000,
      reason: 'GOODWILL',
    });

    // The charge id will not appear on its own, so retrying would never succeed.
    expect(await service.execute(refundId)).toBe('FAILED');
    expect(payments.refundCalls()).toHaveLength(0);
  });
});

describe('the payment totals', () => {
  it('moves to PARTIALLY_REFUNDED then REFUNDED', async () => {
    const first = await service.request({ bookingId, amountCents: 2000, reason: 'GOODWILL' });
    await service.execute(first.refundId);

    expect(await prisma.payment.findFirstOrThrow({ where: { bookingId } })).toMatchObject({
      refundedAmountCents: 2000,
      status: 'PARTIALLY_REFUNDED',
    });

    const rest = await service.request({ bookingId, amountCents: 2500, reason: 'GOODWILL' });
    await service.execute(rest.refundId);

    expect(await prisma.payment.findFirstOrThrow({ where: { bookingId } })).toMatchObject({
      refundedAmountCents: PRICE,
      status: 'REFUNDED',
    });
  });

  it('always equals the sum of SUCCEEDED refunds, excluding failed ones', async () => {
    for (const amount of [1000, 1500]) {
      const { refundId } = await service.request({
        bookingId,
        amountCents: amount,
        reason: 'GOODWILL',
      });
      await service.execute(refundId);
    }

    const failing = await service.request({ bookingId, amountCents: 500, reason: 'GOODWILL' });
    payments.failNextWith(new Error('nope'));
    await service.execute(failing.refundId);

    const sum = await prisma.refund.aggregate({
      where: { bookingId, status: 'SUCCEEDED' },
      _sum: { amountCents: true },
    });

    // Recomputed from the refunds rather than incremented, so a failed attempt does not
    // leave the total overstated.
    expect(
      (await prisma.payment.findFirstOrThrow({ where: { bookingId } })).refundedAmountCents,
    ).toBe(sum._sum.amountCents);
    expect(sum._sum.amountCents).toBe(2500);
  });

  it('lets a failed refund be re-requested for the same amount', async () => {
    const failing = await service.request({ bookingId, amountCents: PRICE, reason: 'GOODWILL' });
    payments.failNextWith(new Error('nope'));
    await service.execute(failing.refundId);

    // The failed one consumed nothing, so the full amount is refundable again.
    const retry = await service.request({ bookingId, amountCents: PRICE, reason: 'GOODWILL' });
    expect(await service.execute(retry.refundId)).toBe('SUCCEEDED');
  });
});

describe('webhooks arriving out of order', () => {
  it('handles charge.refunded arriving before the api response', async () => {
    const { refundId } = await service.request({
      bookingId,
      amountCents: 2000,
      reason: 'GOODWILL',
    });
    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });

    // Matched on our own idempotency key, which is the only handle available before the
    // provider's id is known locally.
    await service.applyProviderUpdate({
      stripeRefundId: 're_early',
      idempotencyKey: row.idempotencyKey,
      status: 'succeeded',
      amountCents: 2000,
    });

    await service.execute(refundId);

    expect(await prisma.refund.count({ where: { bookingId } })).toBe(1);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).status).toBe(
      'SUCCEEDED',
    );
    // Already settled, so no provider call was made.
    expect(payments.refundCalls()).toHaveLength(0);
  });

  it('never downgrades a settled refund on a late refund.updated', async () => {
    const { refundId } = await service.request({
      bookingId,
      amountCents: 2000,
      reason: 'GOODWILL',
    });
    await service.execute(refundId);
    const row = await prisma.refund.findUniqueOrThrow({ where: { id: refundId } });

    await service.applyProviderUpdate({
      stripeRefundId: row.stripeRefundId ?? '',
      status: 'failed',
      amountCents: 2000,
    });

    // Saying "failed" about money that already went back would corrupt the accounting,
    // and the provider does send those.
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).status).toBe(
      'SUCCEEDED',
    );
    expect(
      (await prisma.payment.findFirstOrThrow({ where: { bookingId } })).refundedAmountCents,
    ).toBe(2000);
  });

  it('ignores an update for a refund it does not know', async () => {
    await expect(
      service.applyProviderUpdate({
        stripeRefundId: 're_issued_in_the_dashboard',
        status: 'succeeded',
        amountCents: 100,
      }),
    ).resolves.toBeUndefined();
  });

  it('queues a customer notification once a refund succeeds', async () => {
    const { refundId } = await service.request({
      bookingId,
      amountCents: 2000,
      reason: 'GOODWILL',
    });
    await service.execute(refundId);

    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: refundId, eventType: 'refund.succeeded' },
      }),
    ).toBe(1);
  });

  it('queues no notification for a failed refund', async () => {
    const { refundId } = await service.request({
      bookingId,
      amountCents: 2000,
      reason: 'GOODWILL',
    });
    payments.failNextWith(new Error('nope'));
    await service.execute(refundId);

    expect(await prisma.outboxEvent.count({ where: { eventType: 'refund.succeeded' } })).toBe(0);
  });
});
