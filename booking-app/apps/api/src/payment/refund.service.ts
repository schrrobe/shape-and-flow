import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { withSerializationRetry } from '../common/prisma-errors/serialization-retry.js';
import { Money } from '../domain/money/money.js';
import { CLOCK } from '../domain/time/clock.js';
import { OutboxRecorder } from '../messaging/outbox/outbox.recorder.js';
import { JOB } from '../messaging/queues/job-contracts.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PaymentStatus, Prisma, RefundStatus } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { accountOfRecordedPayment, PAYMENT_PROVIDER } from '../providers/payment/payment-provider.js';
import { isRetryableStripeError } from '../providers/payment/stripe.errors.js';

import { BookingFinancialsService } from './booking-financials.service.js';

import type { Clock } from '../domain/time/clock.js';
import type { RefundReason } from '../prisma/client.js';
import type { PaymentProvider, RefundStatusValue } from '../providers/payment/payment-provider.js';

export interface RequestRefundInput {
  bookingId: string;
  amountCents: number;
  reason: RefundReason;
  officeUserId?: string | undefined;
}

/**
 * What "refund this" means, which is not the same question in the two places it is asked.
 *
 * `ADDITIONAL` is an instruction: send this much now, on top of whatever has already gone
 * back. That is what an office user typing an amount means.
 *
 * `CUMULATIVE_TARGET` is an outcome: the customer should end up having received this much
 * in total. That is what a cancellation means — "refund what was paid minus what we
 * keep" — and stating it as an instruction is how a booking with an earlier partial
 * refund gets refunded twice over.
 */
export type RefundAmount =
  | { kind: 'ADDITIONAL'; amountCents: number }
  | { kind: 'CUMULATIVE_TARGET'; targetAmountCents: number };

export interface ReserveRefundInput {
  bookingId: string;
  amount: RefundAmount;
  reason: RefundReason;
  officeUserId?: string | undefined;
  /**
   * Treat "nothing to refund" as a normal outcome rather than an error.
   *
   * A cancellation of an unpaid booking is an ordinary cancellation; a refund route
   * asked to refund a booking with no settled payment is a mistake worth reporting.
   */
  lenient?: boolean;
}

export interface RefundReservationResult {
  /** Null when nothing needed to move: the target was already met, or there is no payment. */
  refundId: string | null;
  additionalAmountCents: number;
  refundableAmountCents: number;
}

export interface ProviderUpdate {
  stripeRefundId: string;
  idempotencyKey?: string | undefined;
  status: RefundStatusValue;
  amountCents: number;
}

/** Statuses a refund can still move out of. Anything else has settled. */
const OPEN_REFUND_STATUSES: RefundStatus[] = [RefundStatus.PENDING];

/**
 * Which provider statuses map to which of ours.
 *
 * `canceled` is Stripe's word for a refund that was reversed before settling — a failure
 * from our point of view, in that the money did not go back.
 */
const PROVIDER_STATUS: Record<RefundStatusValue, RefundStatus> = {
  succeeded: RefundStatus.SUCCEEDED,
  pending: RefundStatus.PENDING,
  failed: RefundStatus.FAILED,
  canceled: RefundStatus.CANCELED,
};

/**
 * Moves money out exactly once.
 *
 * Three separate things can each try to settle the same refund: the API response, a
 * `refund.created` webhook that may arrive *before* it, and a later `refund.updated`.
 * They can arrive in any order and any of them can be repeated. So settlement is written
 * in exactly one place — `applySettlement` — and everything else routes through it.
 *
 * The other half is the provider's own idempotency key. It is generated and stored
 * *before* the call, so a retry after a lost response reaches Stripe with the same key
 * and gets the original refund back rather than making a second one.
 *
 * `refundedAmountCents` on the payment is recomputed from the sum of SUCCEEDED refunds
 * rather than incremented. An increment drifts under a retry; a sum cannot.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger('Refund');

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly outbox: OutboxRecorder,
    private readonly financials: BookingFinancialsService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Record the intention to refund. No provider call happens here.
   *
   * The row exists first so the money never moves without something durable saying it
   * was supposed to.
   */
  async request(input: RequestRefundInput): Promise<{ refundId: string }> {
    return await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const reserved = await this.reserveInTransaction(tx, {
            bookingId: input.bookingId,
            amount: { kind: 'ADDITIONAL', amountCents: input.amountCents },
            reason: input.reason,
            ...(input.officeUserId === undefined ? {} : { officeUserId: input.officeUserId }),
          });

          // `lenient` is off, so the only way here is with a refund actually created.
          if (reserved.refundId === null) {
            throw new AppError('PAYMENT_NOT_REFUNDABLE', {
              message: 'There is nothing left to refund on this booking.',
            });
          }

          return { refundId: reserved.refundId };
        }),
      'request-refund',
    );
  }

  /**
   * Reserve part of a payment's remaining balance, inside the caller's transaction.
   *
   * The one place a refund row is created, and the reason it is one place is the
   * arithmetic. The balance is `amount - refunded - pending`: a refund that has been
   * decided but not yet settled is money already committed, and counting only
   * `refundedAmountCents` meant two requests in the window before Stripe answers could
   * each pass and together exceed the charge. The second one then failed at the
   * provider, after the office had been told it was done.
   *
   * The row lock is what makes that reservation hold under concurrency: the payment is
   * locked `FOR UPDATE` before the sum is read, so two callers serialise rather than
   * both reading the same remainder.
   *
   * Refunds are reserved against the **financial root**, so a refund issued from a
   * rescheduled booking comes out of the charge that actually exists.
   */
  async reserveInTransaction(
    tx: Prisma.TransactionClient,
    input: ReserveRefundInput,
  ): Promise<RefundReservationResult> {
    const rootBookingId = await this.financials.rootBookingId(input.bookingId, tx);
    const payment = await this.lockPayment(tx, rootBookingId, input.lenient === true);

    if (payment === null)
      return { refundId: null, additionalAmountCents: 0, refundableAmountCents: 0 };

    const pending = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: RefundStatus.PENDING },
      _sum: { amountCents: true },
    });

    // Through Money rather than by adding and subtracting the columns: the
    // cent-arithmetic ban exists for exactly this, and it caught these lines already.
    const reserved = Money.fromCents(payment.refundedAmountCents, payment.currency).plus(
      Money.fromCents(pending._sum.amountCents ?? 0, payment.currency),
    );
    const refundable = Money.fromCents(payment.amountCents, payment.currency).minus(reserved);

    const additional = this.additionalFor(input.amount, reserved, refundable);
    const additionalCents = additional.amountCents;

    if (additionalCents <= 0) {
      if (input.amount.kind === 'ADDITIONAL' && input.lenient !== true) {
        throw new AppError('PAYMENT_NOT_REFUNDABLE', {
          message: `Only ${String(refundable.amountCents)} cents remain refundable on this booking.`,
          details: { refundableAmountCents: refundable.amountCents },
        });
      }

      // A cumulative target already met, or a cancellation with nothing to give back.
      return {
        refundId: null,
        additionalAmountCents: 0,
        refundableAmountCents: refundable.amountCents,
      };
    }

    if (additionalCents > refundable.amountCents) {
      throw new AppError('PAYMENT_NOT_REFUNDABLE', {
        message: `Only ${String(refundable.amountCents)} cents remain refundable on this booking.`,
        details: { refundableAmountCents: refundable.amountCents },
      });
    }

    const refund = await tx.refund.create({
      data: {
        organizationId: payment.organizationId,
        // The booking the office acted on, so the trail says where the decision was
        // made. The money comes out of the root's payment either way.
        bookingId: input.bookingId,
        paymentId: payment.id,
        amountCents: additionalCents,
        currency: payment.currency,
        status: RefundStatus.PENDING,
        reason: input.reason,
        // Stored before any call, which is what makes a retry idempotent at the
        // provider rather than only here.
        idempotencyKey: randomUUID(),
        ...(input.officeUserId === undefined ? {} : { issuedByOfficeUserId: input.officeUserId }),
      },
      select: { id: true },
    });

    await this.outbox.record(tx, {
      organizationId: payment.organizationId,
      aggregateType: 'Refund',
      aggregateId: refund.id,
      eventType: JOB.REFUND_REQUESTED,
      payload: { organizationId: payment.organizationId, refundId: refund.id },
    });

    return {
      refundId: refund.id,
      additionalAmountCents: additionalCents,
      refundableAmountCents: refundable.amountCents,
    };
  }

  /**
   * How much this reservation actually moves.
   *
   * A cumulative target is capped at what is left: a target derived from a paid total
   * that includes cash can exceed the card charge, and Stripe cannot give back money it
   * never took.
   */
  private additionalFor(amount: RefundAmount, reserved: Money, refundable: Money): Money {
    if (amount.kind === 'ADDITIONAL') {
      return Money.fromCents(amount.amountCents, refundable.currency);
    }

    const outstanding = Money.fromCents(amount.targetAmountCents, reserved.currency).minus(
      reserved,
    );

    if (outstanding.amountCents <= 0) return Money.zero(refundable.currency);

    return outstanding.lessThan(refundable) ? outstanding : refundable;
  }

  /**
   * Ask the provider to move the money, then record what happened.
   *
   * The call is outside every transaction. A transaction spanning it would hold the
   * payment's row lock for as long as Stripe takes, on the row a concurrent webhook needs.
   */
  async execute(refundId: string): Promise<'SUCCEEDED' | 'FAILED'> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: {
        id: true,
        organizationId: true,
        status: true,
        amountCents: true,
        currency: true,
        idempotencyKey: true,
        stripeRefundId: true,
        payment: { select: { stripeChargeId: true, stripeAccountId: true } },
      },
    });

    if (refund === null) {
      throw new AppError('NOT_FOUND', { message: 'Refund not found.' });
    }

    // Already settled — by a webhook that beat us here, or by a previous run of this same
    // job. Nothing to do, and calling the provider again would be pointless traffic.
    if (!OPEN_REFUND_STATUSES.includes(refund.status)) {
      return refund.status === RefundStatus.SUCCEEDED ? 'SUCCEEDED' : 'FAILED';
    }

    const chargeId = refund.payment.stripeChargeId;

    if (chargeId === null) {
      // Nothing to refund against. Recorded as failed rather than retried forever: the
      // charge id will not appear on its own.
      await this.applySettlement({
        refundId: refund.id,
        status: RefundStatus.FAILED,
        failureReason: 'The payment has no charge to refund against.',
      });

      return 'FAILED';
    }

    // The refund's own organization, not whatever bootstrap resolved. This runs in a
    // worker with no request behind it, and the account this call goes to decides whose
    // money moves.
    const organization = this.organizations.require(refund.organizationId);

    try {
      const result = await this.payments.createRefund(
        {
          organizationId: organization.id,
          // The account the charge is on, taken from the payment row. The organization
          // may have completed Connect onboarding since it was paid, and refunding a
          // platform charge against the connected account refunds nothing.
          stripeAccountId: accountOfRecordedPayment(refund.payment),
        },
        {
          chargeId,
          amount: Money.fromCents(refund.amountCents, refund.currency),
          // The stored key, not a fresh one: that is the entire point of storing it.
          idempotencyKey: refund.idempotencyKey,
        },
      );

      await this.applySettlement({
        refundId: refund.id,
        status: PROVIDER_STATUS[result.status],
        stripeRefundId: result.refundId,
      });

      return result.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED';
    } catch (error) {
      // A transient failure is rethrown so BullMQ retries — with the same key, so the
      // retry cannot double-refund. A permanent rejection is recorded and not retried.
      if (isRetryableStripeError(error)) throw error;

      const failureReason = error instanceof Error ? error.message : String(error);

      await this.applySettlement({
        refundId: refund.id,
        status: RefundStatus.FAILED,
        failureReason,
      });

      this.logger.warn(`refund ${refund.id} rejected by the provider: ${failureReason}`);
      return 'FAILED';
    }
  }

  /**
   * Apply what a webhook says about a refund.
   *
   * Matched by the provider's refund id, falling back to our idempotency key — which is
   * the only handle available when `refund.created` arrives before the API response has
   * told us the provider's id. The key travels there in the refund's Stripe metadata.
   */
  async applyProviderUpdate(input: ProviderUpdate): Promise<void> {
    const refund = await this.prisma.refund.findFirst({
      where: {
        OR: [
          { stripeRefundId: input.stripeRefundId },
          ...(input.idempotencyKey === undefined ? [] : [{ idempotencyKey: input.idempotencyKey }]),
        ],
      },
      select: { id: true },
    });

    if (refund === null) {
      // A refund somebody issued in the Stripe dashboard, or one whose row was pruned.
      // Worth a line, not worth an error: there is nothing here to reconcile it with.
      this.logger.warn(`no local refund matches ${input.stripeRefundId}; ignoring`);
      return;
    }

    await this.applySettlement({
      refundId: refund.id,
      status: PROVIDER_STATUS[input.status],
      stripeRefundId: input.stripeRefundId,
    });
  }

  /**
   * The one place a refund's outcome is written.
   *
   * Both the API path and the webhook path come through here, which is what makes their
   * ordering irrelevant. A settled refund is never moved again: a late `refund.updated`
   * saying "failed" about money that already went back would otherwise corrupt the
   * accounting, and the provider does send those.
   */
  private async applySettlement(input: {
    refundId: string;
    status: RefundStatus;
    stripeRefundId?: string;
    failureReason?: string;
  }): Promise<void> {
    await withSerializationRetry(
      () =>
        this.prisma.$transaction(
          async (tx) => {
            const locked = await tx.$queryRaw<{ status: RefundStatus }[]>(
              Prisma.sql`SELECT status FROM refunds WHERE id = ${input.refundId} FOR UPDATE`,
            );

            const current = locked[0]?.status;
            if (current === undefined) return;

            if (!OPEN_REFUND_STATUSES.includes(current)) {
              if (current !== input.status) {
                this.logger.warn(
                  `refusing to move refund ${input.refundId} from ${current} to ${input.status}`,
                );
              }
              return;
            }

            const settledAt = input.status === RefundStatus.PENDING ? null : this.clock.now();

            const refund = await tx.refund.update({
              where: { id: input.refundId },
              data: {
                status: input.status,
                ...(input.stripeRefundId === undefined
                  ? {}
                  : { stripeRefundId: input.stripeRefundId }),
                ...(input.failureReason === undefined
                  ? {}
                  : { failureReason: input.failureReason.slice(0, 1000) }),
                ...(settledAt === null ? {} : { settledAt }),
              },
              select: { id: true, bookingId: true, paymentId: true, organizationId: true },
            });

            await this.recomputePaymentTotals(tx, refund.paymentId);

            if (input.status === RefundStatus.SUCCEEDED) {
              await this.outbox.record(tx, {
                organizationId: refund.organizationId,
                aggregateType: 'Refund',
                aggregateId: refund.id,
                eventType: JOB.REFUND_SUCCEEDED,
                payload: { organizationId: refund.organizationId, refundId: refund.id },
              });
            }
          },
          // Explicit, not Prisma's 5 s timeout and 2 s max wait. This waits on `FOR UPDATE`
          // and then does an update, an aggregate and an outbox write — and a timeout is not
          // a serialization failure, so `withSerializationRetry` would not retry it. Under
          // refund contention the default budget loses the settlement for that delivery.
          { isolationLevel: 'ReadCommitted', timeout: 15_000, maxWait: 10_000 },
        ),
      'apply-refund-settlement',
    );
  }

  /**
   * Recompute the payment's refunded total from the refunds themselves.
   *
   * A sum, not an increment. An increment is only correct if it happens exactly once, and
   * the whole point of this file is that settlement can be attempted more than once.
   */
  private async recomputePaymentTotals(
    tx: Prisma.TransactionClient,
    paymentId: string,
  ): Promise<void> {
    // Sequential, not `Promise.all`. Every query on a transaction client runs on the one
    // connection the transaction holds, so these would be serialised anyway — the parallel
    // form buys nothing and only reads as though it did.
    const payment = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: { amountCents: true, status: true },
    });

    const sum = await tx.refund.aggregate({
      where: { paymentId, status: RefundStatus.SUCCEEDED },
      _sum: { amountCents: true },
    });

    const refunded = sum._sum.amountCents ?? 0;

    await tx.payment.update({
      where: { id: paymentId },
      data: {
        refundedAmountCents: refunded,
        status: paymentStatusFor(payment.amountCents, refunded, payment.status),
      },
    });
  }

  /** The payment behind a booking, locked so a concurrent refund cannot over-refund it. */
  private async lockPayment(
    tx: Prisma.TransactionClient,
    bookingId: string,
    lenient: boolean,
  ): Promise<{
    id: string;
    organizationId: string;
    currency: string;
    amountCents: number;
    refundedAmountCents: number;
  } | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`
        SELECT id FROM payments
        WHERE booking_id = ${bookingId}
          AND status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED')
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE
      `,
    );

    const id = rows[0]?.id;

    if (id === undefined) {
      // No settled payment: there is nothing to give back. Includes the unpaid manual
      // booking and the booking whose payment failed. Cancelling one of those is
      // ordinary; being asked to refund one is a mistake worth reporting.
      if (lenient) return null;

      throw new AppError('PAYMENT_NOT_REFUNDABLE', {
        message: 'This booking has no settled payment to refund.',
      });
    }

    return await tx.payment.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        organizationId: true,
        currency: true,
        amountCents: true,
        refundedAmountCents: true,
      },
    });
  }
}

/**
 * What the payment's status becomes once `refunded` has been recomputed.
 *
 * Derived from the amounts rather than from the previous status, so a failed refund that
 * brings the total back down also brings the status back with it.
 */
function paymentStatusFor(
  amountCents: number,
  refundedCents: number,
  current: PaymentStatus,
): PaymentStatus {
  if (refundedCents <= 0) {
    // Never downgrade a failed payment just because it has no refunds.
    return current === PaymentStatus.FAILED ? current : PaymentStatus.SUCCEEDED;
  }

  return refundedCents >= amountCents ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
}
