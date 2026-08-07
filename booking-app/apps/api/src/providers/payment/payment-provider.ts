import type { Money } from '../../domain/money/money.js';
import type { Locale } from '@shape-and-flow/booking-contracts';

/**
 * The payment port.
 *
 * Every method takes a `PaymentAccountContext` first. In Phase 1 its
 * `stripeAccountId` is always undefined and the Stripe adapter sends no
 * `stripeAccount` request option — the seam is present and inert, so the Connect
 * migration is a backfill plus one branch rather than a change to every signature.
 * An integration test asserts the inertness rather than trusting it.
 */

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

export interface PaymentAccountContext {
  organizationId: string;
  /** Always undefined in Phase 1. See §12 of the implementation plan. */
  stripeAccountId?: string | undefined;
}

/**
 * The Stripe Connect account to route to, or `undefined` to charge the platform account.
 *
 * Presence of `stripeAccountId` alone is not enough: the onboarding-link retry endpoint
 * persists it the moment a Stripe Express account is *created*, before onboarding
 * completes. Routing must wait for Stripe's own `account.updated` confirmation
 * (`stripeChargesEnabled`), or an organization mid-onboarding would have its checkout,
 * expiry, and refund calls silently rerouted to an account that cannot yet take charges.
 */
export function connectAccountId(organization: {
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
}): string | undefined {
  return organization.stripeAccountId !== null && organization.stripeChargesEnabled
    ? organization.stripeAccountId
    : undefined;
}

export interface CreateCheckoutSessionInput {
  bookingId: string;
  /**
   * Always set to the booking id. It is the fallback correlation path when a
   * session was created but the id never made it into the database — for
   * instance if the process died between the two.
   */
  clientReferenceId: string;
  amount: Money;
  description: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  locale: Locale;
  /** The reservation deadline. The session must die no later than this. */
  expiresAt: Date;
  /** Makes a retried session creation return the first session. */
  idempotencyKey?: string | undefined;
}

export interface CheckoutSessionResult {
  sessionId: string;
  url: string;
  expiresAt: Date;
}

export type PaymentStatusValue = 'paid' | 'unpaid' | 'no_payment_required';
export type CheckoutSessionStatus = 'open' | 'complete' | 'expired';

/**
 * The two outcomes the expiry saga branches on.
 *
 * `ALREADY_COMPLETE` is not an error: it means the customer paid while the
 * expiry job was in flight, and the booking must be confirmed rather than
 * released. Modelling it as a result instead of an exception is what keeps that
 * path explicit.
 */
export type ExpireResult =
  { outcome: 'EXPIRED' } | { outcome: 'ALREADY_COMPLETE'; paymentStatus: PaymentStatusValue };

export interface RetrievedSession {
  sessionId: string;
  status: CheckoutSessionStatus;
  paymentStatus: PaymentStatusValue;
  paymentIntentId?: string | undefined;
  chargeId?: string | undefined;
  /** Compared against the booking's price snapshot before confirming. */
  amountTotalCents: number;
  currency: string;
  paymentMethodType?: string | undefined;
  clientReferenceId?: string | undefined;
}

export interface CreateRefundInput {
  chargeId: string;
  amount: Money;
  /**
   * Passed to the provider as *its* idempotency key, and stored on the local
   * Refund row before the call. That is what makes a retry after a lost response
   * unable to refund twice.
   */
  idempotencyKey: string;
  reason?: string | undefined;
}

export type RefundStatusValue = 'succeeded' | 'pending' | 'failed' | 'canceled';

export interface RefundResult {
  refundId: string;
  status: RefundStatusValue;
  amountCents: number;
}

/** A verified inbound provider event, before any interpretation. */
export interface ProviderEvent {
  id: string;
  type: string;
  apiVersion?: string | undefined;
  payload: unknown;
}

export interface PaymentProvider {
  createCheckoutSession(
    context: PaymentAccountContext,
    input: CreateCheckoutSessionInput,
  ): Promise<CheckoutSessionResult>;

  expireCheckoutSession(context: PaymentAccountContext, sessionId: string): Promise<ExpireResult>;

  retrieveCheckoutSession(
    context: PaymentAccountContext,
    sessionId: string,
  ): Promise<RetrievedSession>;

  createRefund(context: PaymentAccountContext, input: CreateRefundInput): Promise<RefundResult>;

  /**
   * Verify a signature over the **raw** body and return the event.
   *
   * Takes a Buffer, not a parsed object, because any re-serialisation changes the
   * bytes and invalidates the signature.
   */
  verifyWebhook(rawBody: Buffer, signature: string): ProviderEvent;
}
