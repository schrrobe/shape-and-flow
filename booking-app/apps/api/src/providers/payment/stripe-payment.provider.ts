import Stripe from 'stripe';

import { AppError } from '../../common/errors/app-error.js';

import { isSessionAlreadyCompleteError } from './stripe.errors.js';

import type {
  CheckoutSessionResult,
  PaymentStatusValue,
  RefundStatusValue,
  CreateCheckoutSessionInput,
  CreateRefundInput,
  ExpireResult,
  PaymentAccountContext,
  PaymentProvider,
  ProviderEvent,
  RefundResult,
  RetrievedSession,
} from './payment-provider.js';
import type { Clock } from '../../domain/time/clock.js';

/**
 * Stripe Checkout, hosted.
 *
 * The adapter's only job is translation, which is why the tests stub the SDK at
 * the client boundary rather than reaching the network: what can actually go wrong
 * here is sending the wrong shape or misreading the response.
 *
 * Card and wallets only. Asynchronous methods (SEPA, Klarna) fire
 * `checkout.session.completed` with `payment_status: 'unpaid'` and settle days
 * later, which a five-minute reservation cannot honour.
 */

/**
 * The API version this adapter was written against.
 *
 * Since stripe-node 22 the constructor's `apiVersion` is a *literal* type — only
 * the SDK's own pinned version typechecks — so this cannot drift silently by
 * configuration. It can still drift by upgrade, which is what
 * stripe-payment.provider.spec.ts asserts against: bumping the SDK fails a test
 * and forces someone to re-read the webhook payload assumptions.
 */
export const STRIPE_API_VERSION = Stripe.API_VERSION;

/** Stripe rejects `expires_at` closer than this. Documented, not guessed. */
export const STRIPE_MIN_SESSION_TTL_MINUTES = 30;

export interface StripePaymentProviderOptions {
  webhookSecret: string;
  /** Signature tolerance in seconds. */
  webhookToleranceSeconds?: number;
}

const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Narrow Stripe's payment status to the closed set the domain reasons about.
 *
 * Stripe types this as an *open* union — `'paid' | 'unpaid' |
 * 'no_payment_required' | (string & {})` — so it can return a value this adapter
 * has never seen. Asserting the type would let such a value flow through as if it
 * were understood, and the dangerous direction is obvious: an unrecognised status
 * must never be read as paid, because that would confirm a booking nobody paid
 * for. Anything unfamiliar is therefore `unpaid`, which at worst expires a
 * reservation that a later webhook can still confirm.
 */
export function toPaymentStatus(value: string): PaymentStatusValue {
  if (value === 'paid') return 'paid';
  if (value === 'no_payment_required') return 'no_payment_required';
  return 'unpaid';
}

/**
 * Narrow Stripe's refund status, with the same bias.
 *
 * An unrecognised status becomes `pending`, never `succeeded`: claiming a refund
 * settled when it has not would tell a customer their money is on the way and
 * stop the reconciler from chasing it.
 */
export function toRefundStatus(value: string | null): RefundStatusValue {
  switch (value) {
    case 'succeeded':
    case 'failed':
    case 'canceled':
      return value;
    default:
      return 'pending';
  }
}

export class StripePaymentProvider implements PaymentProvider {
  constructor(
    private readonly stripe: Stripe,
    private readonly clock: Clock,
    private readonly options: StripePaymentProviderOptions,
  ) {}

  async createCheckoutSession(
    context: PaymentAccountContext,
    input: CreateCheckoutSessionInput,
  ): Promise<CheckoutSessionResult> {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        // Synchronous methods only — see the note at the top of this file.
        payment_method_types: ['card'],
        // Set on every session so an event can still be correlated to a booking
        // when the session id never reached the database, for instance if the
        // process died between creating the session and storing it.
        client_reference_id: input.clientReferenceId,
        customer_email: input.customerEmail,
        locale: input.locale,
        expires_at: this.expiresAtEpochSeconds(input.expiresAt),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        line_items: [
          {
            quantity: 1,
            price_data: {
              // Stripe wants a lowercase ISO code and integer minor units.
              currency: input.amount.currency.toLowerCase(),
              unit_amount: input.amount.amountCents,
              product_data: { name: input.description },
            },
          },
        ],
        metadata: this.metadataFor(context, input.bookingId),
        // Repeated on the payment intent so the charge itself carries the booking
        // id, which is what a refund or a dispute is investigated from.
        payment_intent_data: { metadata: this.metadataFor(context, input.bookingId) },
      },
      this.requestOptions(context, input.idempotencyKey),
    );

    if (!session.url) {
      // Only happens for a mode Checkout does not host. Treated as a fault rather
      // than returned, because the caller has nowhere to send the customer.
      throw new AppError('STRIPE_SESSION_WITHOUT_URL', {
        message: `Stripe returned checkout session ${session.id} without a redirect URL.`,
      });
    }

    return {
      sessionId: session.id,
      url: session.url,
      expiresAt: new Date(session.expires_at * 1000),
    };
  }

  async expireCheckoutSession(
    context: PaymentAccountContext,
    sessionId: string,
  ): Promise<ExpireResult> {
    try {
      await this.stripe.checkout.sessions.expire(sessionId, {}, this.requestOptions(context));
      return { outcome: 'EXPIRED' };
    } catch (error) {
      // The customer paid while the expiry job was in flight. Not an error: the
      // booking must be confirmed and the slot kept.
      if (isSessionAlreadyCompleteError(error)) {
        const session = await this.retrieveCheckoutSession(context, sessionId);
        return { outcome: 'ALREADY_COMPLETE', paymentStatus: session.paymentStatus };
      }

      // Everything else propagates, so a network failure leaves the booking
      // EXPIRING and still blocking rather than releasing a slot that may be paid.
      throw error;
    }
  }

  async retrieveCheckoutSession(
    context: PaymentAccountContext,
    sessionId: string,
  ): Promise<RetrievedSession> {
    const session = await this.stripe.checkout.sessions.retrieve(
      sessionId,
      { expand: ['payment_intent', 'payment_intent.latest_charge'] },
      this.requestOptions(context),
    );

    const paymentIntent =
      typeof session.payment_intent === 'string' ? null : session.payment_intent;
    const latestCharge = paymentIntent
      ? typeof paymentIntent.latest_charge === 'string'
        ? null
        : paymentIntent.latest_charge
      : null;

    return {
      sessionId: session.id,
      status: session.status ?? 'open',
      paymentStatus: toPaymentStatus(session.payment_status),
      paymentIntentId:
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (paymentIntent?.id ?? undefined),
      chargeId: latestCharge?.id ?? undefined,
      // amount_total is null only for a session with no line items, which this
      // adapter never creates.
      amountTotalCents: session.amount_total ?? 0,
      currency: (session.currency ?? '').toUpperCase(),
      paymentMethodType: latestCharge?.payment_method_details?.type ?? undefined,
      clientReferenceId: session.client_reference_id ?? undefined,
    };
  }

  async createRefund(
    context: PaymentAccountContext,
    input: CreateRefundInput,
  ): Promise<RefundResult> {
    const refund = await this.stripe.refunds.create(
      {
        charge: input.chargeId,
        amount: input.amount.amountCents,
        metadata: {
          // Echoed back on every `refund.*` event, which is what lets settlement find the
          // local row when the event arrives before the response below has stored
          // Stripe's own id.
          idempotencyKey: input.idempotencyKey,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      },
      // Stripe's own idempotency key is the local Refund row's key, which is why a
      // retry after a lost response cannot produce a second refund.
      this.requestOptions(context, input.idempotencyKey),
    );

    return {
      refundId: refund.id,
      status: toRefundStatus(refund.status),
      amountCents: refund.amount,
    };
  }

  verifyWebhook(rawBody: Buffer, signature: string): ProviderEvent {
    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.options.webhookSecret,
        this.options.webhookToleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
      );
    } catch (error) {
      // A bad signature is a 400, never a 500: it is the caller's problem, and
      // returning 500 would make Stripe retry a request that can never succeed.
      throw new AppError('UNAUTHENTICATED', {
        status: 400,
        message: 'Invalid Stripe webhook signature.',
        cause: error,
      });
    }

    return {
      id: event.id,
      type: event.type,
      apiVersion: event.api_version ?? undefined,
      payload: event,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Build per-request options.
   *
   * The Connect branch is the whole seam: while `stripeAccountId` is undefined —
   * all of Phase 1 — no account option is sent at all, which a test asserts.
   * `stripeContext` rather than the older `stripeAccount`, because stripe-node
   * documents the latter as on its way out.
   */
  private requestOptions(
    context: PaymentAccountContext,
    idempotencyKey?: string,
  ): Stripe.RequestOptions {
    return {
      ...(context.stripeAccountId === undefined ? {} : { stripeContext: context.stripeAccountId }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };
  }

  private metadataFor(context: PaymentAccountContext, bookingId: string): Stripe.MetadataParam {
    // Written for investigation only. Nothing trusts provider metadata as the
    // tenant source — the organization is always derived from a persisted row.
    return { bookingId, organizationId: context.organizationId };
  }

  /**
   * Clamp `expires_at` to Stripe's documented minimum.
   *
   * Stripe accepts 30 minutes to 24 hours; our reservation deadline is five. The
   * plan assumed the two could be the same. They cannot, so the reservation
   * deadline is enforced by our own expiry saga calling `sessions.expire`, and
   * Stripe's `expires_at` is only a backstop for the case where the saga never
   * runs at all.
   */
  private expiresAtEpochSeconds(requested: Date): number {
    const earliest = this.clock.now().getTime() + STRIPE_MIN_SESSION_TTL_MINUTES * 60_000;
    return Math.ceil(Math.max(requested.getTime(), earliest) / 1000);
  }
}
