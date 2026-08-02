import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { isUniqueViolation } from '../common/prisma-errors/prisma-errors.js';
import { withSerializationRetry } from '../common/prisma-errors/serialization-retry.js';
import { Money } from '../domain/money/money.js';
import { computeSuggestedRetainedAmount } from '../domain/pricing/cancellation-fee.js';
import { CLOCK } from '../domain/time/clock.js';
import { OutboxRecorder } from '../messaging/outbox/outbox.recorder.js';
import { JOB } from '../messaging/queues/job-contracts.js';
import { RequestNotificationService } from '../notification/request-notification.service.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { BookingStatus, PaymentStatus, Prisma, RefundReason } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { AuditService } from './audit.service.js';
import { assertTransition } from './booking-status.machine.js';

import type { Clock } from '../domain/time/clock.js';

export type CancelByCustomerResult =
  | { outcome: 'CANCELED'; refundId: string | null; refundExpected: Money }
  | { outcome: 'REQUESTED'; requestId: string; suggestedRetained: Money };

export interface CancelByBusinessInput {
  bookingId: string;
  officeUserId: string;
  reason: string;
  /** Absent means no refund. Zero and absent are different: one is a decision. */
  refundAmountCents?: number | undefined;
}

export interface DecideRequestInput {
  requestId: string;
  officeUserId: string;
  decision: 'APPROVED' | 'REJECTED';
  /** Absent on approval falls back to the frozen suggestion. */
  retainedAmountCents?: number | undefined;
  note?: string | undefined;
}

/** The columns every cancellation path needs. */
const CANCELLABLE = {
  id: true,
  organizationId: true,
  status: true,
  startsAt: true,
  endsAt: true,
  currency: true,
  priceCentsSnapshot: true,
  payments: {
    select: { id: true, status: true, amountCents: true, refundedAmountCents: true },
  },
} as const;

/**
 * Cancelling, from either side, with the fee window in between.
 *
 * The shape of this is dictated by one fact: a cancellation inside the fee window is not
 * the customer's decision alone. So there are two outcomes, not one. Outside the window
 * the booking cancels immediately and the money goes back. Inside it, a request is
 * opened, the office decides how much to retain, and — the part that is easy to get
 * wrong — **the slot stays blocked while they decide**. Releasing it early would let
 * somebody else take the appointment before the business had agreed to give it up.
 *
 * The suggested retention is frozen into the request row. A customer sees a number
 * before they ask; if the office changed the policy afterwards, deciding against the new
 * one would charge them something they were never shown.
 */
@Injectable()
export class CancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly outbox: OutboxRecorder,
    private readonly audit: AuditService,
    private readonly requestNotifications: RequestNotificationService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async cancelByCustomer(bookingId: string, reason?: string): Promise<CancelByCustomerResult> {
    const now = this.clock.now();
    const booking = await this.loadCancellable(bookingId);

    // Both guards produce the same code, because from the customer's side they are the
    // same answer: this booking can no longer be cancelled here.
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw notCancellable(`A ${booking.status} booking cannot be cancelled.`);
    }

    if (booking.startsAt <= now) {
      throw notCancellable('This appointment has already started.');
    }

    const paid = this.paidTotal(booking);
    const settings = this.organizations.getSettings();

    const policy = computeSuggestedRetainedAmount({
      paid,
      startsAt: booking.startsAt,
      now,
      settings: {
        freeCancellationHours: settings.freeCancellationHours,
        cancellationFeePolicy: settings.cancellationFeePolicy,
        cancellationFeeAmountCents: settings.cancellationFeeAmountCents,
        cancellationFeePercent: settings.cancellationFeePercent,
      },
    });

    if (!policy.feeApplies) {
      return await this.cancelImmediately(booking, paid, reason);
    }

    return await this.openRequest(booking, policy.suggestedRetained, reason);
  }

  /** Outside the fee window: cancel now, refund everything that was paid. */
  private async cancelImmediately(
    booking: CancellableBooking,
    paid: Money,
    reason?: string,
  ): Promise<CancelByCustomerResult> {
    const now = this.clock.now();

    return await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const current = await this.lock(tx, booking.id);

          if (current !== BookingStatus.CONFIRMED) {
            throw notCancellable('This booking is no longer cancellable.');
          }

          assertTransition(current, BookingStatus.CANCELED_BY_CUSTOMER);

          await tx.booking.update({
            where: { id: booking.id },
            data: {
              status: BookingStatus.CANCELED_BY_CUSTOMER,
              canceledAt: now,
              ...(reason === undefined ? {} : { cancellationReason: reason }),
            },
          });

          await tx.bookingStatusHistory.create({
            data: {
              organizationId: booking.organizationId,
              bookingId: booking.id,
              fromStatus: current,
              toStatus: BookingStatus.CANCELED_BY_CUSTOMER,
              actorType: 'CUSTOMER',
              ...(reason === undefined ? {} : { reason }),
            },
          });

          const refundId = await this.requestRefund(tx, booking, paid, {
            reason: RefundReason.CUSTOMER_CANCELLATION,
          });

          await this.outbox.record(tx, {
            organizationId: booking.organizationId,
            aggregateType: 'Booking',
            aggregateId: booking.id,
            eventType: JOB.BOOKING_CANCELED,
            payload: {
              organizationId: booking.organizationId,
              bookingId: booking.id,
              ...(refundId === null ? {} : { refundId }),
            },
          });

          return { outcome: 'CANCELED' as const, refundId, refundExpected: paid };
        }),
      'cancel-immediately',
    );
  }

  /** Inside the fee window: open a request and leave the booking — and the slot — alone. */
  private async openRequest(
    booking: CancellableBooking,
    suggestedRetained: Money,
    reason?: string,
  ): Promise<CancelByCustomerResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const request = await tx.cancellationRequest.create({
          data: {
            organizationId: booking.organizationId,
            bookingId: booking.id,
            ...(reason === undefined ? {} : { reason }),
            // Frozen. The customer was shown this number; deciding against a later
            // policy would charge them something they never saw.
            suggestedRetainedAmountCents: suggestedRetained.amountCents,
          },
          select: { id: true },
        });

        // The office has to be told, and the customer has to be told it is pending.
        // Composed as real notification rows in this transaction, so they commit with
        // the request.
        await this.requestNotifications.queueCancellationReceived(tx, {
          requestId: request.id,
          bookingId: booking.id,
          suggestedRetainedCents: suggestedRetained.amountCents,
          reason: reason ?? null,
        });

        return { outcome: 'REQUESTED' as const, requestId: request.id, suggestedRetained };
      });
    } catch (error) {
      // The partial unique index allows one PENDING request per booking. A second one is
      // the customer clicking twice, or asking again while they wait.
      if (isUniqueViolation(error, 'cancellation_requests_one_open')) {
        throw notCancellable('A cancellation request for this booking is already open.');
      }

      throw error;
    }
  }

  /**
   * The office decides an open request.
   *
   * Approving cancels the booking and refunds what was paid minus what is retained.
   * Rejecting closes the request and leaves everything else exactly as it was — the
   * appointment stands.
   */
  async decideRequest(input: DecideRequestInput): Promise<void> {
    await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<{ id: string; decision: string }[]>(
            Prisma.sql`SELECT id, decision FROM cancellation_requests WHERE id = ${input.requestId} FOR UPDATE`,
          );

          if (locked[0] === undefined) {
            throw new AppError('NOT_FOUND', { message: 'Cancellation request not found.' });
          }

          if (locked[0].decision !== 'PENDING') {
            throw new AppError('REQUEST_ALREADY_DECIDED', {
              message: 'This request has already been decided.',
            });
          }

          const request = await tx.cancellationRequest.findUniqueOrThrow({
            where: { id: input.requestId },
            select: {
              id: true,
              bookingId: true,
              organizationId: true,
              suggestedRetainedAmountCents: true,
            },
          });

          const booking = await tx.booking.findUniqueOrThrow({
            where: { id: request.bookingId },
            select: CANCELLABLE,
          });

          const paid = this.paidTotal(booking);
          const retained = this.validateRetained(input, request, paid);

          const decided = {
            decision: input.decision,
            decidedByOfficeUserId: input.officeUserId,
            decidedAt: this.clock.now(),
            ...(input.note === undefined ? {} : { decisionNote: input.note }),
          };

          if (input.decision === 'REJECTED') {
            await tx.cancellationRequest.update({ where: { id: request.id }, data: decided });
            await this.requestNotifications.queueCancellationDecided(tx, {
              requestId: request.id,
              bookingId: booking.id,
              approved: false,
              retainedCents: 0,
              refundedCents: 0,
              note: input.note ?? null,
            });
            await this.auditDecision(tx, request, input, null);
            return;
          }

          const refundId = await this.approve(tx, booking, paid, retained, input);

          await tx.cancellationRequest.update({
            where: { id: request.id },
            data: {
              ...decided,
              retainedAmountCents: retained.amountCents,
              ...(refundId === null ? {} : { refundId }),
            },
          });

          await this.requestNotifications.queueCancellationDecided(tx, {
            requestId: request.id,
            bookingId: booking.id,
            approved: true,
            retainedCents: retained.amountCents,
            refundedCents: paid.minus(retained).amountCents,
            note: input.note ?? null,
          });

          await this.auditDecision(tx, request, input, retained.amountCents);
        }),
      'decide-cancellation-request',
    );
  }

  /** Cancel the booking behind an approved request and refund the difference. */
  private async approve(
    tx: Prisma.TransactionClient,
    booking: CancellableBooking,
    paid: Money,
    retained: Money,
    input: DecideRequestInput,
  ): Promise<string | null> {
    const now = this.clock.now();
    const current = await this.lock(tx, booking.id);

    // The business may have cancelled it in the meantime, or the appointment may have
    // happened. Either way the request is being decided about something settled.
    if (current !== BookingStatus.CONFIRMED) {
      throw notCancellable(`A ${current} booking cannot be cancelled.`);
    }

    assertTransition(current, BookingStatus.CANCELED_BY_CUSTOMER);

    await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: BookingStatus.CANCELED_BY_CUSTOMER,
        canceledAt: now,
        ...(input.note === undefined ? {} : { cancellationReason: input.note }),
      },
    });

    await tx.bookingStatusHistory.create({
      data: {
        organizationId: booking.organizationId,
        bookingId: booking.id,
        fromStatus: current,
        toStatus: BookingStatus.CANCELED_BY_CUSTOMER,
        actorType: 'OFFICE',
        actorOfficeUserId: input.officeUserId,
        reason: 'cancellation request approved',
      },
    });

    const refundId = await this.requestRefund(tx, booking, paid.minus(retained), {
      reason: RefundReason.CUSTOMER_CANCELLATION,
      officeUserId: input.officeUserId,
    });

    await this.outbox.record(tx, {
      organizationId: booking.organizationId,
      aggregateType: 'Booking',
      aggregateId: booking.id,
      eventType: JOB.BOOKING_CANCELED,
      payload: {
        organizationId: booking.organizationId,
        bookingId: booking.id,
        ...(refundId === null ? {} : { refundId }),
        // The decision message above already tells the customer, and says more than the
        // generic one would. Without this they get two emails about one cancellation.
        customerNotificationAlreadyQueued: true,
      },
    });

    return refundId;
  }

  /**
   * Business-side cancellation.
   *
   * Deliberately more permissive than the customer path: it works on a past appointment,
   * because correcting a mistaken entry is a real thing an office needs to do, and the
   * refund amount is theirs to choose rather than derived from a policy.
   */
  async cancelByBusiness(input: CancelByBusinessInput): Promise<{ refundId: string | null }> {
    return await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const current = await this.lock(tx, input.bookingId);

          if (current !== BookingStatus.CONFIRMED) {
            throw notCancellable(`A ${current} booking cannot be cancelled.`);
          }

          const booking = await tx.booking.findUniqueOrThrow({
            where: { id: input.bookingId },
            select: CANCELLABLE,
          });

          assertTransition(current, BookingStatus.CANCELED_BY_BUSINESS);

          await tx.booking.update({
            where: { id: input.bookingId },
            data: {
              status: BookingStatus.CANCELED_BY_BUSINESS,
              canceledAt: this.clock.now(),
              cancellationReason: input.reason,
              canceledByOfficeUserId: input.officeUserId,
            },
          });

          await tx.bookingStatusHistory.create({
            data: {
              organizationId: booking.organizationId,
              bookingId: booking.id,
              fromStatus: current,
              toStatus: BookingStatus.CANCELED_BY_BUSINESS,
              actorType: 'OFFICE',
              actorOfficeUserId: input.officeUserId,
              reason: input.reason,
            },
          });

          const refundId =
            input.refundAmountCents === undefined
              ? null
              : await this.requestRefund(
                  tx,
                  booking,
                  Money.fromCents(input.refundAmountCents, booking.currency),
                  { reason: RefundReason.BUSINESS_CANCELLATION, officeUserId: input.officeUserId },
                );

          // Any open request is about a decision that has now been overtaken. Closing
          // them here is what stops a request outliving its booking, waiting for an
          // answer nobody can give.
          await this.closeOpenRequests(tx, booking.id, input.officeUserId);

          await this.outbox.record(tx, {
            organizationId: booking.organizationId,
            aggregateType: 'Booking',
            aggregateId: booking.id,
            eventType: JOB.BOOKING_CANCELED,
            payload: {
              organizationId: booking.organizationId,
              bookingId: booking.id,
              ...(refundId === null ? {} : { refundId }),
            },
          });

          await this.audit.record(tx, {
            organizationId: booking.organizationId,
            officeUserId: input.officeUserId,
            action: 'BOOKING_CANCELED',
            entityType: 'Booking',
            entityId: booking.id,
            summary: `Cancelled by the business: ${input.reason}`,
            after: { status: BookingStatus.CANCELED_BY_BUSINESS, refundId },
          });

          return { refundId };
        }),
      'cancel-by-business',
    );
  }

  /**
   * Close requests the business cancellation has overtaken.
   *
   * A cancellation request is closed as APPROVED — the customer asked to cancel and the
   * booking is cancelled, which is the outcome they wanted. A reschedule request is
   * REJECTED, because the appointment they wanted to move no longer exists.
   */
  private async closeOpenRequests(
    tx: Prisma.TransactionClient,
    bookingId: string,
    officeUserId: string,
  ): Promise<void> {
    const decided = { decidedByOfficeUserId: officeUserId, decidedAt: this.clock.now() };

    await tx.cancellationRequest.updateMany({
      where: { bookingId, decision: 'PENDING' },
      data: {
        ...decided,
        decision: 'APPROVED',
        decisionNote: 'closed by business cancellation',
      },
    });

    await tx.rescheduleRequest.updateMany({
      where: { bookingId, decision: 'PENDING' },
      data: {
        ...decided,
        decision: 'REJECTED',
        decisionNote: 'closed by business cancellation',
      },
    });
  }

  /**
   * Create the refund row, if there is anything to refund.
   *
   * A row, not a provider call: the money moves in a worker, driven by the
   * `refund.requested` outbox event. That is what makes a refund survive a crash between
   * deciding to refund and Stripe accepting it.
   */
  private async requestRefund(
    tx: Prisma.TransactionClient,
    booking: CancellableBooking,
    amount: Money,
    options: { reason: RefundReason; officeUserId?: string },
  ): Promise<string | null> {
    if (amount.amountCents <= 0) return null;

    const payment = booking.payments.find(
      (candidate) =>
        candidate.status === PaymentStatus.SUCCEEDED ||
        candidate.status === PaymentStatus.PARTIALLY_REFUNDED,
    );

    // An unpaid manual booking cancels with nothing to give back.
    if (payment === undefined) return null;

    const refund = await tx.refund.create({
      data: {
        organizationId: booking.organizationId,
        bookingId: booking.id,
        paymentId: payment.id,
        amountCents: amount.amountCents,
        currency: booking.currency,
        status: 'PENDING',
        reason: options.reason,
        // Generated here and stored before any provider call, so a retry after a lost
        // response cannot refund twice.
        idempotencyKey: randomUUID(),
        ...(options.officeUserId === undefined
          ? {}
          : { issuedByOfficeUserId: options.officeUserId }),
      },
      select: { id: true },
    });

    await this.outbox.record(tx, {
      organizationId: booking.organizationId,
      aggregateType: 'Refund',
      aggregateId: refund.id,
      eventType: JOB.REFUND_REQUESTED,
      payload: { organizationId: booking.organizationId, refundId: refund.id },
    });

    return refund.id;
  }

  /** How much the retained amount may be, and what it is when unspecified. */
  private validateRetained(
    input: DecideRequestInput,
    request: { suggestedRetainedAmountCents: number },
    paid: Money,
  ): Money {
    const requested = input.retainedAmountCents ?? request.suggestedRetainedAmountCents;

    if (requested < 0 || requested > paid.amountCents) {
      throw new AppError('VALIDATION_FAILED', {
        message: `Retained amount must be between 0 and ${String(paid.amountCents)}.`,
        details: { paidAmountCents: paid.amountCents },
      });
    }

    return Money.fromCents(requested, paid.currency);
  }

  private async auditDecision(
    tx: Prisma.TransactionClient,
    request: { id: string; organizationId: string; bookingId: string },
    input: DecideRequestInput,
    retainedAmountCents: number | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      organizationId: request.organizationId,
      officeUserId: input.officeUserId,
      action: 'CANCELLATION_REQUEST_DECIDED',
      entityType: 'CancellationRequest',
      entityId: request.id,
      summary: `Cancellation request ${input.decision.toLowerCase()}`,
      after: { decision: input.decision, retainedAmountCents, bookingId: request.bookingId },
    });
  }

  /** Lock the booking row and return its current status. */
  private async lock(tx: Prisma.TransactionClient, bookingId: string): Promise<BookingStatus> {
    const rows = await tx.$queryRaw<{ status: BookingStatus }[]>(
      Prisma.sql`SELECT status FROM bookings WHERE id = ${bookingId} FOR UPDATE`,
    );

    if (rows[0] === undefined) {
      throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
    }

    return rows[0].status;
  }

  private async loadCancellable(bookingId: string): Promise<CancellableBooking> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, organizationId: this.organizations.getOrganizationId() },
      select: CANCELLABLE,
    });

    if (booking === null) {
      throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
    }

    return booking;
  }

  /** What actually settled. A PENDING payment has not been received. */
  private paidTotal(booking: CancellableBooking): Money {
    const settled: PaymentStatus[] = [
      PaymentStatus.SUCCEEDED,
      PaymentStatus.PARTIALLY_REFUNDED,
      PaymentStatus.REFUNDED,
    ];

    return Money.sum(
      booking.payments
        .filter((payment) => settled.includes(payment.status))
        .map((payment) => Money.fromCents(payment.amountCents, booking.currency)),
      booking.currency,
    );
  }
}

interface CancellableBooking {
  id: string;
  organizationId: string;
  status: BookingStatus;
  startsAt: Date;
  endsAt: Date;
  currency: string;
  priceCentsSnapshot: number;
  payments: {
    id: string;
    status: PaymentStatus;
    amountCents: number;
    refundedAmountCents: number;
  }[];
}

function notCancellable(message: string): AppError {
  return new AppError('BOOKING_NOT_CANCELLABLE', { message });
}
