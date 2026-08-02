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

/** Fixed secret: the point is a realistic shape, not secrecy. */
const FAKE_WEBHOOK_SECRET = 'whsec_fake_test_secret';

/** Binds the shared store. Absent in the test harnesses, which want one process. */
export const FAKE_PAYMENT_STORE = 'FAKE_PAYMENT_STORE';

@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  private readonly store: FakePaymentStore;
  private readonly calls: string[] = [];
  private nextFailure: Error | null = null;
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

  /** A valid signature for a raw body, so a webhook test can be signed. */
  signatureFor(rawBody: Buffer): string {
    return createHmac('sha256', FAKE_WEBHOOK_SECRET).update(rawBody).digest('hex');
  }

  async reset(): Promise<void> {
    await this.store.clear();
    this.calls.length = 0;
    this.nextFailure = null;
    this.counter = 0;
  }

  // ── PaymentProvider ───────────────────────────────────────────────────────

  async createCheckoutSession(
    _context: PaymentAccountContext,
    input: CreateCheckoutSessionInput,
  ): Promise<CheckoutSessionResult> {
    this.record('createCheckoutSession');

    // Replay a session for a repeated idempotency key, as Stripe does.
    if (input.idempotencyKey !== undefined) {
      const existingId = await this.store.sessionIdForKey(input.idempotencyKey);
      if (existingId !== undefined) {
        return this.resultFor(await this.requireSession(existingId));
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
      clientReferenceId: input.clientReferenceId,
      expiresAt: input.expiresAt.toISOString(),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    };

    await this.store.putSession(session);
    if (input.idempotencyKey !== undefined) {
      await this.store.rememberKey(input.idempotencyKey, sessionId);
    }

    return this.resultFor(session);
  }

  async expireCheckoutSession(
    _context: PaymentAccountContext,
    sessionId: string,
  ): Promise<ExpireResult> {
    this.record('expireCheckoutSession');

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
    _context: PaymentAccountContext,
    sessionId: string,
  ): Promise<RetrievedSession> {
    this.record('retrieveCheckoutSession');

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
    _context: PaymentAccountContext,
    input: CreateRefundInput,
  ): Promise<RefundResult> {
    this.record('createRefund');

    const refunds = await this.store.allRefunds();

    // Same key, same refund — which is what stops a retried job refunding twice. The
    // fast path only; the claim below is what makes it true under concurrency.
    const existing = refunds.find((refund) => refund.idempotencyKey === input.idempotencyKey);
    if (existing) {
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
    };

    // Whichever refund holds this key afterwards — possibly one a concurrent caller
    // wrote while this one was checking the remainder.
    const refund = await this.store.claimRefund(proposed);

    return { refundId: refund.refundId, status: 'succeeded', amountCents: refund.amountCents };
  }

  verifyWebhook(rawBody: Buffer, signature: string): ProviderEvent {
    const expected = Buffer.from(this.signatureFor(rawBody), 'utf8');
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
      payload: parsed,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private record(method: string): void {
    this.calls.push(method);

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
