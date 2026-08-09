import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error.js';
import { Money } from '../../domain/money/money.js';

import { InMemoryFakePaymentStore } from './fake-payment.store.js';

import type {
  FakePaymentStore,
  FakeRefundRecord,
  FakeSessionRecord,
} from './fake-payment.store.js';
import type {
  CheckoutSessionResult,
  CreateCheckoutSessionInput,
  CreateRefundInput,
  ExpireResult,
  PaymentAccountContext,
  PaymentProvider,
  ProviderEvent,
  RefundResult,
  RetrievedSession,
  WebhookDestination,
} from './payment-provider.js';

/**
 * An in-memory Stripe stand-in.
 *
 * Two jobs. It makes local development and the entire test suite run without
 * Stripe credentials, and it makes the paths that are awkward to provoke against
 * a real provider — a lost response, a customer paying during expiry, a duplicate
 * refund — reachable on demand.
 *
 * Every generated id carries a `_fake_` marker, so a fake id can never be mistaken
 * for a real one in a log or a database row. The environment schema refuses
 * `PAYMENT_PROVIDER=fake` when NODE_ENV is production, so this cannot be reached
 * by a real deployment.
 *
 * The sessions and refunds live in an injected store rather than in this instance,
 * because a deployment runs two processes against one Stripe — see
 * fake-payment.store.ts for what that cost before it was fixed. What stays local is
 * genuinely local: the one-shot failure a test arms, and the call log it reads back.
 */

/**
 * Fixed secrets: the point is a realistic shape, not secrecy.
 *
 * Two of them, because Stripe has two destinations and gives each its own signing key.
 * A single shared secret here would make the two routes indistinguishable in tests and
 * hide the failure the split exists to prevent.
 */
const FAKE_WEBHOOK_SECRETS: Record<WebhookDestination, string> = {
  platform: 'whsec_fake_test_secret',
  connect: 'whsec_fake_connect_test_secret',
};

function secretFor(destination: WebhookDestination): string {
  return FAKE_WEBHOOK_SECRETS[destination];
}

/** One provider call and the Stripe account it addressed. `undefined` is the platform. */
export interface AccountCall {
  method:
    'createCheckoutSession' | 'expireCheckoutSession' | 'retrieveCheckoutSession' | 'createRefund';
  stripeAccountId: string | undefined;
}

/** Binds the shared store. Absent in the test harnesses, which want one process. */
export const FAKE_PAYMENT_STORE = 'FAKE_PAYMENT_STORE';

@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  private readonly store: FakePaymentStore;
  private readonly calls: string[] = [];
  /**
   * Which account each call addressed, in call order.
   *
   * Kept because it is the one thing about a Stripe call that cannot be checked from its
   * result: a refund aimed at the wrong connected account fails at Stripe, not here.
   */
  private readonly accountCalls: AccountCall[] = [];
  private nextFailure: Error | null = null;
  private nextCheckoutFailureAfterCreate: Error | null = null;
  private counter = 0;

  /**
   * Distinguishes one process's ids from another's.
   *
   * The counter alone is not enough. `stripe_checkout_session_id` is unique in the
   * database, and a restarted dev server would begin again at `cs_fake_1` and collide
   * with a row the previous run created — every booking failing with a 502 until the
   * counter passed whatever was already stored. Real Stripe ids are globally unique;
   * this makes the fake's the same, while keeping them recognisable and ordered. With
   * a shared store it does a second job: two processes minting ids at once cannot
   * produce the same one.
   */
  private readonly instance = randomBytes(4).toString('hex');

  constructor(@Optional() @Inject(FAKE_PAYMENT_STORE) store?: FakePaymentStore) {
    this.store = store ?? new InMemoryFakePaymentStore();
  }

  // ── test affordances ──────────────────────────────────────────────────────

  /** Make exactly the next provider call fail, then behave normally again. */
  failNextWith(error: Error): void {
    this.nextFailure = error;
  }

  /**
   * Lose the answer to exactly the next session creation, after it has happened.
   *
   * The failure mode `failNextWith` cannot express: the session exists at the
   * provider and the caller never learns its id. The retry has to find that session
   * through its idempotency key rather than open a second one the customer could
   * also pay into, and only a store that already holds the first one can prove it.
   */
  failNextCheckoutAfterCreateWith(error: Error): void {
    this.nextCheckoutFailureAfterCreate = error;
  }

  /** Mark a session paid, as if the customer had completed Checkout. */
  async markPaid(sessionId: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    this.counter += 1;

    await this.store.putSession({
      ...session,
      status: 'complete',
      paymentStatus: 'paid',
      paymentIntentId: `pi_fake_${this.instance}_${String(this.counter)}`,
      chargeId: `ch_fake_${this.instance}_${String(this.counter)}`,
      paymentMethodType: 'card',
    });
  }

  /** Mark a session expired without going through expireCheckoutSession. */
  async markExpired(sessionId: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    await this.store.putSession({ ...session, status: 'expired' });
  }

  async chargeIdFor(sessionId: string): Promise<string> {
    const { chargeId } = await this.requireSession(sessionId);
    if (chargeId === undefined) {
      throw new AppError('FAKE_PROVIDER_MISUSE', {
        message: `Session ${sessionId} has no charge. Call markPaid first.`,
      });
    }
    return chargeId;
  }

  async sessions(): Promise<FakeSessionRecord[]> {
    return await this.store.allSessions();
  }

  async refundCalls(): Promise<FakeRefundRecord[]> {
    return await this.store.allRefunds();
  }

  /** Method names in call order, for asserting a sequence. Per process, by design. */
  callOrder(): string[] {
    return [...this.calls];
  }

  /** Which Stripe account each call was routed to, in call order. */
  accountCallOrder(): AccountCall[] {
    return [...this.accountCalls];
  }

  /** The account the last call of this kind addressed, or undefined for the platform. */
  lastAccountFor(method: AccountCall['method']): string | undefined {
    return this.accountCalls.findLast((call) => call.method === method)?.stripeAccountId;
  }

  /**
   * A valid signature for a raw body, so a webhook test can be signed.
   *
   * Per destination, like Stripe: the platform endpoint and the Connect endpoint have
   * separate secrets, and a body signed for one does not verify on the other. Modelled
   * here rather than shared, so a test can prove the routes are actually separate.
   */
  signatureFor(rawBody: Buffer, destination: WebhookDestination = 'platform'): string {
    return createHmac('sha256', secretFor(destination)).update(rawBody).digest('hex');
  }

  async reset(): Promise<void> {
    await this.store.clear();
    this.calls.length = 0;
    this.accountCalls.length = 0;
    this.nextFailure = null;
    this.nextCheckoutFailureAfterCreate = null;
    this.counter = 0;
  }

  // ── PaymentProvider ───────────────────────────────────────────────────────

  async createCheckoutSession(
    context: PaymentAccountContext,
    input: CreateCheckoutSessionInput,
  ): Promise<CheckoutSessionResult> {
    this.record('createCheckoutSession', context);

    // Replay a session for a repeated idempotency key, as Stripe does.
    if (input.idempotencyKey !== undefined) {
      const existingId = await this.store.sessionIdForKey(input.idempotencyKey);
      if (existingId !== undefined) {
        const existing = await this.requireSession(existingId);
        if (!sameCheckoutRequest(existing, input)) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', {
            message: 'Checkout idempotency key was reused with different parameters.',
          });
        }
        return this.resultFor(existing);
      }
    }

    this.counter += 1;
    const sessionId = `cs_fake_${this.instance}_${String(this.counter)}`;

    const session: FakeSessionRecord = {
      sessionId,
      status: 'open',
      paymentStatus: 'unpaid',
      amountCents: input.amount.amountCents,
      currency: input.amount.currency,
      bookingId: input.bookingId,
      clientReferenceId: input.clientReferenceId,
      description: input.description,
      customerEmail: input.customerEmail,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      locale: input.locale,
      expiresAt: input.expiresAt.toISOString(),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    };

    await this.store.putSession(session);
    if (input.idempotencyKey !== undefined) {
      await this.store.rememberKey(input.idempotencyKey, sessionId);
    }

    // Stored first, then thrown: that ordering is the failure being modelled.
    if (this.nextCheckoutFailureAfterCreate !== null) {
      const failure = this.nextCheckoutFailureAfterCreate;
      this.nextCheckoutFailureAfterCreate = null;
      throw failure;
    }

    return this.resultFor(session);
  }

  async expireCheckoutSession(
    context: PaymentAccountContext,
    sessionId: string,
  ): Promise<ExpireResult> {
    this.record('expireCheckoutSession', context);

    const session = await this.requireSession(sessionId);

    // The branch the expiry saga exists for: the customer paid while the job was
    // in flight, so the slot must be kept rather than released.
    if (session.status === 'complete') {
      return { outcome: 'ALREADY_COMPLETE', paymentStatus: session.paymentStatus };
    }

    // Expiring an already-expired session is not an error; the job may be retried.
    await this.store.putSession({ ...session, status: 'expired' });
    return { outcome: 'EXPIRED' };
  }

  async retrieveCheckoutSession(
    context: PaymentAccountContext,
    sessionId: string,
  ): Promise<RetrievedSession> {
    this.record('retrieveCheckoutSession', context);

    const session = await this.requireSession(sessionId);

    return {
      sessionId: session.sessionId,
      status: session.status,
      paymentStatus: session.paymentStatus,
      paymentIntentId: session.paymentIntentId,
      chargeId: session.chargeId,
      amountTotalCents: session.amountCents,
      currency: session.currency,
      paymentMethodType: session.paymentMethodType,
      clientReferenceId: session.clientReferenceId,
    };
  }

  async createRefund(
    context: PaymentAccountContext,
    input: CreateRefundInput,
  ): Promise<RefundResult> {
    this.record('createRefund', context);

    const refunds = await this.store.allRefunds();

    // Same key, same refund — which is what stops a retried job refunding twice. The
    // fast path only; the claim below is what makes it true under concurrency.
    const existing = refunds.find((refund) => refund.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (
        existing.chargeId !== input.chargeId ||
        existing.amountCents !== input.amount.amountCents ||
        existing.currency !== input.amount.currency ||
        existing.reason !== input.reason
      ) {
        throw new AppError('IDEMPOTENCY_KEY_REUSED', {
          message: 'Refund idempotency key was reused with different parameters.',
        });
      }
      return {
        refundId: existing.refundId,
        status: 'succeeded',
        amountCents: existing.amountCents,
      };
    }

    const sessions = await this.store.allSessions();
    const charged = sessions.find((session) => session.chargeId === input.chargeId);
    if (!charged) {
      throw new AppError('FAKE_PROVIDER_MISUSE', {
        message: `No charge ${input.chargeId}. Call markPaid on a session first.`,
      });
    }

    const chargedAmount = Money.fromCents(charged.amountCents, charged.currency);
    const alreadyRefunded = Money.sum(
      refunds
        .filter((refund) => refund.chargeId === input.chargeId)
        .map((refund) => Money.fromCents(refund.amountCents, refund.currency)),
      chargedAmount.currency,
    );

    if (chargedAmount.lessThan(alreadyRefunded.plus(input.amount))) {
      const remainder = chargedAmount.minus(alreadyRefunded);
      throw new AppError('FAKE_PROVIDER_REFUND_TOO_LARGE', {
        message:
          `Refund of ${input.amount.toString()} exceeds the refundable remainder of ` +
          `${remainder.toString()} on ${input.chargeId}.`,
      });
    }

    this.counter += 1;
    const proposed: FakeRefundRecord = {
      refundId: `re_fake_${this.instance}_${String(this.counter)}`,
      chargeId: input.chargeId,
      amountCents: input.amount.amountCents,
      currency: input.amount.currency,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    };

    // Whichever refund holds this key afterwards — possibly one a concurrent caller
    // wrote while this one was checking the remainder.
    const refund = await this.store.claimRefund(proposed);
    if (
      refund.chargeId !== proposed.chargeId ||
      refund.amountCents !== proposed.amountCents ||
      refund.currency !== proposed.currency ||
      refund.reason !== proposed.reason
    ) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', {
        message: 'Refund idempotency key was reused with different parameters.',
      });
    }

    return { refundId: refund.refundId, status: 'succeeded', amountCents: refund.amountCents };
  }

  // No default for `destination`: the port declares it required, and a fake that fills it
  // in silently lets a test verify a Connect delivery against the platform secret and pass.
  verifyWebhook(
    rawBody: Buffer,
    signature: string,
    destination: WebhookDestination,
  ): ProviderEvent {
    const expected = Buffer.from(this.signatureFor(rawBody, destination), 'utf8');
    const provided = Buffer.from(signature, 'utf8');

    // Length must match before timingSafeEqual, which throws on a mismatch.
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new AppError('UNAUTHENTICATED', {
        status: 400,
        message: 'Invalid webhook signature.',
      });
    }

    const parsed = JSON.parse(rawBody.toString('utf8')) as {
      id?: unknown;
      type?: unknown;
      api_version?: unknown;
      account?: unknown;
    };

    if (typeof parsed.id !== 'string' || typeof parsed.type !== 'string') {
      throw new AppError('UNAUTHENTICATED', {
        status: 400,
        message: 'Webhook payload is missing an id or a type.',
      });
    }

    return {
      id: parsed.id,
      type: parsed.type,
      apiVersion: typeof parsed.api_version === 'string' ? parsed.api_version : undefined,
      // Stripe sets this on everything forwarded from a connected account.
      account: typeof parsed.account === 'string' ? parsed.account : undefined,
      payload: parsed,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private record(method: AccountCall['method'], context: PaymentAccountContext): void {
    this.calls.push(method);
    this.accountCalls.push({ method, stripeAccountId: context.stripeAccountId });

    if (this.nextFailure) {
      const failure = this.nextFailure;
      this.nextFailure = null;
      throw failure;
    }
  }

  private async requireSession(sessionId: string): Promise<FakeSessionRecord> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      // A real provider 404s on an unknown id, so surfacing rather than inventing
      // a session keeps callers honest about handling it.
      throw new AppError('FAKE_PROVIDER_UNKNOWN_SESSION', {
        message: `No such checkout session: ${sessionId}.`,
      });
    }
    return session;
  }

  private resultFor(session: FakeSessionRecord): CheckoutSessionResult {
    return {
      sessionId: session.sessionId,
      url: `https://checkout.fake.local/c/pay/${session.sessionId}`,
      expiresAt: new Date(session.expiresAt),
    };
  }
}

function sameCheckoutRequest(left: FakeSessionRecord, right: CreateCheckoutSessionInput): boolean {
  return (
    left.bookingId === right.bookingId &&
    left.clientReferenceId === right.clientReferenceId &&
    left.amountCents === right.amount.amountCents &&
    left.currency === right.amount.currency &&
    left.description === right.description &&
    left.customerEmail === right.customerEmail &&
    left.successUrl === right.successUrl &&
    left.cancelUrl === right.cancelUrl &&
    left.locale === right.locale &&
    left.expiresAt === right.expiresAt.toISOString() &&
    left.idempotencyKey === right.idempotencyKey
  );
}
