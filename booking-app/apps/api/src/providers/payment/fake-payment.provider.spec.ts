import { beforeEach, describe, expect, it } from 'vitest';

import { Money } from '../../domain/money/money.js';

import { FakePaymentProvider } from './fake-payment.provider.js';

import type { CreateCheckoutSessionInput, PaymentAccountContext } from './payment-provider.js';

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

let provider: FakePaymentProvider;

beforeEach(() => {
  provider = new FakePaymentProvider();
});

describe('createCheckoutSession', () => {
  it('returns a marked id and a url containing it', async () => {
    const session = await provider.createCheckoutSession(context, input());

    // The marker means a fake id can never be mistaken for a real one in a log.
    expect(session.sessionId).toMatch(/^cs_fake_/);
    expect(session.url).toContain(session.sessionId);
    expect(session.expiresAt.toISOString()).toBe('2026-08-14T06:05:00.000Z');
  });

  it('records the amount and the client reference for later correlation', async () => {
    const session = await provider.createCheckoutSession(context, input());
    const retrieved = await provider.retrieveCheckoutSession(context, session.sessionId);

    expect(retrieved.amountTotalCents).toBe(4500);
    expect(retrieved.currency).toBe('EUR');
    expect(retrieved.clientReferenceId).toBe('bk-1');
    expect(retrieved.status).toBe('open');
    expect(retrieved.paymentStatus).toBe('unpaid');
  });

  it('replays the same session for a repeated idempotency key', async () => {
    const first = await provider.createCheckoutSession(context, input({ idempotencyKey: 'key-1' }));
    const second = await provider.createCheckoutSession(
      context,
      input({ idempotencyKey: 'key-1' }),
    );

    expect(second.sessionId).toBe(first.sessionId);
    expect(provider.sessions()).toHaveLength(1);
  });

  it('rejects a checkout key reused with a different amount', async () => {
    await provider.createCheckoutSession(context, input({ idempotencyKey: 'key-1' }));

    await expect(
      provider.createCheckoutSession(
        context,
        input({ idempotencyKey: 'key-1', amount: Money.fromCents(4600) }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('rejects a checkout key reused with another changed field', async () => {
    await provider.createCheckoutSession(context, input({ idempotencyKey: 'key-1' }));

    await expect(
      provider.createCheckoutSession(
        context,
        input({ idempotencyKey: 'key-1', successUrl: 'https://example.com/other' }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('creates distinct sessions for distinct keys', async () => {
    const first = await provider.createCheckoutSession(context, input({ idempotencyKey: 'key-1' }));
    const second = await provider.createCheckoutSession(
      context,
      input({ idempotencyKey: 'key-2' }),
    );

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(provider.sessions()).toHaveLength(2);
  });
});

describe('expireCheckoutSession — the two branches the saga depends on', () => {
  it('EXPIRED for an open session, which releases the slot', async () => {
    const session = await provider.createCheckoutSession(context, input());

    await expect(provider.expireCheckoutSession(context, session.sessionId)).resolves.toEqual({
      outcome: 'EXPIRED',
    });
    expect((await provider.retrieveCheckoutSession(context, session.sessionId)).status).toBe(
      'expired',
    );
  });

  it('ALREADY_COMPLETE for a paid session, which must confirm rather than release', async () => {
    const session = await provider.createCheckoutSession(context, input());
    provider.markPaid(session.sessionId);

    await expect(provider.expireCheckoutSession(context, session.sessionId)).resolves.toEqual({
      outcome: 'ALREADY_COMPLETE',
      paymentStatus: 'paid',
    });
  });

  it('is idempotent, because the expiry job may be retried', async () => {
    const session = await provider.createCheckoutSession(context, input());

    await provider.expireCheckoutSession(context, session.sessionId);
    await expect(provider.expireCheckoutSession(context, session.sessionId)).resolves.toEqual({
      outcome: 'EXPIRED',
    });
  });

  it('surfaces an unknown session rather than inventing one', async () => {
    await expect(provider.expireCheckoutSession(context, 'cs_fake_missing')).rejects.toThrow(
      /No such checkout session/,
    );
  });
});

describe('markPaid', () => {
  it('produces a payment intent, a charge and a method type', async () => {
    const session = await provider.createCheckoutSession(context, input());
    provider.markPaid(session.sessionId);

    const retrieved = await provider.retrieveCheckoutSession(context, session.sessionId);
    expect(retrieved.status).toBe('complete');
    expect(retrieved.paymentStatus).toBe('paid');
    expect(retrieved.paymentIntentId).toMatch(/^pi_fake_/);
    expect(retrieved.chargeId).toMatch(/^ch_fake_/);
    expect(retrieved.paymentMethodType).toBe('card');
  });

  it('refuses chargeIdFor on an unpaid session, rather than returning undefined', async () => {
    const session = await provider.createCheckoutSession(context, input());
    expect(() => provider.chargeIdFor(session.sessionId)).toThrow(/markPaid/);
  });
});

describe('failNextWith', () => {
  it('fails exactly the next call, then behaves normally', async () => {
    provider.failNextWith(new Error('ECONNRESET'));

    await expect(provider.createCheckoutSession(context, input())).rejects.toThrow('ECONNRESET');
    // The retry path must be reachable, which needs the failure to be one-shot.
    await expect(provider.createCheckoutSession(context, input())).resolves.toBeDefined();
  });

  it('can fail an expire call, which is how the saga retry is exercised', async () => {
    const session = await provider.createCheckoutSession(context, input());
    provider.failNextWith(new Error('ETIMEDOUT'));

    await expect(provider.expireCheckoutSession(context, session.sessionId)).rejects.toThrow(
      'ETIMEDOUT',
    );
    // The session is untouched, so the slot stays blocked.
    expect((await provider.retrieveCheckoutSession(context, session.sessionId)).status).toBe(
      'open',
    );
  });
});

describe('createRefund', () => {
  async function paidSession(): Promise<string> {
    const session = await provider.createCheckoutSession(context, input());
    provider.markPaid(session.sessionId);
    return provider.chargeIdFor(session.sessionId);
  }

  it('refunds part of a charge', async () => {
    const chargeId = await paidSession();

    const refund = await provider.createRefund(context, {
      chargeId,
      amount: Money.fromCents(2000),
      idempotencyKey: 'rf-1',
    });

    expect(refund.refundId).toMatch(/^re_fake_/);
    expect(refund.status).toBe('succeeded');
    expect(refund.amountCents).toBe(2000);
  });

  it('replays the same refund for a repeated key, so a retry cannot double-refund', async () => {
    const chargeId = await paidSession();
    const args = { chargeId, amount: Money.fromCents(2000), idempotencyKey: 'rf-1' };

    const first = await provider.createRefund(context, args);
    const second = await provider.createRefund(context, args);

    expect(second.refundId).toBe(first.refundId);
    expect(provider.refundCalls()).toHaveLength(1);
  });

  it('rejects a refund key reused with a different amount', async () => {
    const chargeId = await paidSession();
    await provider.createRefund(context, {
      chargeId,
      amount: Money.fromCents(2000),
      idempotencyKey: 'rf-1',
    });

    await expect(
      provider.createRefund(context, {
        chargeId,
        amount: Money.fromCents(2100),
        idempotencyKey: 'rf-1',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('rejects a refund key reused with a different reason', async () => {
    const chargeId = await paidSession();
    await provider.createRefund(context, {
      chargeId,
      amount: Money.fromCents(2000),
      idempotencyKey: 'rf-1',
      reason: 'first reason',
    });

    await expect(
      provider.createRefund(context, {
        chargeId,
        amount: Money.fromCents(2000),
        idempotencyKey: 'rf-1',
        reason: 'changed reason',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('refuses more than the refundable remainder', async () => {
    const chargeId = await paidSession();

    await provider.createRefund(context, {
      chargeId,
      amount: Money.fromCents(4000),
      idempotencyKey: 'rf-1',
    });

    await expect(
      provider.createRefund(context, {
        chargeId,
        amount: Money.fromCents(1000),
        idempotencyKey: 'rf-2',
      }),
    ).rejects.toThrow(/exceeds/i);
  });

  it('allows several partial refunds up to the full amount', async () => {
    const chargeId = await paidSession();

    for (const [index, cents] of [2000, 2000, 500].entries()) {
      await expect(
        provider.createRefund(context, {
          chargeId,
          amount: Money.fromCents(cents),
          idempotencyKey: `rf-${String(index)}`,
        }),
      ).resolves.toBeDefined();
    }

    await expect(
      provider.createRefund(context, {
        chargeId,
        amount: Money.fromCents(1),
        idempotencyKey: 'rf-over',
      }),
    ).rejects.toThrow(/exceeds/i);
  });

  it('refuses a charge that does not exist', async () => {
    await expect(
      provider.createRefund(context, {
        chargeId: 'ch_fake_missing',
        amount: Money.fromCents(100),
        idempotencyKey: 'rf-1',
      }),
    ).rejects.toThrow(/No charge/);
  });
});

describe('verifyWebhook', () => {
  const rawEvent = (overrides: Record<string, unknown> = {}): Buffer =>
    Buffer.from(
      JSON.stringify({
        id: 'evt_fake_1',
        type: 'checkout.session.completed',
        api_version: '2025-06-30.basil',
        data: { object: {} },
        ...overrides,
      }),
    );

  it('accepts a correctly signed body and returns the event', () => {
    const raw = rawEvent();
    const event = provider.verifyWebhook(raw, provider.signatureFor(raw));

    expect(event.id).toBe('evt_fake_1');
    expect(event.type).toBe('checkout.session.completed');
    expect(event.apiVersion).toBe('2025-06-30.basil');
  });

  it('rejects a wrong signature', () => {
    const raw = rawEvent();
    expect(() => provider.verifyWebhook(raw, 'deadbeef')).toThrow(/signature/i);
  });

  it('rejects a signature computed over different bytes', () => {
    // Re-serialising a parsed body changes the bytes, which is exactly why the
    // port takes a Buffer.
    const signature = provider.signatureFor(rawEvent());
    expect(() => provider.verifyWebhook(rawEvent({ id: 'evt_fake_2' }), signature)).toThrow(
      /signature/i,
    );
  });

  it('rejects a signed body that is not a recognisable event', () => {
    const raw = Buffer.from(JSON.stringify({ hello: 'world' }));
    expect(() => provider.verifyWebhook(raw, provider.signatureFor(raw))).toThrow(/id or a type/);
  });
});

describe('the Connect seam', () => {
  it('accepts a context whose stripeAccountId is set, without behaving differently', async () => {
    // Phase 1 always passes undefined. The signature already carries the field so
    // the Connect migration is a backfill rather than a change to every call site.
    const connect: PaymentAccountContext = { organizationId: 'org-1', stripeAccountId: 'acct_123' };

    const session = await provider.createCheckoutSession(connect, input());
    expect(session.sessionId).toMatch(/^cs_fake_/);
  });
});

describe('call recording', () => {
  it('reports method order, so a test can assert a sequence', async () => {
    const session = await provider.createCheckoutSession(context, input());
    provider.markPaid(session.sessionId);
    await provider.expireCheckoutSession(context, session.sessionId);

    expect(provider.callOrder()).toEqual(['createCheckoutSession', 'expireCheckoutSession']);
  });

  it('reset clears everything', async () => {
    await provider.createCheckoutSession(context, input());
    provider.reset();

    expect(provider.sessions()).toEqual([]);
    expect(provider.callOrder()).toEqual([]);
  });
});
