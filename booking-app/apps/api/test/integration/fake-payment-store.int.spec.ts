import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { Money } from '../../src/domain/money/money.js';
import { FakePaymentProvider } from '../../src/providers/payment/fake-payment.provider.js';
import { RedisFakePaymentStore } from '../../src/providers/payment/fake-payment.store.js';
import { QUEUE_PREFIX, connectRedis, disconnectRedis, redis } from '../redis.harness.js';

import type {
  CreateCheckoutSessionInput,
  PaymentAccountContext,
} from '../../src/providers/payment/payment-provider.js';

/**
 * The fake payment provider across a process boundary.
 *
 * Two `FakePaymentProvider` instances over one Redis stand in for the API and the
 * worker, which is the shape a deployment actually has. The unit suite proves the
 * same thing over an in-memory store; this proves the serialisation survives the
 * round trip, which is where a `Money` or a `Date` would quietly turn into `{}`.
 */

const context: PaymentAccountContext = { organizationId: 'org-1', stripeAccountId: undefined };

const input = (
  overrides: Partial<CreateCheckoutSessionInput> = {},
): CreateCheckoutSessionInput => ({
  bookingId: 'bk-1',
  clientReferenceId: 'bk-1',
  amount: Money.fromCents(4500),
  description: 'Facial Massage 30 min',
  customerEmail: 'anna@example.com',
  successUrl: 'http://localhost:5173/booking/success',
  cancelUrl: 'http://localhost:5173/booking/canceled',
  locale: 'de',
  expiresAt: new Date('2026-08-14T06:05:00.000Z'),
  ...overrides,
});

function store(): RedisFakePaymentStore {
  return new RedisFakePaymentStore(redis, QUEUE_PREFIX);
}

/** Separate stores, on purpose: two processes each build their own. */
let api: FakePaymentProvider;
let worker: FakePaymentProvider;

beforeEach(async () => {
  await connectRedis();
  api = new FakePaymentProvider(store());
  worker = new FakePaymentProvider(store());
  await api.reset();
});

afterAll(async () => {
  await new FakePaymentProvider(store()).reset();
  await disconnectRedis();
});

describe('a Redis-backed fake, seen from two processes', () => {
  it('answers the worker about a session the API created', async () => {
    const session = await api.createCheckoutSession(context, input());

    const retrieved = await worker.retrieveCheckoutSession(context, session.sessionId);

    expect(retrieved.amountTotalCents).toBe(4500);
    expect(retrieved.currency).toBe('EUR');
    expect(retrieved.clientReferenceId).toBe('bk-1');
    expect(retrieved.status).toBe('open');
  });

  it('returns an expiry date, not a string, after the round trip', async () => {
    const session = await api.createCheckoutSession(context, input({ idempotencyKey: 'key-1' }));
    // The replay path rebuilds the result from what was stored, which is where a
    // serialised Date would surface as a string and fail at the first `.getTime()`.
    const replayed = await worker.createCheckoutSession(
      context,
      input({ idempotencyKey: 'key-1' }),
    );

    expect(replayed.sessionId).toBe(session.sessionId);
    expect(replayed.expiresAt).toBeInstanceOf(Date);
    expect(replayed.expiresAt.toISOString()).toBe('2026-08-14T06:05:00.000Z');
  });

  it('lets the expiry job release a slot the API reserved', async () => {
    const session = await api.createCheckoutSession(context, input());

    await expect(worker.expireCheckoutSession(context, session.sessionId)).resolves.toEqual({
      outcome: 'EXPIRED',
    });
    expect((await api.retrieveCheckoutSession(context, session.sessionId)).status).toBe('expired');
  });

  it('lets the expiry job see a payment the API recorded, and confirm instead', async () => {
    const session = await api.createCheckoutSession(context, input());
    await api.markPaid(session.sessionId);

    await expect(worker.expireCheckoutSession(context, session.sessionId)).resolves.toEqual({
      outcome: 'ALREADY_COMPLETE',
      paymentStatus: 'paid',
    });
  });

  it('lets the refund processor refund a charge the API produced', async () => {
    const session = await api.createCheckoutSession(context, input());
    await api.markPaid(session.sessionId);
    const chargeId = await api.chargeIdFor(session.sessionId);

    const refund = await worker.createRefund(context, {
      chargeId,
      amount: Money.fromCents(2000),
      idempotencyKey: 'rf-1',
    });

    expect(refund.status).toBe('succeeded');
    // Money arithmetic over the stored amounts, not over a cached object: the
    // remainder has to be right in the process that did not take the payment.
    await expect(
      worker.createRefund(context, {
        chargeId,
        amount: Money.fromCents(3000),
        idempotencyKey: 'rf-2',
      }),
    ).rejects.toThrow(/exceeds/i);
    expect(await api.refundCalls()).toHaveLength(1);
  });

  it('refunds once when two processes claim the same key at the same moment', async () => {
    // The retry that made this necessary: two attempts at one refund job, in two
    // worker replicas, both reading an empty store and both refunding. HSETNX is what
    // decides between them, and only Redis can.
    const session = await api.createCheckoutSession(context, input());
    await api.markPaid(session.sessionId);
    const chargeId = await api.chargeIdFor(session.sessionId);
    const args = { chargeId, amount: Money.fromCents(2000), idempotencyKey: 'rf-1' };

    const [fromApi, fromWorker] = await Promise.all([
      api.createRefund(context, args),
      worker.createRefund(context, args),
    ]);

    expect(fromWorker?.refundId).toBe(fromApi?.refundId);
    expect(await api.refundCalls()).toHaveLength(1);
  });

  it('mints ids that cannot collide between processes', async () => {
    const fromApi = await api.createCheckoutSession(context, input());
    const fromWorker = await worker.createCheckoutSession(context, input());

    // Both instances start their counter at zero; only the per-process marker
    // keeps the second from overwriting the first.
    expect(fromWorker.sessionId).not.toBe(fromApi.sessionId);
    expect(await api.sessions()).toHaveLength(2);
  });
});
