import { Inject, Injectable } from '@nestjs/common';

import { EmployeeScopeService } from '../auth/employee-scope.service.js';
import { BLOCKING_BOOKING_STATUSES } from '../booking/booking-status.machine.js';
import { withCalendarLock } from '../booking/calendar-lock.js';
import { AppError } from '../common/errors/app-error.js';
import { isExclusionViolation } from '../common/prisma-errors/prisma-errors.js';
import { CLOCK } from '../domain/time/clock.js';
import {
  addLocalDays,
  dateColumnToLocalDate,
  localDateToDateColumn,
  wallClockToInstantOrThrow,
} from '../domain/time/local-time.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { OfficeSession } from '../auth/session.store.js';
import type { Clock } from '../domain/time/clock.js';
import type { LocalDate } from '../domain/time/local-time.js';
import type { Prisma } from '../prisma/client.js';
import type {
  BlockedTime,
  BlockedTimeListQuery,
  BlockedTimeListResponse,
  ClosedDay,
  ClosedDayListQuery,
  ClosedDayListResponse,
  CreateBlockedTimeRequest,
  CreateClosedDayRequest,
  CreateTimeOffRequest,
  TimeOffEntry,
  TimeOffListQuery,
  TimeOffListResponse,
  UpdateTimeOffRequest,
} from '@shape-and-flow/booking-contracts';

/**
 * Every write that takes time off an employee's calendar.
 *
 * All three of these — blocked time, approved leave, a closed day — make a slot
 * unbookable without inserting a booking, which is exactly the class of change the
 * exclusion constraint cannot see. So each one runs the same shape the reservation path
 * runs: **open a transaction, take the per-employee advisory lock, re-check, write.**
 *
 * Without the lock the failure is not theoretical. A customer's reservation reads
 * availability and then inserts; a blocked time written between those two statements
 * lands on top of a booking that was legal when it was checked. The lock is what makes
 * "check then act" atomic per employee, and taking the *same* lock is what puts these
 * writes and that read in one queue rather than two.
 *
 * The `blocked_times_no_overlap` exclusion constraint is still the backstop underneath:
 * it is the only guarantee that survives a bug in this file.
 */
@Injectable()
export class AvailabilityAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly scope: EmployeeScopeService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /* ── blocked time ───────────────────────────────────────────────────────────── */

  async listBlockedTimes(
    session: OfficeSession,
    query: BlockedTimeListQuery,
  ): Promise<BlockedTimeListResponse> {
    const zone = this.organizations.getTimezone();

    if (query.employeeId !== undefined) {
      this.scope.assertMayAccessEmployee(session, query.employeeId);
    }

    const rows = await this.prisma.blockedTime.findMany({
      where: {
        organizationId: session.organizationId,
        ...this.employeeFilter(session, query.employeeId),
        startsAt: { lt: this.startOfDay(addLocalDays(query.to, 1, zone), zone) },
        endsAt: { gt: this.startOfDay(query.from, zone) },
      },
      orderBy: { startsAt: 'asc' },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        employeeId: row.employeeId,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async createBlockedTime(
    session: OfficeSession,
    body: CreateBlockedTimeRequest,
  ): Promise<BlockedTime> {
    this.scope.assertMayAccessEmployee(session, body.employeeId);
    await this.assertEmployeeExists(session.organizationId, body.employeeId);

    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(body.endsAt);

    try {
      const row = await this.prisma.$transaction(
        async (tx) =>
          await withCalendarLock(tx, [body.employeeId], async () => {
            // Read after the lock, so nothing can take the slot between the check and
            // the insert. Compared on block time, because a booking's buffers are the
            // employee's time too — blocking the ten minutes of cleanup after an
            // appointment is still blocking time that appointment needs.
            const clash = await tx.booking.findFirst({
              where: {
                organizationId: session.organizationId,
                employeeId: body.employeeId,
                status: { in: [...BLOCKING_BOOKING_STATUSES] },
                blockStartsAt: { lt: endsAt },
                blockEndsAt: { gt: startsAt },
              },
              select: { id: true, reference: true },
            });

            if (clash !== null) {
              throw new AppError('SLOT_UNAVAILABLE', {
                message: 'An appointment already occupies that time.',
                details: { bookingReference: clash.reference },
              });
            }

            return await tx.blockedTime.create({
              data: {
                organizationId: session.organizationId,
                employeeId: body.employeeId,
                startsAt,
                endsAt,
                createdByOfficeUserId: session.officeUserId,
                ...(body.reason === undefined || body.reason === null
                  ? {}
                  : { reason: body.reason }),
              },
            });
          }),
        { isolationLevel: 'ReadCommitted', timeout: 15_000, maxWait: 10_000 },
      );

      return {
        id: row.id,
        employeeId: row.employeeId,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      };
    } catch (error) {
      // Two blocked times for one employee cannot overlap, and the constraint says so
      // in the one place that holds against a bug up there. A 409 is the honest answer
      // to "that time is already blocked"; a 500 would not be.
      if (isExclusionViolation(error, 'blocked_times_no_overlap')) {
        throw new AppError('SLOT_UNAVAILABLE', {
          message: 'That time is already blocked.',
        });
      }

      throw error;
    }
  }

  async deleteBlockedTime(session: OfficeSession, id: string): Promise<void> {
    const row = await this.prisma.blockedTime.findFirst({
      where: { id, organizationId: session.organizationId },
      select: { employeeId: true },
    });

    if (row === null) throw notFound('Blocked time not found.');
    this.scope.assertMayAccessEmployee(session, row.employeeId);

    const deleted = await this.prisma.blockedTime.deleteMany({
      where: { id, organizationId: session.organizationId },
    });

    if (deleted.count === 0) throw notFound('Blocked time not found.');
  }

  /* ── time off ───────────────────────────────────────────────────────────────── */

  async listTimeOff(session: OfficeSession, query: TimeOffListQuery): Promise<TimeOffListResponse> {
    if (query.employeeId !== undefined) {
      this.scope.assertMayAccessEmployee(session, query.employeeId);
    }

    const rows = await this.prisma.timeOff.findMany({
      where: {
        organizationId: session.organizationId,
        ...this.employeeFilter(session, query.employeeId),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.to === undefined ? {} : { startDate: { lte: localDateToDateColumn(query.to) } }),
        ...(query.from === undefined
          ? {}
          : { endDate: { gte: localDateToDateColumn(query.from) } }),
      },
      orderBy: { startDate: 'asc' },
    });

    return { items: rows.map(toTimeOffDto) };
  }

  /**
   * Record leave, refusing to approve it over appointments that already exist.
   *
   * `REQUESTED` leave is written without the check, because it changes nothing: only
   * `APPROVED` rows remove days from availability, so only they can contradict a
   * booking. Approving later goes through the same check via `updateTimeOff`.
   */
  async createTimeOff(session: OfficeSession, body: CreateTimeOffRequest): Promise<TimeOffEntry> {
    this.scope.assertMayAccessEmployee(session, body.employeeId);
    await this.assertEmployeeExists(session.organizationId, body.employeeId);

    const row = await this.prisma.$transaction(
      async (tx) =>
        await withCalendarLock(tx, [body.employeeId], async () => {
          if (body.status === 'APPROVED') {
            await this.assertNoBookingsInRange(
              tx,
              session.organizationId,
              body.employeeId,
              body.startDate,
              body.endDate,
            );
          }

          return await tx.timeOff.create({
            data: {
              organizationId: session.organizationId,
              employeeId: body.employeeId,
              startDate: localDateToDateColumn(body.startDate),
              endDate: localDateToDateColumn(body.endDate),
              status: body.status,
              ...(body.reason === undefined || body.reason === null ? {} : { reason: body.reason }),
              ...(body.status === 'APPROVED'
                ? {
                    decidedByOfficeUserId: session.officeUserId,
                    decidedAt: this.clock.now(),
                  }
                : {}),
            },
          });
        }),
      { isolationLevel: 'ReadCommitted', timeout: 15_000, maxWait: 10_000 },
    );

    return toTimeOffDto(row);
  }

  async updateTimeOff(
    session: OfficeSession,
    id: string,
    body: UpdateTimeOffRequest,
  ): Promise<TimeOffEntry> {
    const existing = await this.prisma.timeOff.findFirst({
      where: { id, organizationId: session.organizationId },
      select: { id: true, employeeId: true, startDate: true, endDate: true, status: true },
    });

    if (existing === null) throw notFound('Time off not found.');
    // An EMPLOYEE may read their own leave but not decide it — the role matrix says
    // "own, read-only" — which the controller enforces with @Roles. This is the
    // row-level half: even an ADMIN cannot reach a colleague's row of another tenant.
    this.scope.assertMayAccessEmployee(session, existing.employeeId);

    const row = await this.prisma.$transaction(
      async (tx) =>
        await withCalendarLock(tx, [existing.employeeId], async () => {
          if (body.status === 'APPROVED' && existing.status !== 'APPROVED') {
            await this.assertNoBookingsInRange(
              tx,
              session.organizationId,
              existing.employeeId,
              dateColumnToLocalDate(existing.startDate),
              dateColumnToLocalDate(existing.endDate),
            );
          }

          return await tx.timeOff.update({
            where: { id, organizationId: session.organizationId },
            data: {
              status: body.status,
              ...(body.reason === undefined ? {} : { reason: body.reason }),
              ...(body.status === 'REQUESTED'
                ? { decidedByOfficeUserId: null, decidedAt: null }
                : {
                    decidedByOfficeUserId: session.officeUserId,
                    decidedAt: this.clock.now(),
                  }),
            },
          });
        }),
      { isolationLevel: 'ReadCommitted', timeout: 15_000, maxWait: 10_000 },
    );

    return toTimeOffDto(row);
  }

  /* ── closed days ────────────────────────────────────────────────────────────── */

  async listClosedDays(
    session: OfficeSession,
    query: ClosedDayListQuery,
  ): Promise<ClosedDayListResponse> {
    const rows = await this.prisma.closedDay.findMany({
      where: {
        organizationId: session.organizationId,
        date: { gte: localDateToDateColumn(query.from), lte: localDateToDateColumn(query.to) },
      },
      orderBy: { date: 'asc' },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        date: dateColumnToLocalDate(row.date),
        reason: row.reason,
      })),
    };
  }

  /**
   * Close a day for the whole organization.
   *
   * An upsert rather than a create that can collide: "we are closed on the 24th,
   * because of the holiday" said twice means the same thing both times, and a 409 for
   * repeating yourself is a worse answer than updating the reason. The unique index on
   * `(organizationId, date)` is what makes that expressible in one statement.
   *
   * No advisory lock, and no conflict check: a closed day is organization-wide, so
   * there is no single employee to serialise on, and existing appointments are left
   * standing rather than cancelled — the calendar shows both, and a person decides.
   */
  async createClosedDay(session: OfficeSession, body: CreateClosedDayRequest): Promise<ClosedDay> {
    const row = await this.prisma.closedDay.upsert({
      where: {
        organizationId_date: {
          organizationId: session.organizationId,
          date: localDateToDateColumn(body.date),
        },
      },
      create: {
        organizationId: session.organizationId,
        date: localDateToDateColumn(body.date),
        ...(body.reason === undefined || body.reason === null ? {} : { reason: body.reason }),
      },
      update: { reason: body.reason ?? null },
    });

    return { id: row.id, date: dateColumnToLocalDate(row.date), reason: row.reason };
  }

  async deleteClosedDay(session: OfficeSession, id: string): Promise<void> {
    const deleted = await this.prisma.closedDay.deleteMany({
      where: { id, organizationId: session.organizationId },
    });

    if (deleted.count === 0) throw notFound('Closed day not found.');
  }

  /* ── internals ──────────────────────────────────────────────────────────────── */

  /**
   * Refuse to remove days somebody is booked into.
   *
   * The range is resolved through the local-time primitives rather than by adding
   * 86 400 000 milliseconds per day: leave that spans a DST boundary is 23 or 25 hours
   * on one of its days, and the appointment at the far end is either inside or outside
   * the range depending on which arithmetic was used.
   */
  private async assertNoBookingsInRange(
    tx: Prisma.TransactionClient,
    organizationId: string,
    employeeId: string,
    startDate: LocalDate,
    endDate: LocalDate,
  ): Promise<void> {
    const zone = this.organizations.getTimezone();
    const from = this.startOfDay(startDate, zone);
    const to = this.startOfDay(addLocalDays(endDate, 1, zone), zone);

    const bookingCount = await tx.booking.count({
      where: {
        organizationId,
        employeeId,
        status: { in: [...BLOCKING_BOOKING_STATUSES] },
        startsAt: { gte: from, lt: to },
      },
    });

    if (bookingCount > 0) {
      throw new AppError('EMPLOYEE_HAS_FUTURE_BOOKINGS', {
        message: 'This employee has appointments during that time.',
        details: { bookingCount },
      });
    }
  }

  private async assertEmployeeExists(organizationId: string, employeeId: string): Promise<void> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, organizationId },
      select: { id: true },
    });

    if (employee === null) throw notFound('Employee not found.');
  }

  /** The session's scope, narrowed further if the caller asked for one employee. */
  private employeeFilter(
    session: OfficeSession,
    requested: string | undefined,
  ): { employeeId?: { in: string[] } | string } {
    if (requested !== undefined) return { employeeId: requested };
    return this.scope.employeeFilter(session);
  }

  private startOfDay(date: LocalDate, zone: string): Date {
    return wallClockToInstantOrThrow(date, 0, zone);
  }
}

function toTimeOffDto(row: {
  id: string;
  employeeId: string;
  startDate: Date;
  endDate: Date;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED';
  reason: string | null;
  createdAt: Date;
}): TimeOffEntry {
  return {
    id: row.id,
    employeeId: row.employeeId,
    startDate: dateColumnToLocalDate(row.startDate),
    endDate: dateColumnToLocalDate(row.endDate),
    status: row.status,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

function notFound(message: string): AppError {
  return new AppError('NOT_FOUND', { message });
}
