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
import { receivedFrom } from '../office/received.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { BookingFinancialsService } from '../payment/booking-financials.service.js';
import { RefundService } from '../payment/refund.service.js';
import { BookingStatus, Prisma, RefundReason } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { AuditService } from './audit.service.js';
import { assertTransition } from './booking-status.machine.js';

import type { Clock } from '../domain/time/clock.js';
import type { RefundAmount, RefundReservationResult } from '../payment/refund.service.js';

export type CancelByCustomerResult =
  | { outcome: 'CANCELED'; refundId: string | null; refundExpected: Money }
  | { outcome: 'REQUESTED'; requestId: string; suggestedRetained: Money };

export interface CancelByBusinessInput {
  bookingId: string;
  officeUserId: string;
  reason: string;
  mayIssueRefunds: boolean;
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
  /**
   * Whether this office user may move money.
   *
   * Enforced here rather than in the controller, because only the reservation knows
   * whether this decision actually refunds anything: retention and the paid total are
   * both read inside the transaction, and comparing them outside it was what made
   * "accept the suggestion" — an omitted amount — look like a full refund.
   */
  mayIssueRefunds: boolean;
}

/**
 * The columns every cancellation path needs.
 *
 * No `payments` relation, deliberately. A rescheduled booking's money sits on the row it
 * was paid on, so the replacement's own relation is empty and reading it here answered
 * "nothing was paid" for a booking the customer had paid in full. What was paid comes
 * from `BookingFinancialsService`, which is the one thing that knows where the money is.
 */
const CANCELLABLE = {
  id: true,
  organizationId: true,
  status: true,
  startsAt: true,
  endsAt: true,
  currency: true,
  priceCentsSnapshot: true,
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
    private readonly refunds: RefundService,
    private readonly financials: BookingFinancialsService,
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

    const paid = await this.paidTotal(booking);
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
          const current = await this.lock(tx, booking.id, booking.organizationId);

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

          const reserved = await this.reserveRefund(
            tx,
            booking,
            { kind: 'CUMULATIVE_TARGET', targetAmountCents: paid.amountCents },
            { reason: RefundReason.CUSTOMER_CANCELLATION, mayIssueRefunds: true },
          );

          const refundId = reserved.refundId;

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

          return {
            outcome: 'CANCELED' as const,
            refundId,
            // What the reservation actually moves, not what was paid. A booking with an
            // earlier partial refund, or one settled partly in cash, gives back less than
            // its paid total — and this number is shown to the customer as a promise.
            refundExpected: Money.fromCents(reserved.additionalAmountCents, booking.currency),
          };
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
      return await withSerializationRetry(
        () =>
          this.prisma.$transaction(async (tx) => {
            // Re-read under the lock, exactly as `cancelImmediately` does. The status was
            // last seen outside any transaction, and a booking cancelled, completed or
            // marked no-show since then would otherwise collect a PENDING request that
            // blocks the next legitimate one through `cancellation_requests_one_open`
            // and outlives the booking it is about.
            const current = await this.lock(tx, booking.id, booking.organizationId);

            if (current !== BookingStatus.CONFIRMED) {
              throw notCancellable(`A ${current} booking cannot be cancelled.`);
            }

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
          }),
        'open-cancellation-request',
      );
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
          const organizationId = this.organizations.getOrganizationId();

          // Unlocked, and only to learn which booking to lock. Both rows are then locked
          // booking-first, which is the order `cancelByBusiness` takes through
          // `closeOpenRequests`. Locking the request first here instead would have the
          // two paths each holding the lock the other needs next, and PostgreSQL would
          // resolve that by aborting one of them.
          const target = await tx.cancellationRequest.findFirst({
            where: { id: input.requestId, organizationId },
            select: { bookingId: true },
          });

          if (target === null) {
            throw new AppError('NOT_FOUND', { message: 'Cancellation request not found.' });
          }

          await this.lock(tx, target.bookingId, organizationId);

          const locked = await tx.$queryRaw<{ id: string; decision: string }[]>(
            Prisma.sql`SELECT id, decision FROM cancellation_requests
                       WHERE id = ${input.requestId} AND organization_id = ${organizationId}
                       FOR UPDATE`,
          );

          if (locked[0] === undefined) {
            throw new AppError('NOT_FOUND', { message: 'Cancellation request not found.' });
          }

          if (locked[0].decision !== 'PENDING') {
            throw new AppError('REQUEST_ALREADY_DECIDED', {
              message: 'This request has already been decided.',
            });
          }

          const request = await tx.cancellationRequest.findFirstOrThrow({
            where: { id: input.requestId, organizationId },
            select: {
              id: true,
              bookingId: true,
              organizationId: true,
              suggestedRetainedAmountCents: true,
            },
          });

          const booking = await tx.booking.findFirstOrThrow({
            where: { id: request.bookingId, organizationId },
            select: CANCELLABLE,
          });

          const paid = await this.paidTotal(booking, tx);
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

          const reserved = await this.approve(tx, booking, paid, retained, input);
          const refundId = reserved.refundId;

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
            // What the reservation moves, for the same reason the immediate path reports
            // it: the customer is being told a number they will check against their bank.
            refundedCents: reserved.additionalAmountCents,
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
  ): Promise<RefundReservationResult> {
    const now = this.clock.now();
    const current = await this.lock(tx, booking.id, booking.organizationId);

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

    const reserved = await this.reserveRefund(
      tx,
      booking,
      { kind: 'CUMULATIVE_TARGET', targetAmountCents: paid.minus(retained).amountCents },
      {
        reason: RefundReason.CUSTOMER_CANCELLATION,
        officeUserId: input.officeUserId,
        mayIssueRefunds: input.mayIssueRefunds,
      },
    );

    const refundId = reserved.refundId;

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

    return reserved;
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
          // The office route takes the booking id from the caller, so the organization is
          // part of every lookup here rather than assumed from the id alone.
          const organizationId = this.organizations.getOrganizationId();
          const current = await this.lock(tx, input.bookingId, organizationId);

          if (current !== BookingStatus.CONFIRMED) {
            throw notCancellable(`A ${current} booking cannot be cancelled.`);
          }

          const booking = await tx.booking.findFirstOrThrow({
            where: { id: input.bookingId, organizationId },
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

          // ADDITIONAL, not a target: an amount the office typed means "refund this much
          // now", which is a different question from "the customer should end up with
          // this much back".
          const refundId =
            input.refundAmountCents === undefined
              ? null
              : (
                  await this.reserveRefund(
                    tx,
                    booking,
                    { kind: 'ADDITIONAL', amountCents: input.refundAmountCents },
                    {
                      reason: RefundReason.BUSINESS_CANCELLATION,
                      officeUserId: input.officeUserId,
                      mayIssueRefunds: input.mayIssueRefunds,
                      ...(input.refundAmountCents > 0 ? { lenient: false } : {}),
                    },
                  )
                ).refundId;

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
   * Reserve the refund a cancellation implies, through the one path that owns the
   * remaining balance.
   *
   * The target is **cumulative**: "the customer should end up with this much back", not
   * "send this much now". Stated as an instruction, a booking that had already been
   * partly refunded got the gross amount again — more than the charge, which the
   * provider then rejected after the office had been told the cancellation went through.
   *
   * `lenient` because cancelling an unpaid booking is ordinary, not an error.
   */
  private async reserveRefund(
    tx: Prisma.TransactionClient,
    booking: CancellableBooking,
    amount: RefundAmount,
    options: {
      reason: RefundReason;
      mayIssueRefunds: boolean;
      officeUserId?: string;
      lenient?: boolean;
    },
  ): Promise<RefundReservationResult> {
    const reserved = await this.refunds.reserveInTransaction(tx, {
      bookingId: booking.id,
      amount,
      reason: options.reason,
      lenient: options.lenient ?? true,
      ...(options.officeUserId === undefined ? {} : { officeUserId: options.officeUserId }),
    });

    // Checked against what the reservation *actually* moves, not against what the
    // request asked for. Keeping everything moves nothing and needs no capability;
    // anything else does, and only the arithmetic above knows which this is.
    if (reserved.additionalAmountCents > 0 && !options.mayIssueRefunds) {
      // The same code and wording every other capability refusal uses, so a client
      // cannot tell a guard-level refusal from this one.
      throw new AppError('FORBIDDEN_ROLE', {
        message: 'Your account may not perform this action.',
      });
    }

    return reserved;
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

  /**
   * Lock the booking row and return its current status.
   *
   * The organization is part of the predicate rather than checked afterwards: a row
   * belonging to another tenant must not be locked at all, and a `FOR UPDATE` that finds
   * nothing is the same 404 as a booking that does not exist.
   */
  private async lock(
    tx: Prisma.TransactionClient,
    bookingId: string,
    organizationId: string,
  ): Promise<BookingStatus> {
    const rows = await tx.$queryRaw<{ status: BookingStatus }[]>(
      Prisma.sql`SELECT status FROM bookings
                 WHERE id = ${bookingId} AND organization_id = ${organizationId}
                 FOR UPDATE`,
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

  /**
   * What the customer has actually handed over, card and cash together.
   *
   * Read through the financial root rather than off the booking's own relation. A
   * reschedule leaves the payment on the row it arrived on, so a replacement booking
   * looks unpaid to anything that asks it directly — and a cancellation that believed
   * that refunded nothing while telling the customer the money was on its way.
   */
  private async paidTotal(
    booking: CancellableBooking,
    tx?: Prisma.TransactionClient,
  ): Promise<Money> {
    const financials = await this.financials.load(booking.id, tx);

    return receivedFrom(financials, booking.currency);
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
}

function notCancellable(message: string): AppError {
  return new AppError('BOOKING_NOT_CANCELLABLE', { message });
}
