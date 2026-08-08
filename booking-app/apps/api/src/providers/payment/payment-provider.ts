import { AppError } from '../../common/errors/app-error.js';
import { PaymentsMode } from '../../prisma/client.js';

import type { Money } from '../../domain/money/money.js';
import type { Locale } from '@shape-and-flow/booking-contracts';

/**
 * The payment port.
 *
 * Every method takes a `PaymentAccountContext` first. `stripeAccountId` is the
 * connected account the call addresses, or undefined for the platform account, and
 * the Stripe adapter turns it into the `stripeAccount` request option.
 *
 * Which of the two a call gets depends on what the call does, and the distinction
 * is the point of the two helpers below. Creating something asks the organization
 * (`accountForNewCharge`); touching something that already exists asks the row it
 * was recorded on (`accountOfRecordedPayment`). A Stripe object belongs to the
 * account that created it for good, so re-deriving the account from live readiness
 * is how an expiry or a refund ends up aimed at an account the object was never on.
 */

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

export interface PaymentAccountContext {
  organizationId: string;
  /** The connected account, or undefined for the platform account. */
  stripeAccountId?: string | undefined;
}

/**
 * The account a **new** charge for this organization must be created on.
 *
 * `PLATFORM` is the pre-Connect arrangement and takes the platform account. A
 * `CONNECT` organization takes its own account and nothing else: presence of
 * `stripeAccountId` alone is not enough, because the onboarding-link endpoint
 * persists it the moment the Express account is *created*, before onboarding
 * completes. Until Stripe's own `account.updated` says `charges_enabled`, there is
 * no account that can take the money — and quietly falling back to the platform
 * account would take it onto the wrong books, so this refuses instead.
 */
export function accountForNewCharge(organization: {
  paymentsMode: PaymentsMode;
  stripeAccountId: string | null;
  stripeChargesEnabled: boolean;
}): string | undefined {
  if (organization.paymentsMode === PaymentsMode.PLATFORM) return undefined;

  if (organization.stripeAccountId === null || !organization.stripeChargesEnabled) {
    throw new AppError('ORGANIZATION_ONBOARDING_INCOMPLETE', {
      message: 'This organizer has not finished setting up payments yet.',
    });
  }

  return organization.stripeAccountId;
}

/**
 * The account an **already created** Stripe object lives on.
 *
 * Read from the payment row, not from the organization: the row recorded which
 * account the Checkout Session was opened on, and expiring, retrieving or refunding
 * it has to address that same account however the organization's readiness has moved
 * since. Null means the platform account.
 */
export function accountOfRecordedPayment(payment: {
  stripeAccountId: string | null;
}): string | undefined {
  return payment.stripeAccountId ?? undefined;
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

/**
 * Which signing key a webhook delivery must verify against.
 *
 * Stripe treats the platform's own events and its connected accounts' events as two
 * destinations, each with its own endpoint secret. One secret cannot verify both, so
 * the endpoint the delivery arrived on decides which key is tried — and a delivery
 * that reaches the wrong endpoint fails its signature rather than being accepted by a
 * key it was not signed with.
 */
export type WebhookDestination = 'platform' | 'connect';

/** A verified inbound provider event, before any interpretation. */
export interface ProviderEvent {
  id: string;
  type: string;
  apiVersion?: string | undefined;
  /**
   * The connected account the event is about, when it came from one.
   *
   * Undefined for a platform event. This is the only place the originating account
   * is available, so anything that has to address that account later — a payment row
   * created straight from an event, for instance — has to take it from here.
   */
  account?: string | undefined;
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
  verifyWebhook(rawBody: Buffer, signature: string, destination: WebhookDestination): ProviderEvent;
}
