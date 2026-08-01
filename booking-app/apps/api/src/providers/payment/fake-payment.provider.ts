import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error.js';
import { Money } from '../../domain/money/money.js';

import type {
  CheckoutSessionResult,
  CheckoutSessionStatus,
  CreateCheckoutSessionInput,
  CreateRefundInput,
  ExpireResult,
  PaymentAccountContext,
  PaymentProvider,
  PaymentStatusValue,
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
 */

/** Fixed secret: the point is a realistic shape, not secrecy. */
const FAKE_WEBHOOK_SECRET = 'whsec_fake_test_secret';

interface FakeSession {
  sessionId: string;
  status: CheckoutSessionStatus;
  paymentStatus: PaymentStatusValue;
  /** Money, not cents: the fake obeys the same arithmetic discipline as the app. */
  amount: Money;
  clientReferenceId: string;
  expiresAt: Date;
  paymentIntentId?: string;
  chargeId?: string;
  paymentMethodType?: string;
  idempotencyKey?: string | undefined;
}

interface FakeRefund {
  refundId: string;
  chargeId: string;
  amount: Money;
  idempotencyKey: string;
}

@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  private readonly sessionsById = new Map<string, FakeSession>();
  private readonly sessionsByIdempotencyKey = new Map<string, string>();
  private readonly refunds: FakeRefund[] = [];
  private readonly calls: string[] = [];
  private nextFailure: Error | null = null;
  private counter = 0;

  // ── test affordances ──────────────────────────────────────────────────────

  /** Make exactly the next provider call fail, then behave normally again. */
  failNextWith(error: Error): void {
    this.nextFailure = error;
  }

  /** Mark a session paid, as if the customer had completed Checkout. */
  markPaid(sessionId: string): void {
    const session = this.requireSession(sessionId);
    this.counter += 1;
    session.status = 'complete';
    session.paymentStatus = 'paid';
    session.paymentIntentId = `pi_fake_${String(this.counter)}`;
    session.chargeId = `ch_fake_${String(this.counter)}`;
    session.paymentMethodType = 'card';
  }

  /** Mark a session expired without going through expireCheckoutSession. */
  markExpired(sessionId: string): void {
    this.requireSession(sessionId).status = 'expired';
  }

  chargeIdFor(sessionId: string): string {
    const { chargeId } = this.requireSession(sessionId);
    if (!chargeId) {
      throw new AppError('FAKE_PROVIDER_MISUSE', {
        message: `Session ${sessionId} has no charge. Call markPaid first.`,
      });
    }
    return chargeId;
  }

  sessions(): FakeSession[] {
    return [...this.sessionsById.values()];
  }

  refundCalls(): FakeRefund[] {
    return [...this.refunds];
  }

  /** Method names in call order, for asserting a sequence. */
  callOrder(): string[] {
    return [...this.calls];
  }

  /** A valid signature for a raw body, so a webhook test can be signed. */
  signatureFor(rawBody: Buffer): string {
    return createHmac('sha256', FAKE_WEBHOOK_SECRET).update(rawBody).digest('hex');
  }

  reset(): void {
    this.sessionsById.clear();
    this.sessionsByIdempotencyKey.clear();
    this.refunds.length = 0;
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
      const existingId = this.sessionsByIdempotencyKey.get(input.idempotencyKey);
      if (existingId !== undefined) {
        const existing = this.requireSession(existingId);
        return this.resultFor(existing);
      }
    }

    this.counter += 1;
    const sessionId = `cs_fake_${String(this.counter)}`;

    const session: FakeSession = {
      sessionId,
      status: 'open',
      paymentStatus: 'unpaid',
      amount: input.amount,
      clientReferenceId: input.clientReferenceId,
      expiresAt: input.expiresAt,
      idempotencyKey: input.idempotencyKey,
    };

    this.sessionsById.set(sessionId, session);
    if (input.idempotencyKey !== undefined) {
      this.sessionsByIdempotencyKey.set(input.idempotencyKey, sessionId);
    }

    return this.resultFor(session);
  }

  async expireCheckoutSession(
    _context: PaymentAccountContext,
    sessionId: string,
  ): Promise<ExpireResult> {
    this.record('expireCheckoutSession');

    const session = this.requireSession(sessionId);

    // The branch the expiry saga exists for: the customer paid while the job was
    // in flight, so the slot must be kept rather than released.
    if (session.status === 'complete') {
      return { outcome: 'ALREADY_COMPLETE', paymentStatus: session.paymentStatus };
    }

    // Expiring an already-expired session is not an error; the job may be retried.
    session.status = 'expired';
    return { outcome: 'EXPIRED' };
  }

  async retrieveCheckoutSession(
    _context: PaymentAccountContext,
    sessionId: string,
  ): Promise<RetrievedSession> {
    this.record('retrieveCheckoutSession');

    const session = this.requireSession(sessionId);

    return {
      sessionId: session.sessionId,
      status: session.status,
      paymentStatus: session.paymentStatus,
      paymentIntentId: session.paymentIntentId,
      chargeId: session.chargeId,
      amountTotalCents: session.amount.amountCents,
      currency: session.amount.currency,
      paymentMethodType: session.paymentMethodType,
      clientReferenceId: session.clientReferenceId,
    };
  }

  async createRefund(
    _context: PaymentAccountContext,
    input: CreateRefundInput,
  ): Promise<RefundResult> {
    this.record('createRefund');

    // Same key, same refund — which is what stops a retried job refunding twice.
    const existing = this.refunds.find((refund) => refund.idempotencyKey === input.idempotencyKey);
    if (existing) {
      return {
        refundId: existing.refundId,
        status: 'succeeded',
        amountCents: existing.amount.amountCents,
      };
    }

    const charged = this.sessions().find((session) => session.chargeId === input.chargeId);
    if (!charged) {
      throw new AppError('FAKE_PROVIDER_MISUSE', {
        message: `No charge ${input.chargeId}. Call markPaid on a session first.`,
      });
    }

    const alreadyRefunded = Money.sum(
      this.refunds
        .filter((refund) => refund.chargeId === input.chargeId)
        .map((refund) => refund.amount),
      charged.amount.currency,
    );

    if (charged.amount.lessThan(alreadyRefunded.plus(input.amount))) {
      const remainder = charged.amount.minus(alreadyRefunded);
      throw new AppError('FAKE_PROVIDER_REFUND_TOO_LARGE', {
        message:
          `Refund of ${input.amount.toString()} exceeds the refundable remainder of ` +
          `${remainder.toString()} on ${input.chargeId}.`,
      });
    }

    this.counter += 1;
    const refund: FakeRefund = {
      refundId: `re_fake_${String(this.counter)}`,
      chargeId: input.chargeId,
      amount: input.amount,
      idempotencyKey: input.idempotencyKey,
    };
    this.refunds.push(refund);

    return {
      refundId: refund.refundId,
      status: 'succeeded',
      amountCents: refund.amount.amountCents,
    };
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

  private requireSession(sessionId: string): FakeSession {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      // A real provider 404s on an unknown id, so surfacing rather than inventing
      // a session keeps callers honest about handling it.
      throw new AppError('FAKE_PROVIDER_UNKNOWN_SESSION', {
        message: `No such checkout session: ${sessionId}.`,
      });
    }
    return session;
  }

  private resultFor(session: FakeSession): CheckoutSessionResult {
    return {
      sessionId: session.sessionId,
      url: `https://checkout.fake.local/c/pay/${session.sessionId}`,
      expiresAt: session.expiresAt,
    };
  }
}
