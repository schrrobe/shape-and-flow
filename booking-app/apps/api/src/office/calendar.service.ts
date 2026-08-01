import { Injectable } from '@nestjs/common';

import { EmployeeScopeService } from '../auth/employee-scope.service.js';
import { BLOCKING_BOOKING_STATUSES } from '../booking/booking-status.machine.js';
import { addLocalDays, wallClockToInstantOrThrow } from '../domain/time/local-time.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { deriveDisplayStatus } from './display-status.js';

import type { OfficeSession } from '../auth/session.store.js';
import type { LocalDate } from '../domain/time/local-time.js';
import type {
  OfficeCalendarQuery,
  OfficeCalendarResponse,
} from '@shape-and-flow/booking-contracts';

/** Everything a calendar row needs, named rather than included wholesale. */
const BOOKING_FOR_CALENDAR = {
  id: true,
  reference: true,
  status: true,
  startsAt: true,
  endsAt: true,
  blockStartsAt: true,
  blockEndsAt: true,
  employeeId: true,
  serviceId: true,
  serviceNameSnapshot: true,
  priceCentsSnapshot: true,
  currency: true,
  origin: true,
  customer: { select: { firstName: true, lastName: true } },
  // Nested rather than two more round trips. Prisma counts a nested read as one
  // operation, which is what keeps this whole method inside its query budget.
  cancellationRequests: { where: { decision: 'PENDING' as const }, select: { id: true } },
  rescheduleRequests: { where: { decision: 'PENDING' as const }, select: { id: true } },
} as const;

/**
 * The office calendar, in one bounded read.
 *
 * Five queries, and — the part that matters — five for a day and five for two months,
 * for one employee and for twenty. The integration test asserts that rather than
 * trusting it: an N+1 here would be invisible in a unit test and obvious only on the
 * morning somebody opens a two-month view.
 */
@Injectable()
export class CalendarService {
  constructor(
    // The root client rather than the tenant-guarded one, for the reason the availability
    // snapshot uses it: every query below is explicitly scoped by the organization from
    // the session, visible in each `where`.
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly scope: EmployeeScopeService,
  ) {}

  async load(session: OfficeSession, query: OfficeCalendarQuery): Promise<OfficeCalendarResponse> {
    const zone = this.organizations.getTimezone();
    const organizationId = session.organizationId;

    // An employee asking for a colleague is refused here, before anything is read, and
    // refused with 404 — see EmployeeScopeService for why it is not a 403.
    if (query.employeeId !== undefined) {
      this.scope.assertMayAccessEmployee(session, query.employeeId);
    }

    const employees = this.employeeFilter(session, query.employeeId);
    const from = this.startOfLocalDay(query.from, zone);
    // Exclusive: the instant the day after `to` begins, so the last day is whole
    // however long it is. A DST day is 23 or 25 hours and this is right for both.
    const to = this.startOfLocalDay(addLocalDays(query.to, 1, zone), zone);

    const statuses = query.includeInactive ? undefined : [...BLOCKING_BOOKING_STATUSES];

    const [bookings, blockedTimes, timeOff, closedDays, workingHours] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          organizationId,
          ...employees,
          ...(statuses === undefined ? {} : { status: { in: statuses } }),
          // Overlap on the *blocking* span, not the appointment: a booking whose cleanup
          // buffer reaches into the window is why that time is unavailable, and a
          // calendar that hid it would show free time that is not.
          blockStartsAt: { lt: to },
          blockEndsAt: { gt: from },
        },
        select: BOOKING_FOR_CALENDAR,
        orderBy: { startsAt: 'asc' },
      }),
      this.prisma.blockedTime.findMany({
        where: { organizationId, ...employees, startsAt: { lt: to }, endsAt: { gt: from } },
        select: { id: true, employeeId: true, startsAt: true, endsAt: true, reason: true },
        orderBy: { startsAt: 'asc' },
      }),
      this.prisma.timeOff.findMany({
        where: {
          organizationId,
          ...employees,
          status: 'APPROVED',
          // Inclusive local dates, so an absence ending on `from` still covers that day.
          startDate: { lte: this.dateOnly(query.to) },
          endDate: { gte: this.dateOnly(query.from) },
        },
        select: {
          id: true,
          employeeId: true,
          startDate: true,
          endDate: true,
          reason: true,
        },
        orderBy: { startDate: 'asc' },
      }),
      this.prisma.closedDay.findMany({
        where: {
          organizationId,
          date: { gte: this.dateOnly(query.from), lte: this.dateOnly(query.to) },
        },
        select: { date: true, reason: true },
        orderBy: { date: 'asc' },
      }),
      this.prisma.workingHours.findMany({
        where: { organizationId, ...employees },
        select: {
          employeeId: true,
          weekday: true,
          startMinute: true,
          endMinute: true,
          breaks: { select: { startMinute: true, endMinute: true, label: true } },
        },
        orderBy: [{ employeeId: 'asc' }, { startMinute: 'asc' }],
      }),
    ]);

    return {
      bookings: bookings.map((booking) => ({
        id: booking.id,
        reference: booking.reference,
        status: booking.status,
        displayStatus: deriveDisplayStatus(booking, {
          cancellation: booking.cancellationRequests.length > 0,
          reschedule: booking.rescheduleRequests.length > 0,
        }),
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        blockStartsAt: booking.blockStartsAt.toISOString(),
        blockEndsAt: booking.blockEndsAt.toISOString(),
        employeeId: booking.employeeId,
        serviceId: booking.serviceId,
        serviceName: booking.serviceNameSnapshot,
        customerName: `${booking.customer.firstName} ${booking.customer.lastName}`,
        origin: booking.origin,
        price: { amountCents: booking.priceCentsSnapshot, currency: booking.currency },
      })),
      blockedTimes: blockedTimes.map((blocked) => ({
        id: blocked.id,
        employeeId: blocked.employeeId,
        startsAt: blocked.startsAt.toISOString(),
        endsAt: blocked.endsAt.toISOString(),
        reason: blocked.reason,
      })),
      timeOff: timeOff.map((absence) => ({
        id: absence.id,
        employeeId: absence.employeeId,
        startDate: toLocalDate(absence.startDate),
        endDate: toLocalDate(absence.endDate),
        reason: absence.reason,
      })),
      closedDays: closedDays.map((day) => ({ date: toLocalDate(day.date), reason: day.reason })),
      workingHours: workingHours.map((segment) => ({
        employeeId: segment.employeeId,
        weekday: segment.weekday,
        startMinute: segment.startMinute,
        endMinute: segment.endMinute,
        breaks: segment.breaks,
      })),
    };
  }

  /**
   * The employee filter, combining what the session allows with what was asked for.
   *
   * The session's scope is applied whether or not a parameter was passed, so omitting
   * `employeeId` cannot widen what an employee sees.
   */
  private employeeFilter(
    session: OfficeSession,
    requested: string | undefined,
  ): { employeeId?: { in: string[] } | string } {
    if (requested !== undefined) return { employeeId: requested };

    return this.scope.employeeFilter(session);
  }

  /**
   * Midnight local, as an instant.
   *
   * Phase 1 serves Europe/Berlin, where midnight always exists — its transitions are at
   * 02:00 and 03:00. A zone that shifts *at* midnight would make this throw rather than
   * answer wrongly, which is the right failure: a calendar silently off by an hour is
   * worse than one that refuses.
   */
  private startOfLocalDay(date: LocalDate, zone: string): Date {
    return wallClockToInstantOrThrow(date, 0, zone);
  }

  /** A `YYYY-MM-DD` as the UTC midnight a Postgres `date` column compares against. */
  private dateOnly(date: LocalDate): Date {
    return new Date(`${date}T00:00:00.000Z`);
  }
}

/** A `date` column comes back as UTC midnight, so the calendar part is the whole value. */
function toLocalDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
