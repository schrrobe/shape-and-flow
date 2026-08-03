import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import { Money } from '../../domain/money/money.js';
import { FixedClock } from '../../domain/time/clock.js';

import {
  STRIPE_API_VERSION,
  STRIPE_MIN_SESSION_TTL_MINUTES,
  StripePaymentProvider,
  toPaymentStatus,
  toRefundStatus,
} from './stripe-payment.provider.js';
import {
  isNoSuchSessionError,
  isRetryableStripeError,
  isSessionAlreadyCompleteError,
} from './stripe.errors.js';

import type { CreateCheckoutSessionInput, PaymentAccountContext } from './payment-provider.js';

/**
 * The SDK is stubbed at the client boundary on purpose. What can go wrong in an
 * adapter is sending the wrong shape or misreading the response, and neither needs
 * the network to prove.
 *
 * The stubs are *typed* with Stripe's own parameter types rather than accepting
 * `any`, so sending a field Stripe does not have is a compile error here — which is
 * a stronger guarantee than any assertion in the body.
 */

const NOW = new Date('2026-08-14T06:00:00.000Z');
const context: PaymentAccountContext = { organizationId: 'org-1', stripeAccountId: undefined };
const connectContext: PaymentAccountContext = {
  organizationId: 'org-1',
  stripeAccountId: 'acct_123',
};

const input = (
  overrides: Partial<CreateCheckoutSessionInput> = {},
): CreateCheckoutSessionInput => ({
  bookingId: 'bk-1',
  clientReferenceId: 'bk-1',
  amount: Money.fromCents(4500),
  description: 'Facial Massage 30 min',
  customerEmail: 'anna@example.com',
  successUrl: 'https://booking.example.com/booking/success',
  cancelUrl: 'https://booking.example.com/booking/canceled',
  locale: 'de',
  // The reservation deadline: five minutes out.
  expiresAt: new Date('2026-08-14T06:05:00.000Z'),
  ...overrides,
});

type CreateFn = (
  params: Stripe.Checkout.SessionCreateParams,
  options?: Stripe.RequestOptions,
) => Promise<Stripe.Checkout.Session>;
type ExpireFn = (
  id: string,
  params?: Stripe.Checkout.SessionExpireParams,
  options?: Stripe.RequestOptions,
) => Promise<Stripe.Checkout.Session>;
type RetrieveFn = (
  id: string,
  params?: Stripe.Checkout.SessionRetrieveParams,
  options?: Stripe.RequestOptions,
) => Promise<Stripe.Checkout.Session>;
type RefundFn = (
  params: Stripe.RefundCreateParams,
  options?: Stripe.RequestOptions,
) => Promise<Stripe.Refund>;
type ConstructEventFn = (
  body: Buffer,
  signature: string,
  secret: string,
  tolerance?: number,
) => Stripe.Event;

/** Partial fixtures: the adapter reads a handful of fields, not the whole object. */
const asSession = (fields: Partial<Stripe.Checkout.Session>): Stripe.Checkout.Session =>
  fields as Stripe.Checkout.Session;

const OPEN_SESSION = asSession({
  id: 'cs_test_1',
  url: 'https://checkout.stripe.com/c/pay/cs_test_1',
  expires_at: Math.floor(Date.parse('2026-08-14T06:30:00.000Z') / 1000),
});

const PAID_SESSION = asSession({
  id: 'cs_test_1',
  status: 'complete',
  payment_status: 'paid',
  amount_total: 4500,
  currency: 'eur',
  client_reference_id: 'bk-1',
  payment_intent: {
    id: 'pi_test_1',
    latest_charge: { id: 'ch_test_1' },
  } as unknown as Stripe.PaymentIntent,
});

function build(
  overrides: {
    create?: ReturnType<typeof vi.fn<CreateFn>>;
    expire?: ReturnType<typeof vi.fn<ExpireFn>>;
    retrieve?: ReturnType<typeof vi.fn<RetrieveFn>>;
    refundCreate?: ReturnType<typeof vi.fn<RefundFn>>;
    constructEvent?: ReturnType<typeof vi.fn<ConstructEventFn>>;
  } = {},
) {
  const create = overrides.create ?? vi.fn<CreateFn>().mockResolvedValue(OPEN_SESSION);
  const expire =
    overrides.expire ??
    vi.fn<ExpireFn>().mockResolvedValue(asSession({ id: 'cs_test_1', status: 'expired' }));
  const retrieve = overrides.retrieve ?? vi.fn<RetrieveFn>().mockResolvedValue(PAID_SESSION);
  const refundCreate =
    overrides.refundCreate ??
    vi
      .fn<RefundFn>()
      .mockResolvedValue({ id: 're_test_1', status: 'succeeded', amount: 2000 } as Stripe.Refund);
  const constructEvent = overrides.constructEvent ?? vi.fn<ConstructEventFn>();

  const stripe = {
    checkout: { sessions: { create, expire, retrieve } },
    refunds: { create: refundCreate },
    webhooks: { constructEvent },
  } as unknown as Stripe;

  const provider = new StripePaymentProvider(stripe, new FixedClock(NOW), {
    webhookSecret: 'whsec_test',
  });

  return { provider, create, expire, retrieve, refundCreate, constructEvent };
}

/** The arguments of the most recent call, or a clear failure. */
function lastCallOf<Args extends unknown[]>(stub: { mock: { calls: Args[] } }): Args {
  const call = stub.mock.calls.at(-1);
  if (!call) throw new Error('stub was never called');
  return call;
}

describe('the pinned API version', () => {
  it('is the version this adapter was reviewed against', () => {
    // Bumping the SDK changes this and fails here, which is the point: the webhook
    // payload assumptions have to be re-read, not silently inherited.
    expect(STRIPE_API_VERSION).toBe('2026-07-29.dahlia');
  });
});

describe('createCheckoutSession', () => {
  it('sends card-only synchronous methods', async () => {
    const { provider, create } = build();
    await provider.createCheckoutSession(context, input());

    const [params] = lastCallOf(create);
    expect(params.mode).toBe('payment');
    // SEPA and Klarna settle in days, which a five-minute reservation cannot honour.
    expect(params.payment_method_types).toEqual(['card']);
  });

  it('sends integer minor units and a lowercase currency', async () => {
    const { provider, create } = build();
    await provider.createCheckoutSession(context, input({ amount: Money.fromCents(7900) }));

    const [params] = lastCallOf(create);
    const item = params.line_items?.[0];
    expect(item?.quantity).toBe(1);
    expect(item?.price_data?.unit_amount).toBe(7900);
    expect(item?.price_data?.currency).toBe('eur');
    expect(item?.price_data?.product_data?.name).toBe('Facial Massage 30 min');
  });

  it('sets client_reference_id and metadata on both the session and the intent', async () => {
    const { provider, create } = build();
    await provider.createCheckoutSession(context, input());

    const [params] = lastCallOf(create);
    // The fallback correlation path when the session id never reached the database.
    expect(params.client_reference_id).toBe('bk-1');
    expect(params.metadata).toEqual({ bookingId: 'bk-1', organizationId: 'org-1' });
    // Repeated on the intent so the charge itself carries the booking id, which is
    // what a refund or a dispute is investigated from.
    expect(params.payment_intent_data?.metadata).toEqual({
      bookingId: 'bk-1',
      organizationId: 'org-1',
    });
  });

  it('passes the locale, the redirect urls and the email through unchanged', async () => {
    const { provider, create } = build();
    await provider.createCheckoutSession(context, input({ locale: 'en' }));

    const [params] = lastCallOf(create);
    expect(params.locale).toBe('en');
    expect(params.success_url).toBe('https://booking.example.com/booking/success');
    expect(params.cancel_url).toBe('https://booking.example.com/booking/canceled');
    expect(params.customer_email).toBe('anna@example.com');
  });

  it('clamps expires_at to Stripe minimum rather than sending a rejected value', async () => {
    const { provider, create } = build();
    await provider.createCheckoutSession(context, input());

    // The reservation deadline is five minutes out, but Stripe accepts no less than
    // thirty. Our own expiry saga enforces the five; this is only a backstop.
    const [params] = lastCallOf(create);
    expect(params.expires_at).toBe(
      Math.ceil((NOW.getTime() + STRIPE_MIN_SESSION_TTL_MINUTES * 60_000) / 1000),
    );
  });

  it('honours a later deadline when one is given', async () => {
    const { provider, create } = build();
    const later = new Date('2026-08-14T09:00:00.000Z');
    await provider.createCheckoutSession(context, input({ expiresAt: later }));

    expect(lastCallOf(create)[0].expires_at).toBe(Math.ceil(later.getTime() / 1000));
  });

  it('forwards an idempotency key as a request option', async () => {
    const { provider, create } = build();
    await provider.createCheckoutSession(context, input({ idempotencyKey: 'req-1' }));

    expect(lastCallOf(create)[1]).toMatchObject({ idempotencyKey: 'req-1' });
  });

  it('returns the session id, url and the expiry Stripe actually set', async () => {
    const { provider } = build();
    const result = await provider.createCheckoutSession(context, input());

    expect(result.sessionId).toBe('cs_test_1');
    expect(result.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(result.expiresAt.toISOString()).toBe('2026-08-14T06:30:00.000Z');
  });

  it('treats a session without a url as a fault, not a result', async () => {
    const { provider } = build({
      create: vi
        .fn<CreateFn>()
        .mockResolvedValue(asSession({ id: 'cs_test_1', url: null, expires_at: 0 })),
    });

    // The caller has nowhere to send the customer, so this cannot be returned.
    await expect(provider.createCheckoutSession(context, input())).rejects.toThrow(
      /without a redirect URL/,
    );
  });
});

describe('expireCheckoutSession — the two branches the saga depends on', () => {
  const alreadyComplete = (message: string): Stripe.errors.StripeInvalidRequestError =>
    new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message });

  it('maps a successful expire to EXPIRED', async () => {
    const { provider } = build();
    await expect(provider.expireCheckoutSession(context, 'cs_test_1')).resolves.toEqual({
      outcome: 'EXPIRED',
    });
  });

  it('maps "already complete" to ALREADY_COMPLETE with the real payment status', async () => {
    const { provider, retrieve } = build({
      expire: vi
        .fn<ExpireFn>()
        .mockRejectedValue(
          alreadyComplete('You cannot expire a Checkout Session that is already complete.'),
        ),
    });

    await expect(provider.expireCheckoutSession(context, 'cs_test_1')).resolves.toEqual({
      outcome: 'ALREADY_COMPLETE',
      paymentStatus: 'paid',
    });
    // It looks the status up rather than assuming paid.
    expect(retrieve).toHaveBeenCalled();
  });

  it('reports unpaid when the completed session was not actually paid', async () => {
    const { provider } = build({
      expire: vi
        .fn<ExpireFn>()
        .mockRejectedValue(alreadyComplete('Session has already been completed.')),
      retrieve: vi.fn<RetrieveFn>().mockResolvedValue(
        asSession({
          id: 'cs_test_1',
          status: 'complete',
          payment_status: 'unpaid',
          amount_total: 4500,
          currency: 'eur',
        }),
      ),
    });

    await expect(provider.expireCheckoutSession(context, 'cs_test_1')).resolves.toEqual({
      outcome: 'ALREADY_COMPLETE',
      paymentStatus: 'unpaid',
    });
  });

  it('rethrows a connection error so the job retries and the slot stays blocked', async () => {
    const { provider, retrieve } = build({
      expire: vi
        .fn<ExpireFn>()
        .mockRejectedValue(new Stripe.errors.StripeConnectionError({ message: 'socket hang up' })),
    });

    await expect(provider.expireCheckoutSession(context, 'cs_test_1')).rejects.toThrow(
      'socket hang up',
    );
    // It must not fall back to a retrieve and invent an outcome.
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('rethrows an unrelated invalid-request error rather than guessing', async () => {
    const { provider } = build({
      expire: vi
        .fn<ExpireFn>()
        .mockRejectedValue(alreadyComplete('No such checkout.session: cs_test_missing')),
    });

    await expect(provider.expireCheckoutSession(context, 'cs_test_1')).rejects.toThrow(/No such/);
  });
});

describe('retrieveCheckoutSession', () => {
  it('flattens the expanded intent and charge', async () => {
    const { provider } = build();
    await expect(provider.retrieveCheckoutSession(context, 'cs_test_1')).resolves.toMatchObject({
      sessionId: 'cs_test_1',
      status: 'complete',
      paymentStatus: 'paid',
      paymentIntentId: 'pi_test_1',
      chargeId: 'ch_test_1',
      amountTotalCents: 4500,
      currency: 'EUR',
      clientReferenceId: 'bk-1',
    });
  });

  it('expands what it needs, so a second round trip is not required', async () => {
    const { provider, retrieve } = build();
    await provider.retrieveCheckoutSession(context, 'cs_test_1');

    expect(lastCallOf(retrieve)[1]).toMatchObject({
      expand: ['payment_intent', 'payment_intent.latest_charge'],
    });
  });

  it('copes with an unexpanded intent reference', async () => {
    const { provider } = build({
      retrieve: vi.fn<RetrieveFn>().mockResolvedValue(
        asSession({
          id: 'cs_test_1',
          status: 'complete',
          payment_status: 'paid',
          amount_total: 4500,
          currency: 'eur',
          payment_intent: 'pi_test_9',
        }),
      ),
    });

    const session = await provider.retrieveCheckoutSession(context, 'cs_test_1');
    expect(session.paymentIntentId).toBe('pi_test_9');
    expect(session.chargeId).toBeUndefined();
  });

  it('copes with an open, unpaid session that has no intent at all', async () => {
    const { provider } = build({
      retrieve: vi.fn<RetrieveFn>().mockResolvedValue(
        asSession({
          id: 'cs_test_1',
          status: 'open',
          payment_status: 'unpaid',
          amount_total: 4500,
          currency: 'eur',
        }),
      ),
    });

    const session = await provider.retrieveCheckoutSession(context, 'cs_test_1');
    expect(session).toMatchObject({ status: 'open', paymentStatus: 'unpaid' });
    expect(session.paymentIntentId).toBeUndefined();
  });
});

describe('createRefund', () => {
  it('sends the charge and integer amount, and passes the idempotency key to Stripe', async () => {
    const { provider, refundCreate } = build();

    const result = await provider.createRefund(context, {
      chargeId: 'ch_test_1',
      amount: Money.fromCents(2000),
      idempotencyKey: 'rf-1',
    });

    const [params, options] = lastCallOf(refundCreate);
    expect(params).toMatchObject({ charge: 'ch_test_1', amount: 2000 });
    // Stripe's key is the local Refund row's key, which is what makes a retry after
    // a lost response unable to refund twice.
    expect(options).toMatchObject({ idempotencyKey: 'rf-1' });
    expect(result).toEqual({ refundId: 're_test_1', status: 'succeeded', amountCents: 2000 });
  });

  it('always sends the idempotency key as metadata, with or without a reason', async () => {
    const { provider, refundCreate } = build();
    await provider.createRefund(context, {
      chargeId: 'ch_test_1',
      amount: Money.fromCents(2000),
      idempotencyKey: 'rf-1',
    });

    // Not optional, and not only for the logs: `refund.*` webhooks echo the metadata back,
    // and it is the only handle settlement has when an event arrives before the response
    // that stores Stripe's own refund id.
    expect(lastCallOf(refundCreate)[0]).toMatchObject({ metadata: { idempotencyKey: 'rf-1' } });
    expect('reason' in (lastCallOf(refundCreate)[0].metadata as object)).toBe(false);
  });
});

describe('verifyWebhook', () => {
  it('verifies the raw body with a 300-second tolerance', () => {
    const { provider, constructEvent } = build({
      constructEvent: vi.fn<ConstructEventFn>().mockReturnValue({
        id: 'evt_1',
        type: 'checkout.session.completed',
        api_version: '2026-07-29.dahlia',
      } as Stripe.Event),
    });

    const raw = Buffer.from('{"id":"evt_1"}');
    const event = provider.verifyWebhook(raw, 'sig');

    expect(constructEvent).toHaveBeenCalledWith(raw, 'sig', 'whsec_test', 300);
    expect(event).toMatchObject({ id: 'evt_1', type: 'checkout.session.completed' });
  });

  it('turns a bad signature into a 400, not a 500', () => {
    const { provider } = build({
      constructEvent: vi.fn<ConstructEventFn>(() => {
        throw new Stripe.errors.StripeSignatureVerificationError('sig', '{}', {
          message: 'No signatures found matching the expected signature for payload.',
        });
      }),
    });

    // A 500 would make Stripe retry a request that can never succeed.
    expect(() => provider.verifyWebhook(Buffer.from('{}'), 'bad')).toThrow(
      expect.objectContaining({ code: 'UNAUTHENTICATED', status: 400 }),
    );
  });
});

describe('the Connect seam', () => {
  it('sends no account option at all while stripeAccountId is undefined', async () => {
    const { provider, create } = build();
    await provider.createCheckoutSession(context, input());

    // Inert, not merely unused.
    const options = lastCallOf(create)[1] ?? {};
    expect(options).not.toHaveProperty('stripeContext');
    expect(options).not.toHaveProperty('stripeAccount');
  });

  it('sends stripeContext once an account id exists', async () => {
    const { provider, create } = build();
    await provider.createCheckoutSession(connectContext, input());

    // stripeContext rather than stripeAccount: stripe-node documents the latter as
    // on its way out and identical for now.
    expect(lastCallOf(create)[1]).toMatchObject({ stripeContext: 'acct_123' });
  });

  it('carries the account through every call, not only session creation', async () => {
    const { provider, expire, retrieve, refundCreate } = build();

    await provider.expireCheckoutSession(connectContext, 'cs_test_1');
    await provider.retrieveCheckoutSession(connectContext, 'cs_test_1');
    await provider.createRefund(connectContext, {
      chargeId: 'ch_test_1',
      amount: Money.fromCents(100),
      idempotencyKey: 'rf-1',
    });

    expect(lastCallOf(expire)[2]).toMatchObject({ stripeContext: 'acct_123' });
    expect(lastCallOf(retrieve)[2]).toMatchObject({ stripeContext: 'acct_123' });
    expect(lastCallOf(refundCreate)[1]).toMatchObject({ stripeContext: 'acct_123' });
  });
});

describe('error classification', () => {
  const invalidRequest = (message: string): Stripe.errors.StripeInvalidRequestError =>
    new Stripe.errors.StripeInvalidRequestError({ type: 'invalid_request_error', message });

  it('recognises the already-complete wording observed today', () => {
    for (const message of [
      'You cannot expire a Checkout Session that is already complete.',
      'Session has already been completed.',
    ]) {
      expect(isSessionAlreadyCompleteError(invalidRequest(message)), message).toBe(true);
    }
  });

  it('does not mistake other invalid-request errors for it', () => {
    expect(isSessionAlreadyCompleteError(invalidRequest('No such checkout.session: cs_1'))).toBe(
      false,
    );
    expect(isSessionAlreadyCompleteError(new Error('already complete'))).toBe(false);
  });

  it('recognises a missing session', () => {
    expect(isNoSuchSessionError(invalidRequest('No such checkout.session: cs_1'))).toBe(true);
    expect(isNoSuchSessionError(invalidRequest('something else'))).toBe(false);
  });

  it('treats connection, rate-limit and Stripe 5xx errors as retryable', () => {
    expect(
      isRetryableStripeError(
        new Stripe.errors.StripeConnectionError({ message: 'socket hang up' }),
      ),
    ).toBe(true);
    expect(
      isRetryableStripeError(
        new Stripe.errors.StripeRateLimitError({ type: 'rate_limit_error', message: 'slow down' }),
      ),
    ).toBe(true);
    expect(
      isRetryableStripeError(
        new Stripe.errors.StripeAPIError({ type: 'api_error', message: 'internal' }),
      ),
    ).toBe(true);
    expect(isRetryableStripeError(new Error('ECONNRESET'))).toBe(true);
  });

  it('treats an unrecognised or definitive error as permanent', () => {
    // A whitelist, so a new Stripe error class cannot cause an endless retry loop
    // against a charge that has already moved money.
    expect(isRetryableStripeError(invalidRequest('charge_already_refunded'))).toBe(false);
    expect(
      isRetryableStripeError(
        new Stripe.errors.StripeCardError({ type: 'card_error', message: 'declined' }),
      ),
    ).toBe(false);
    expect(isRetryableStripeError(new Error('something odd'))).toBe(false);
  });
});

describe('narrowing Stripe open unions', () => {
  it('maps the payment statuses it recognises', () => {
    expect(toPaymentStatus('paid')).toBe('paid');
    expect(toPaymentStatus('unpaid')).toBe('unpaid');
    expect(toPaymentStatus('no_payment_required')).toBe('no_payment_required');
  });

  it('never reads an unrecognised payment status as paid', () => {
    // Stripe types payment_status as an open union, so it can return something
    // this adapter has never seen. Treating that as paid would confirm a booking
    // nobody paid for; treating it as unpaid at worst expires a reservation that a
    // later webhook can still confirm.
    for (const value of ['partially_paid', 'PAID', '', 'something_new']) {
      expect(toPaymentStatus(value), value).toBe('unpaid');
    }
  });

  it('maps the refund statuses it recognises', () => {
    expect(toRefundStatus('succeeded')).toBe('succeeded');
    expect(toRefundStatus('failed')).toBe('failed');
    expect(toRefundStatus('canceled')).toBe('canceled');
    expect(toRefundStatus('pending')).toBe('pending');
  });

  it('never reads an unrecognised or missing refund status as succeeded', () => {
    // Claiming a refund settled when it has not would tell the customer their money
    // is on the way and stop the reconciler chasing it.
    for (const value of [null, 'requires_action', 'SUCCEEDED', '']) {
      expect(toRefundStatus(value), String(value)).toBe('pending');
    }
  });
});
