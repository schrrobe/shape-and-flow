import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { isExclusionViolation, isUniqueViolation } from '../common/prisma-errors/prisma-errors.js';
import { withSerializationRetry } from '../common/prisma-errors/serialization-retry.js';
import { isSlotBookable } from '../domain/availability/engine.js';
import { CLOCK } from '../domain/time/clock.js';
import { instantToLocalDate } from '../domain/time/local-time.js';
import { ManagementTokenService } from '../manage/management-token.service.js';
import { OutboxRecorder } from '../messaging/outbox/outbox.recorder.js';
import { JOB } from '../messaging/queues/job-contracts.js';
import { RequestNotificationService } from '../notification/request-notification.service.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { BookingStatus, Prisma } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AvailabilitySnapshotService } from '../public/availability-snapshot.service.js';

import { AuditService } from './audit.service.js';
import { generateBookingReference } from './booking-reference.js';
import { assertTransition } from './booking-status.machine.js';
import { withCalendarLock } from './calendar-lock.js';

import type { AvailabilitySnapshot } from '../domain/availability/types.js';
import type { Clock } from '../domain/time/clock.js';

export interface RequestRescheduleInput {
  bookingId: string;
  requestedStartsAt: Date;
  /** Absent keeps the current employee. */
  requestedEmployeeId?: string | undefined;
  reason?: string | undefined;
}

export interface DecideRescheduleInput {
  requestId: string;
  officeUserId: string;
  decision: 'APPROVED' | 'REJECTED';
  note?: string | undefined;
}

/** Everything an approval needs to build the replacement booking. */
const RESCHEDULABLE = {
  id: true,
  organizationId: true,
  status: true,
  reference: true,
  customerId: true,
  employeeId: true,
  serviceId: true,
  startsAt: true,
  endsAt: true,
  serviceNameSnapshot: true,
  durationMinutesSnapshot: true,
  prepBufferMinutesSnapshot: true,
  cleanupBufferMinutesSnapshot: true,
  priceCentsSnapshot: true,
  currency: true,
  customerNote: true,
  locale: true,
  origin: true,
  financialRootBookingId: true,
} as const;

/**
 * Moves an appointment to a new slot without either slot being wrong in between.
 *
 * The naive approach — cancel, then rebook — has a window where the customer has no
 * appointment and anyone can take the old slot. Doing it the other way round has a window
 * where they hold two. So the swap is one transaction: the new booking is inserted and the
 * old one cancelled together, and if the new slot turns out to be taken the whole thing
 * rolls back and the request stays open for another try.
 *
 * That transaction holds **two** advisory locks, one per employee, taken in sorted order.
 * Sorted because two reschedules crossing each other — A moving to B's employee while B
 * moves to A's — would otherwise each hold the lock the other needs next.
 *
 * The replacement carries the *original* snapshots. A service repriced since the booking
 * was made must not silently change what the customer agreed to pay.
 */
@Injectable()
export class RescheduleService {
  private readonly logger = new Logger('Reschedule');

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly snapshots: AvailabilitySnapshotService,
    private readonly outbox: OutboxRecorder,
    private readonly audit: AuditService,
    private readonly tokens: ManagementTokenService,
    private readonly requestNotifications: RequestNotificationService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Ask for a new slot. Changes nothing about the booking.
   *
   * The original slot stays blocked and the booking stays CONFIRMED: until the office
   * agrees, the customer still has the appointment they had.
   */
  async requestByCustomer(input: RequestRescheduleInput): Promise<{ requestId: string }> {
    const now = this.clock.now();
    const booking = await this.load(input.bookingId);

    if (booking.status !== BookingStatus.CONFIRMED) {
      throw notReschedulable(`A ${booking.status} booking cannot be rescheduled.`);
    }

    if (booking.startsAt <= now) {
      throw notReschedulable('This appointment has already started.');
    }

    this.assertWithinWindow(input.requestedStartsAt);

    const employeeId = input.requestedEmployeeId ?? booking.employeeId;

    // An optimistic check, so an obviously impossible request is refused now rather than
    // sitting in the office's queue until somebody tries to approve it. Not a guarantee:
    // the real check happens inside the lock at approval time.
    await this.assertPlausible(booking, employeeId, input.requestedStartsAt);

    try {
      return await withSerializationRetry(
        () =>
          this.prisma.$transaction(async (tx) => {
            // The checks above ran outside any transaction. Re-read under the lock, or a
            // booking cancelled — or started — in between still collects a PENDING
            // request that blocks the next legitimate one and outlives its booking.
            const locked = await this.lockBooking(tx, booking.id, booking.organizationId);

            if (locked.status !== BookingStatus.CONFIRMED) {
              throw notReschedulable(`A ${locked.status} booking cannot be rescheduled.`);
            }

            if (locked.startsAt <= this.clock.now()) {
              throw notReschedulable('This appointment has already started.');
            }

            const request = await tx.rescheduleRequest.create({
              data: {
                organizationId: booking.organizationId,
                bookingId: booking.id,
                requestedStartsAt: input.requestedStartsAt,
                ...(input.requestedEmployeeId === undefined
                  ? {}
                  : { requestedEmployeeId: input.requestedEmployeeId }),
                ...(input.reason === undefined ? {} : { reason: input.reason }),
              },
              select: { id: true },
            });

            // A real notification row in this transaction, so the confirmation that the
            // request arrived commits with the request itself.
            await this.requestNotifications.queueRescheduleReceived(tx, {
              requestId: request.id,
              bookingId: booking.id,
              requestedStartsAt: input.requestedStartsAt,
            });

            return { requestId: request.id };
          }),
        'open-reschedule-request',
      );
    } catch (error) {
      // The partial unique index allows one PENDING request per booking.
      if (isUniqueViolation(error, 'reschedule_requests_one_open')) {
        throw notReschedulable('A reschedule request for this booking is already open.');
      }

      throw error;
    }
  }

  /**
   * The office decides.
   *
   * Approving swaps the slots in one transaction. Rejecting closes the request and touches
   * nothing else.
   */
  async decide(input: DecideRescheduleInput): Promise<{ newBookingId: string | null }> {
    return await withSerializationRetry(() => this.decideOnce(input), 'decide-reschedule');
  }

  private async decideOnce(input: DecideRescheduleInput): Promise<{ newBookingId: string | null }> {
    // Read outside the transaction purely to learn which employees to lock. The values are
    // re-read under the lock before anything is written.
    const organizationId = this.organizations.getOrganizationId();

    const request = await this.prisma.rescheduleRequest.findFirst({
      where: { id: input.requestId, organizationId },
      select: {
        id: true,
        bookingId: true,
        requestedStartsAt: true,
        requestedEmployeeId: true,
        booking: { select: { employeeId: true } },
      },
    });

    if (request === null) {
      throw new AppError('NOT_FOUND', { message: 'Reschedule request not found.' });
    }

    const employeeIds = [
      request.booking.employeeId,
      request.requestedEmployeeId ?? request.booking.employeeId,
    ];

    try {
      return await this.prisma.$transaction(
        async (tx) =>
          // Both employees, sorted — see the note on withCalendarLock. With one employee
          // the set collapses to one lock.
          await withCalendarLock(tx, employeeIds, async () => {
            const decision = await this.lockRequest(tx, input.requestId, organizationId);

            if (input.decision === 'REJECTED') {
              await this.writeDecision(tx, input, null);
              await this.requestNotifications.queueRescheduleDecided(tx, {
                requestId: decision.id,
                bookingId: decision.bookingId,
                approved: false,
                note: input.note ?? null,
              });
              await this.auditDecision(tx, decision.organizationId, input, null);
              return { newBookingId: null };
            }

            const newBookingId = await this.approve(tx, decision, input);
            return { newBookingId };
          }),
        { isolationLevel: 'ReadCommitted', timeout: 15_000, maxWait: 10_000 },
      );
    } catch (error) {
      // Somebody took the requested slot between the request and the approval. The whole
      // transaction rolls back, so the request stays PENDING and the office can try again
      // or reject it.
      if (isExclusionViolation(error, 'bookings_no_overlap')) {
        this.logger.debug(`requested slot taken before approval of ${input.requestId}`);
        throw new AppError('SLOT_UNAVAILABLE', {
          message: 'The requested slot is no longer available.',
        });
      }

      throw error;
    }
  }

  /** Build the replacement, cancel the original, move the link across. */
  private async approve(
    tx: Prisma.TransactionClient,
    request: LockedRequest,
    input: DecideRescheduleInput,
  ): Promise<string> {
    const now = this.clock.now();

    // Scoped by the request's own organization rather than resolved from the booking id
    // alone: the request was located by a caller-supplied id, and the two must agree.
    const booking = await tx.booking.findFirstOrThrow({
      where: { id: request.bookingId, organizationId: request.organizationId },
      select: RESCHEDULABLE,
    });

    if (booking.status !== BookingStatus.CONFIRMED) {
      throw notReschedulable(`A ${booking.status} booking cannot be rescheduled.`);
    }

    const employeeId = request.requestedEmployeeId ?? booking.employeeId;

    // Read inside the lock, so the answer cannot be overtaken before the insert — the same
    // discipline the reservation path uses.
    const snapshot = asSoldSnapshot(
      await this.snapshots.loadForSlot(tx, {
        serviceId: booking.serviceId,
        employeeId,
        startsAt: request.requestedStartsAt,
      }),
      booking,
    );

    if (!isSlotBookable(snapshot, employeeId, request.requestedStartsAt)) {
      throw new AppError('SLOT_UNAVAILABLE', {
        message: 'The requested slot is no longer available.',
      });
    }

    const times = this.timesFor(booking, request.requestedStartsAt);

    assertTransition(null, BookingStatus.CONFIRMED);

    const created = await tx.booking.create({
      data: {
        organizationId: booking.organizationId,
        reference: generateBookingReference(),
        origin: booking.origin,
        customerId: booking.customerId,
        employeeId,
        serviceId: booking.serviceId,
        ...times,
        // The original snapshots, deliberately. A service repriced since the booking was
        // made must not change what the customer agreed to pay.
        serviceNameSnapshot: booking.serviceNameSnapshot,
        durationMinutesSnapshot: booking.durationMinutesSnapshot,
        prepBufferMinutesSnapshot: booking.prepBufferMinutesSnapshot,
        cleanupBufferMinutesSnapshot: booking.cleanupBufferMinutesSnapshot,
        priceCentsSnapshot: booking.priceCentsSnapshot,
        currency: booking.currency,
        status: BookingStatus.CONFIRMED,
        confirmedAt: now,
        ...(booking.customerNote === null ? {} : { customerNote: booking.customerNote }),
        locale: booking.locale,
        // The lineage link: which appointment this one replaced. An audit trail, not a
        // lookup path — the payment itself is moved below.
        rescheduledFromBookingId: booking.id,
        // Copied, not chained. After two moves the charge would otherwise be two hops
        // away and every financial read a different length of walk; this keeps the
        // whole chain one lookup from the booking that was actually paid. The payment,
        // manual payment and refund rows are deliberately left where they are.
        financialRootBookingId: booking.financialRootBookingId ?? booking.id,
      },
      select: { id: true, endsAt: true },
    });

    // The money follows the appointment. `rescheduledFromBookingId` records where the
    // replacement came from, but nothing reads payments through that link — so leaving the
    // payment on the cancelled original means the replacement looks unpaid, and cancelling
    // it later would compute a fee against zero and refund nothing. The refund rows stay
    // where they are: a refund is something that happened to the earlier booking, and the
    // balance that matters travels with the payment's own `refundedAmountCents`.
    await tx.payment.updateMany({
      where: { bookingId: booking.id, organizationId: booking.organizationId },
      data: { bookingId: created.id },
    });

    assertTransition(booking.status, BookingStatus.CANCELED_BY_BUSINESS);

    await tx.booking.update({
      where: { id: booking.id },
      data: {
        status: BookingStatus.CANCELED_BY_BUSINESS,
        canceledAt: now,
        canceledByOfficeUserId: input.officeUserId,
        cancellationReason: 'RESCHEDULED',
      },
    });

    // Two rows, because two bookings changed status and each needs its own explanation.
    await tx.bookingStatusHistory.createMany({
      data: [
        {
          organizationId: booking.organizationId,
          bookingId: booking.id,
          fromStatus: booking.status,
          toStatus: BookingStatus.CANCELED_BY_BUSINESS,
          actorType: 'OFFICE',
          actorOfficeUserId: input.officeUserId,
          reason: 'RESCHEDULED',
        },
        {
          organizationId: booking.organizationId,
          bookingId: created.id,
          fromStatus: null,
          toStatus: BookingStatus.CONFIRMED,
          actorType: 'OFFICE',
          actorOfficeUserId: input.officeUserId,
          reason: `rescheduled from ${booking.reference}`,
        },
      ],
    });

    // The old link is in the customer's mailbox and would otherwise keep opening a booking
    // that has been cancelled, showing them a stale appointment.
    const { token } = await this.tokens.rotate(
      tx,
      booking.id,
      created.id,
      booking.organizationId,
      created.endsAt,
    );

    await this.writeDecision(tx, input, created.id);

    await this.outbox.record(tx, {
      organizationId: booking.organizationId,
      aggregateType: 'Booking',
      aggregateId: created.id,
      eventType: JOB.BOOKING_RESCHEDULED,
      payload: {
        organizationId: booking.organizationId,
        bookingId: created.id,
        previousBookingId: booking.id,
        // The rotated token, so the notification can carry a link that works.
        managementToken: token,
        // The decision message below already tells the customer the appointment moved.
        customerNotificationAlreadyQueued: true,
      },
    });

    // Reminders were scheduled for the old time and have to be scheduled for the new one.
    await this.outbox.record(tx, {
      organizationId: booking.organizationId,
      aggregateType: 'Booking',
      aggregateId: created.id,
      eventType: JOB.REMINDER_SCHEDULE,
      payload: { organizationId: booking.organizationId, bookingId: created.id },
    });

    // Against the replacement, which is the appointment the customer now has, and read
    // through `tx` because it was created a few statements ago and has not committed.
    await this.requestNotifications.queueRescheduleDecided(tx, {
      requestId: request.id,
      bookingId: created.id,
      approved: true,
      managementToken: token,
      note: input.note ?? null,
    });

    await this.auditDecision(tx, booking.organizationId, input, created.id);

    return created.id;
  }

  /**
   * The replacement's times, derived from the original's own duration and buffers.
   *
   * Taken from the booking's snapshots rather than recomputed from the service, for the
   * same reason the price is: the appointment keeps the shape it was sold with.
   */
  private timesFor(
    booking: {
      durationMinutesSnapshot: number;
      prepBufferMinutesSnapshot: number;
      cleanupBufferMinutesSnapshot: number;
    },
    startsAt: Date,
  ): { startsAt: Date; endsAt: Date; blockStartsAt: Date; blockEndsAt: Date } {
    const endsAt = new Date(startsAt.getTime() + booking.durationMinutesSnapshot * 60_000);

    return {
      startsAt,
      endsAt,
      blockStartsAt: new Date(startsAt.getTime() - booking.prepBufferMinutesSnapshot * 60_000),
      blockEndsAt: new Date(endsAt.getTime() + booking.cleanupBufferMinutesSnapshot * 60_000),
    };
  }

  /**
   * Lock the booking row and return what the decision has to be checked against.
   *
   * The organization is part of the predicate rather than checked on the result: a row
   * belonging to another tenant must not be locked at all, and a `FOR UPDATE` that matches
   * nothing is the same 404 as a booking that does not exist.
   */
  private async lockBooking(
    tx: Prisma.TransactionClient,
    bookingId: string,
    organizationId: string,
  ): Promise<{ status: BookingStatus; startsAt: Date }> {
    const rows = await tx.$queryRaw<{ status: BookingStatus; starts_at: Date }[]>(
      Prisma.sql`SELECT status, starts_at FROM bookings
                 WHERE id = ${bookingId} AND organization_id = ${organizationId}
                 FOR UPDATE`,
    );

    const row = rows[0];

    if (row === undefined) {
      throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
    }

    return { status: row.status, startsAt: row.starts_at };
  }

  private async lockRequest(
    tx: Prisma.TransactionClient,
    requestId: string,
    organizationId: string,
  ): Promise<LockedRequest> {
    const rows = await tx.$queryRaw<{ decision: string }[]>(
      Prisma.sql`SELECT decision FROM reschedule_requests
                 WHERE id = ${requestId} AND organization_id = ${organizationId}
                 FOR UPDATE`,
    );

    if (rows[0] === undefined) {
      throw new AppError('NOT_FOUND', { message: 'Reschedule request not found.' });
    }

    if (rows[0].decision !== 'PENDING') {
      throw new AppError('REQUEST_ALREADY_DECIDED', {
        message: 'This request has already been decided.',
      });
    }

    return await tx.rescheduleRequest.findFirstOrThrow({
      where: { id: requestId, organizationId },
      select: {
        id: true,
        organizationId: true,
        bookingId: true,
        requestedStartsAt: true,
        requestedEmployeeId: true,
      },
    });
  }

  private async writeDecision(
    tx: Prisma.TransactionClient,
    input: DecideRescheduleInput,
    resultingBookingId: string | null,
  ): Promise<void> {
    await tx.rescheduleRequest.update({
      where: { id: input.requestId },
      data: {
        decision: input.decision,
        decidedByOfficeUserId: input.officeUserId,
        decidedAt: this.clock.now(),
        ...(input.note === undefined ? {} : { decisionNote: input.note }),
        ...(resultingBookingId === null ? {} : { resultingBookingId }),
      },
    });
  }

  private async auditDecision(
    tx: Prisma.TransactionClient,
    organizationId: string,
    input: DecideRescheduleInput,
    resultingBookingId: string | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      organizationId,
      officeUserId: input.officeUserId,
      action: 'RESCHEDULE_REQUEST_DECIDED',
      entityType: 'RescheduleRequest',
      entityId: input.requestId,
      summary: `Reschedule request ${input.decision.toLowerCase()}`,
      after: { decision: input.decision, resultingBookingId },
    });
  }

  /** Refuse a requested time outside the bookable window before anything else happens. */
  private assertWithinWindow(startsAt: Date): void {
    const settings = this.organizations.getSettings();
    const now = this.clock.now();

    const earliest = new Date(now.getTime() + settings.minimumNoticeHours * 3_600_000);
    const latest = new Date(now.getTime() + settings.bookingHorizonDays * 86_400_000);

    if (startsAt < earliest || startsAt > latest) {
      throw new AppError('OUTSIDE_BOOKING_WINDOW', {
        message:
          `A new time needs ${String(settings.minimumNoticeHours)} hours' notice and must fall ` +
          `within ${String(settings.bookingHorizonDays)} days.`,
      });
    }
  }

  /** A fast, non-binding availability check, so an impossible request is refused early. */
  private async assertPlausible(
    booking: BookingDimensions & { serviceId: string },
    employeeId: string,
    startsAt: Date,
  ): Promise<void> {
    const zone = this.organizations.getTimezone();
    const date = instantToLocalDate(startsAt, zone);

    const snapshot = asSoldSnapshot(
      await this.snapshots.load({
        serviceId: booking.serviceId,
        employeeId,
        from: date,
        to: date,
      }),
      booking,
    );

    if (!isSlotBookable(snapshot, employeeId, startsAt)) {
      throw new AppError('SLOT_UNAVAILABLE', {
        message: 'That slot is not available.',
      });
    }
  }

  private async load(bookingId: string): Promise<
    BookingDimensions & {
      id: string;
      organizationId: string;
      status: BookingStatus;
      startsAt: Date;
      employeeId: string;
      serviceId: string;
    }
  > {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, organizationId: this.organizations.getOrganizationId() },
      select: {
        id: true,
        organizationId: true,
        status: true,
        startsAt: true,
        employeeId: true,
        serviceId: true,
        durationMinutesSnapshot: true,
        prepBufferMinutesSnapshot: true,
        cleanupBufferMinutesSnapshot: true,
      },
    });

    if (booking === null) {
      throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
    }

    return booking;
  }
}

/**
 * The snapshot, re-shaped to the appointment as it was sold.
 *
 * The loader reads the *current* service, which is the right answer for a new booking and
 * the wrong one for a reschedule: this appointment keeps the duration and buffers it was
 * sold with. Without this, a service whose duration was changed since would make its
 * existing bookings either unmovable or movable into slots they do not fit.
 */
function asSoldSnapshot(
  snapshot: AvailabilitySnapshot,
  booking: BookingDimensions,
): AvailabilitySnapshot {
  return {
    ...snapshot,
    service: {
      id: snapshot.service.id,
      durationMinutes: booking.durationMinutesSnapshot,
      prepBufferMinutes: booking.prepBufferMinutesSnapshot,
      cleanupBufferMinutes: booking.cleanupBufferMinutesSnapshot,
    },
  };
}

interface BookingDimensions {
  durationMinutesSnapshot: number;
  prepBufferMinutesSnapshot: number;
  cleanupBufferMinutesSnapshot: number;
}

interface LockedRequest {
  id: string;
  organizationId: string;
  bookingId: string;
  requestedStartsAt: Date;
  requestedEmployeeId: string | null;
}

function notReschedulable(message: string): AppError {
  return new AppError('BOOKING_NOT_RESCHEDULABLE', { message });
}
