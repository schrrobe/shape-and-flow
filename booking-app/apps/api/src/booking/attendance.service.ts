import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { withSerializationRetry } from '../common/prisma-errors/serialization-retry.js';
import { CLOCK } from '../domain/time/clock.js';
import { BookingStatus, Prisma } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { AuditService } from './audit.service.js';
import { assertTransition } from './booking-status.machine.js';

import type { Clock } from '../domain/time/clock.js';
import type { AuditAction } from '../prisma/client.js';

/**
 * How long a finished appointment may sit unmarked before it is worth reporting.
 *
 * Two days: long enough that a business closed over a weekend is not nagged, short
 * enough that the backlog is still recent enough for somebody to remember.
 */
export const STALE_COMPLETION_AFTER_MS = 48 * 60 * 60_000;

/** Bounded, so one sweep cannot try to report a year of neglect at once. */
const STALE_SAMPLE_LIMIT = 50;

/**
 * Closing out an appointment: it happened, or the customer did not come.
 *
 * Both are human observations, which is why nothing here is automatic. A booking whose
 * time has passed is not evidence that the appointment took place — the customer may not
 * have turned up, the business may have been closed — and guessing would put a wrong fact
 * into the record that later reporting is built on.
 *
 * The time guards match what each status actually claims. `COMPLETED` says the
 * appointment finished, so it needs `endsAt` in the past. `NO_SHOW` says the customer
 * failed to arrive, which is knowable once the appointment has *started*. Marking either
 * one early would be recording something nobody could yet know.
 */
@Injectable()
export class AttendanceService {
  private readonly logger = new Logger('Attendance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The appointment took place. */
  async complete(bookingId: string, officeUserId: string): Promise<void> {
    await this.settle({
      bookingId,
      officeUserId,
      to: BookingStatus.COMPLETED,
      action: 'BOOKING_MARKED_COMPLETED',
      // `endsAt`, not `startsAt`: an appointment still in progress has not finished.
      guard: (booking, now) =>
        booking.endsAt <= now ? null : 'This appointment has not finished yet.',
      timestamp: (now) => ({ completedAt: now }),
    });
  }

  /**
   * The customer did not arrive.
   *
   * Note what this does *not* do: release the slot. The time was consumed whether or not
   * anyone used it, and the employee was there. Freeing it would also be pointless — the
   * past is not bookable.
   */
  async markNoShow(bookingId: string, officeUserId: string): Promise<void> {
    await this.settle({
      bookingId,
      officeUserId,
      to: BookingStatus.NO_SHOW,
      action: 'BOOKING_MARKED_NO_SHOW',
      guard: (booking, now) =>
        booking.startsAt <= now ? null : 'This appointment has not started yet.',
      timestamp: () => ({}),
    });
  }

  /**
   * The shared shape: lock, check the transition, check the time, write, audit.
   *
   * Both guards fail with `INVALID_STATUS_TRANSITION` and a `details.reason` naming which
   * one refused. The office needs to know whether the answer is "not yet" or "not from
   * this status", and those are different problems.
   */
  private async settle(input: {
    bookingId: string;
    officeUserId: string;
    to: BookingStatus;
    action: AuditAction;
    guard: (booking: { startsAt: Date; endsAt: Date }, now: Date) => string | null;
    timestamp: (now: Date) => { completedAt?: Date };
  }): Promise<void> {
    await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const now = this.clock.now();

          const locked = await tx.$queryRaw<{ status: BookingStatus }[]>(
            Prisma.sql`SELECT status FROM bookings WHERE id = ${input.bookingId} FOR UPDATE`,
          );

          const current = locked[0]?.status;

          if (current === undefined) {
            throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
          }

          const booking = await tx.booking.findUniqueOrThrow({
            where: { id: input.bookingId },
            select: { organizationId: true, startsAt: true, endsAt: true, reference: true },
          });

          // Status first: a COMPLETED booking being marked NO_SHOW is a different mistake
          // from marking a future appointment, and the transition table says so.
          assertTransition(current, input.to);

          const refusal = input.guard(booking, now);

          if (refusal !== null) {
            throw new AppError('INVALID_STATUS_TRANSITION', {
              status: 422,
              message: refusal,
              details: { reason: 'TIME_GUARD', from: current, to: input.to },
            });
          }

          await tx.booking.update({
            where: { id: input.bookingId },
            data: { status: input.to, ...input.timestamp(now) },
          });

          await tx.bookingStatusHistory.create({
            data: {
              organizationId: booking.organizationId,
              bookingId: input.bookingId,
              fromStatus: current,
              toStatus: input.to,
              actorType: 'OFFICE',
              actorOfficeUserId: input.officeUserId,
            },
          });

          await this.audit.record(tx, {
            organizationId: booking.organizationId,
            officeUserId: input.officeUserId,
            action: input.action,
            entityType: 'Booking',
            entityId: input.bookingId,
            summary: `${booking.reference} marked ${input.to}`,
            before: { status: current },
            after: { status: input.to },
          });
        }),
      `attendance-${input.to}`,
    );
  }

  /**
   * Report appointments nobody has closed out.
   *
   * Deliberately a report, not a fix. Auto-completing would manufacture the observation
   * this service exists to record, and the resulting figures would describe what the
   * scheduler assumed rather than what happened. So it counts them and says so, and a
   * human decides.
   */
  async reportStaleCompletions(): Promise<{ count: number }> {
    const cutoff = new Date(this.clock.now().getTime() - STALE_COMPLETION_AFTER_MS);

    const [count, sample] = await Promise.all([
      this.prisma.booking.count({
        where: { status: BookingStatus.CONFIRMED, endsAt: { lt: cutoff } },
      }),
      this.prisma.booking.findMany({
        where: { status: BookingStatus.CONFIRMED, endsAt: { lt: cutoff } },
        orderBy: { endsAt: 'asc' },
        take: STALE_SAMPLE_LIMIT,
        select: { reference: true, endsAt: true },
      }),
    ]);

    if (count > 0) {
      this.logger.warn(
        `${String(count)} confirmed bookings ended more than 48 hours ago and are still ` +
          `unmarked; oldest: ${sample.map((row) => row.reference).join(', ')}`,
      );
    }

    return { count };
  }
}
