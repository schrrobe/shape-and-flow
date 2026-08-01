import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { withSerializationRetry } from '../common/prisma-errors/serialization-retry.js';
import { CLOCK } from '../domain/time/clock.js';
import { OutboxRecorder } from '../messaging/outbox/outbox.recorder.js';
import { JOB } from '../messaging/queues/job-contracts.js';
import { Prisma, BookingStatus, PaymentStatus } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { assertTransition, isTerminal } from './booking-status.machine.js';

import type { Clock } from '../domain/time/clock.js';

/** How long a management link stays usable. Long enough to cover the appointment itself. */
export const MANAGEMENT_TOKEN_TTL_DAYS = 120;

/** 256 bits, hex-encoded. The link is the only credential a customer ever gets. */
const TOKEN_BYTES = 32;

/** Where a confirmation came from, for the history row and the logs. */
export interface ConfirmationCause {
  kind: 'WEBHOOK' | 'EXPIRY_SAGA';
  /** The Stripe event id, or the job that drove it. */
  reference: string;
}

export interface ConfirmPaidInput {
  bookingId: string;
  sessionId: string;
  paymentIntentId?: string | undefined;
  chargeId?: string | undefined;
  amountTotalCents: number;
  paymentMethodType?: string | undefined;
  paidAt: Date;
  cause: ConfirmationCause;
}

export interface MarkPaymentFailedInput {
  bookingId: string;
  failureCode?: string | undefined;
  failureMessage?: string | undefined;
  cause: ConfirmationCause;
}

export type ConfirmOutcome = 'CONFIRMED' | 'ALREADY_CONFIRMED';

/** Hash a management token the way the stored column expects. */
export function hashManagementToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Moves a paid booking to CONFIRMED, exactly once.
 *
 * Two independent paths call this — the webhook, and the expiry saga discovering the
 * customer paid after all — and they can arrive at the same moment. So idempotency is
 * not a nicety here, it is the contract: the row is locked `FOR UPDATE`, an
 * already-confirmed booking returns `ALREADY_CONFIRMED` without touching anything, and
 * every side effect is inside the one transaction. The alternative is two payments, two
 * management tokens and two confirmation emails for one booking.
 *
 * The management token is generated here and returned in plaintext exactly once, into
 * the outbox payload. The database keeps only its hash, so a database read cannot
 * reconstruct the link — and the email can still contain it.
 */
@Injectable()
export class BookingConfirmationService {
  private readonly logger = new Logger('Confirmation');

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRecorder,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async confirmPaid(input: ConfirmPaidInput): Promise<ConfirmOutcome> {
    return await withSerializationRetry(() => this.confirmOnce(input), 'confirm-paid');
  }

  private async confirmOnce(input: ConfirmPaidInput): Promise<ConfirmOutcome> {
    const now = this.clock.now();

    return await this.prisma.$transaction(
      async (tx) => {
        // `FOR UPDATE` rather than a plain read: the whole point is that a second
        // caller waits here instead of racing us to the same side effects.
        const locked = await tx.$queryRaw<{ id: string; status: BookingStatus }[]>(
          Prisma.sql`SELECT id, status FROM bookings WHERE id = ${input.bookingId} FOR UPDATE`,
        );

        const current = locked[0];

        if (current === undefined) {
          throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
        }

        if (current.status === BookingStatus.CONFIRMED) return 'ALREADY_CONFIRMED';

        // A cancelled or expired booking that Stripe then reports as paid is a real
        // situation — the money needs refunding, which Stage 6 handles — but it is not
        // a confirmation, and forcing the transition would corrupt the history.
        if (isTerminal(current.status)) {
          this.logger.error(
            `payment.after_terminal booking=${input.bookingId} status=${current.status} session=${input.sessionId}`,
          );
          return 'ALREADY_CONFIRMED';
        }

        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: input.bookingId },
          select: { id: true, organizationId: true, priceCentsSnapshot: true, currency: true },
        });

        // The customer has paid, so we confirm even if the amount disagrees. Refusing
        // would leave them charged and unbooked, which is strictly worse than a
        // booking plus an alert somebody has to read.
        if (input.amountTotalCents !== booking.priceCentsSnapshot) {
          this.logger.error(
            `payment.amount_mismatch booking=${booking.id} expected=${String(booking.priceCentsSnapshot)} received=${String(input.amountTotalCents)}`,
          );
        }

        assertTransition(current.status, BookingStatus.CONFIRMED);

        await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.CONFIRMED,
            confirmedAt: now,
            // Cleared because the CHECK constraint requires it: expiresAt is non-null
            // exactly while a booking is PENDING_PAYMENT or EXPIRING.
            expiresAt: null,
            stripeCheckoutSessionId: input.sessionId,
          },
        });

        await this.upsertPayment(tx, booking, input);

        const managementToken = await this.issueManagementToken(tx, booking, now);

        await tx.bookingStatusHistory.create({
          data: {
            organizationId: booking.organizationId,
            bookingId: booking.id,
            fromStatus: current.status,
            toStatus: BookingStatus.CONFIRMED,
            actorType: 'SYSTEM',
            reason: `${input.cause.kind}:${input.cause.reference}`,
          },
        });

        await this.outbox.record(tx, {
          organizationId: booking.organizationId,
          aggregateType: 'Booking',
          aggregateId: booking.id,
          eventType: JOB.BOOKING_CONFIRMED,
          // The plaintext travels here and nowhere else. It is redacted from logs and
          // deleted with the outbox row.
          payload: {
            organizationId: booking.organizationId,
            bookingId: booking.id,
            managementToken,
          },
        });

        return 'CONFIRMED';
      },
      { isolationLevel: 'ReadCommitted', timeout: 15_000, maxWait: 10_000 },
    );
  }

  /**
   * Bring the payment row up to date.
   *
   * Keyed on the session id, which is unique per booking, so a redelivered event
   * updates the existing row rather than adding a second one. The row usually already
   * exists as PENDING from when the session was created; it may not, if the process
   * died between creating the session and attaching it.
   */
  private async upsertPayment(
    tx: Prisma.TransactionClient,
    booking: { id: string; organizationId: string; priceCentsSnapshot: number; currency: string },
    input: ConfirmPaidInput,
  ): Promise<void> {
    const paid = {
      status: PaymentStatus.SUCCEEDED,
      amountCents: input.amountTotalCents,
      paidAt: input.paidAt,
      ...(input.paymentIntentId === undefined
        ? {}
        : { stripePaymentIntentId: input.paymentIntentId }),
      ...(input.chargeId === undefined ? {} : { stripeChargeId: input.chargeId }),
      ...(input.paymentMethodType === undefined
        ? {}
        : { paymentMethodType: input.paymentMethodType }),
    };

    await tx.payment.upsert({
      where: { stripeCheckoutSessionId: input.sessionId },
      create: {
        organizationId: booking.organizationId,
        bookingId: booking.id,
        stripeCheckoutSessionId: input.sessionId,
        currency: booking.currency,
        ...paid,
      },
      update: paid,
      select: { id: true },
    });
  }

  /**
   * Mint the credential behind the management link.
   *
   * Unconditional, and safe to be: `confirmOnce` returns `ALREADY_CONFIRMED` before it
   * reaches this, so a redelivered event never gets here and there is never a second
   * token. That is why idempotency lives in the status check rather than being
   * reimplemented per side effect.
   */
  private async issueManagementToken(
    tx: Prisma.TransactionClient,
    booking: { id: string; organizationId: string },
    now: Date,
  ): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');

    await tx.managementToken.create({
      data: {
        organizationId: booking.organizationId,
        bookingId: booking.id,
        tokenHash: hashManagementToken(token),
        expiresAt: new Date(now.getTime() + MANAGEMENT_TOKEN_TTL_DAYS * 86_400_000),
      },
    });

    return token;
  }

  /**
   * Record that payment failed, without releasing the slot.
   *
   * PAYMENT_FAILED is terminal and non-blocking, so the slot frees itself. It is a
   * separate status from EXPIRED because the two mean different things to the office:
   * one customer's card was declined, the other never came back.
   */
  async markPaymentFailed(input: MarkPaymentFailedInput): Promise<void> {
    await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<{ id: string; status: BookingStatus }[]>(
            Prisma.sql`SELECT id, status FROM bookings WHERE id = ${input.bookingId} FOR UPDATE`,
          );

          const current = locked[0];
          if (current === undefined) return;

          // Nothing to do for a booking that already settled, in either direction. A
          // failed payment after a successful one is Stripe reporting an earlier
          // attempt.
          if (current.status !== BookingStatus.PENDING_PAYMENT) return;

          const booking = await tx.booking.findUniqueOrThrow({
            where: { id: input.bookingId },
            select: { organizationId: true },
          });

          assertTransition(current.status, BookingStatus.PAYMENT_FAILED);

          await tx.booking.update({
            where: { id: input.bookingId },
            data: { status: BookingStatus.PAYMENT_FAILED, expiresAt: null },
          });

          await tx.payment.updateMany({
            where: { bookingId: input.bookingId },
            data: {
              status: PaymentStatus.FAILED,
              ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
              ...(input.failureMessage === undefined
                ? {}
                : { failureMessage: input.failureMessage }),
            },
          });

          await tx.bookingStatusHistory.create({
            data: {
              organizationId: booking.organizationId,
              bookingId: input.bookingId,
              fromStatus: current.status,
              toStatus: BookingStatus.PAYMENT_FAILED,
              actorType: 'SYSTEM',
              reason: `${input.cause.kind}:${input.cause.reference}`,
            },
          });

          await this.outbox.record(tx, {
            organizationId: booking.organizationId,
            aggregateType: 'Booking',
            aggregateId: input.bookingId,
            eventType: JOB.BOOKING_PAYMENT_FAILED,
            payload: { organizationId: booking.organizationId, bookingId: input.bookingId },
          });
        }),
      'mark-payment-failed',
    );
  }
}
