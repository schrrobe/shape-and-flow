import { Inject, Injectable } from '@nestjs/common';

import { BLOCKING_BOOKING_STATUSES } from '../booking/booking-status.machine.js';
import { AppError } from '../common/errors/app-error.js';
import { CLOCK } from '../domain/time/clock.js';
import {
  addLocalDays,
  dateColumnToLocalDate,
  eachLocalDate,
  instantToLocalDate,
} from '../domain/time/local-time.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type {
  AvailabilityExceptionSnapshot,
  AvailabilitySnapshot,
  WorkingHoursSnapshot,
} from '../domain/availability/types.js';
import type { Clock } from '../domain/time/clock.js';
import type { LocalDate } from '../domain/time/local-time.js';
import type { Prisma } from '../prisma/client.js';

/** One extra day of slack at each end, so a slot's buffers cannot fall outside the window. */
const WINDOW_PADDING_DAYS = 1;

/** What `load` needs to know, all of it resolved server-side except the service. */
export interface LoadInput {
  serviceId: string;
  /**
   * Absent means every employee who performs the service.
   *
   * Explicitly `| undefined` because `exactOptionalPropertyTypes` is on: a parsed
   * query object has the key present and undefined, which is not the same type as the
   * key being absent.
   */
  employeeId?: string | undefined;
  from: LocalDate;
  to: LocalDate;
}

export interface LoadForSlotInput {
  serviceId: string;
  employeeId: string;
  startsAt: Date;
}

/**
 * Turns the database into the plain snapshot the availability engine consumes.
 *
 * This is where query count is controlled, and it is the only reason the engine can
 * stay a pure function. A month of availability for a handful of employees costs the
 * same number of queries as a single day for one — no query per day, none per
 * employee. The integration test asserts that rather than trusting it, because an N+1
 * here would be invisible in every unit test and obvious only under load.
 */
@Injectable()
export class AvailabilitySnapshotService {
  constructor(
    // The root client, not the tenant-guarded one. Every query below is explicitly
    // scoped by the organization id from the resolved context — visible in each
    // `where` — and the guard's injected scoping cannot express the nested filters
    // these reads need.
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Load a snapshot covering a local date range.
   *
   * Eight queries, and — this is the part that matters — eight for one day and eight
   * for thirty-one, for one employee and for twenty. The plan called for five by
   * counting "exceptions plus time off" and "bookings plus blocked times" as one each;
   * Prisma issues a round trip per `findMany`, and expressing those pairs as SQL
   * UNIONs would trade a readable query for a smaller number. The integration test
   * asserts constancy across range and employee count rather than a magic ceiling,
   * because constancy is the property an N+1 would break.
   */
  async load(input: LoadInput): Promise<AvailabilitySnapshot> {
    const organization = this.organizations.get();
    const organizationId = organization.id;
    const zone = organization.timezone;
    const settings = organization.settings;

    // Independent of each other, so they cost one round trip rather than two. This is the
    // hottest read in the app — every slot-picker render lands here.
    const [service, employeeIds] = await Promise.all([
      this.loadService(organizationId, input.serviceId),
      this.loadEmployeeIds(organizationId, input.serviceId, input.employeeId),
    ]);

    // No employee performs this service, so there is nothing to generate. Returned
    // as an empty snapshot rather than a 404: the service exists and is bookable,
    // there is simply nobody to book it with today.
    if (employeeIds.length === 0) {
      return {
        zone,
        now: this.clock.now(),
        settings: snapshotSettings(settings),
        service,
        closedDates: [],
        employees: [],
      };
    }

    const window = this.window(input.from, input.to, zone);

    const [schedules, exceptionsAndTimeOff, busy, closedDates] = await Promise.all([
      this.loadWorkingHours(organizationId, employeeIds),
      this.loadExceptionsAndTimeOff(organizationId, employeeIds, window),
      this.loadBusy(organizationId, employeeIds, window),
      this.loadClosedDates(organizationId, window),
    ]);

    return {
      zone,
      now: this.clock.now(),
      settings: snapshotSettings(settings),
      service,
      closedDates,
      employees: employeeIds.map((employeeId) => ({
        employeeId,
        workingHours: schedules.get(employeeId) ?? [],
        exceptions: exceptionsAndTimeOff.exceptions.get(employeeId) ?? [],
        timeOffDates: exceptionsAndTimeOff.timeOff.get(employeeId) ?? [],
        busy: busy.get(employeeId) ?? [],
      })),
    };
  }

  /**
   * The same snapshot narrowed to one employee on one day, read through a caller's
   * transaction.
   *
   * Taking the transaction client is the whole point: the reservation re-checks
   * availability *inside* the advisory lock it holds, so the check and the insert see
   * the same state. A re-check against a fresh connection could be overtaken between
   * the two.
   */
  async loadForSlot(
    tx: Prisma.TransactionClient,
    input: LoadForSlotInput,
  ): Promise<AvailabilitySnapshot> {
    const organization = this.organizations.get();
    const organizationId = organization.id;
    const zone = organization.timezone;

    const date = instantToLocalDate(input.startsAt, zone);
    const window = this.window(date, date, zone);

    const service = await this.loadService(organizationId, input.serviceId, tx);

    const [schedules, exceptionsAndTimeOff, busy, closedDates] = await Promise.all([
      this.loadWorkingHours(organizationId, [input.employeeId], tx),
      this.loadExceptionsAndTimeOff(organizationId, [input.employeeId], window, tx),
      this.loadBusy(organizationId, [input.employeeId], window, tx),
      this.loadClosedDates(organizationId, window, tx),
    ]);

    return {
      zone,
      now: this.clock.now(),
      settings: snapshotSettings(organization.settings),
      service,
      closedDates,
      employees: [
        {
          employeeId: input.employeeId,
          workingHours: schedules.get(input.employeeId) ?? [],
          exceptions: exceptionsAndTimeOff.exceptions.get(input.employeeId) ?? [],
          timeOffDates: exceptionsAndTimeOff.timeOff.get(input.employeeId) ?? [],
          busy: busy.get(input.employeeId) ?? [],
        },
      ],
    };
  }

  /**
   * The range to read occupancy and calendar rows for.
   *
   * The bounds are UTC midnight of a padded local date, which serves two kinds of
   * column at once. `@db.Date` columns — exceptions, time off, closed days — are
   * stored as UTC midnight of the local date they mean, so comparing against UTC
   * midnight is exact. Instant columns need the padding anyway: a booking's block
   * time includes buffers and one starting late on the previous local day can reach
   * into this range. A full day of slack comfortably exceeds any zone offset, so the
   * padding covers the difference between local and UTC midnight as well.
   *
   * Over-reading is free here. The engine only consults the dates it generates, so a
   * row from a padding day is simply never looked at.
   */
  private window(from: LocalDate, to: LocalDate, zone: string): { start: Date; end: Date } {
    const paddedFrom = addLocalDays(from, -WINDOW_PADDING_DAYS, zone);
    const paddedTo = addLocalDays(to, WINDOW_PADDING_DAYS + 1, zone);

    return {
      start: new Date(`${paddedFrom}T00:00:00.000Z`),
      end: new Date(`${paddedTo}T00:00:00.000Z`),
    };
  }

  /** Query 1: the service, if it is bookable online and not archived. */
  private async loadService(
    organizationId: string,
    serviceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<AvailabilitySnapshot['service']> {
    const service = await (tx ?? this.prisma).service.findFirst({
      where: { id: serviceId, organizationId, archivedAt: null, isBookableOnline: true },
      select: {
        id: true,
        durationMinutes: true,
        prepBufferMinutes: true,
        cleanupBufferMinutes: true,
      },
    });

    // 404 rather than 403 or a specific "archived" code: whether a service exists is
    // not something an unauthenticated caller gets to learn by probing ids.
    if (service === null) {
      throw new AppError('NOT_FOUND', { message: 'Service not found.' });
    }

    return service;
  }

  /**
   * Query 2: which employees perform it.
   *
   * A named employee that does not perform the service is a 404 for the same reason
   * an unknown service is — and it is the pairing that is unknown, not just the id.
   */
  private async loadEmployeeIds(
    organizationId: string,
    serviceId: string,
    employeeId: string | undefined,
  ): Promise<string[]> {
    const links = await this.prisma.employeeService.findMany({
      where: {
        organizationId,
        serviceId,
        ...(employeeId === undefined ? {} : { employeeId }),
        employee: { isBookableOnline: true, archivedAt: null },
      },
      orderBy: [{ employee: { displayOrder: 'asc' } }, { employeeId: 'asc' }],
      select: { employeeId: true },
    });

    if (employeeId !== undefined && links.length === 0) {
      throw new AppError('NOT_FOUND', { message: 'Service not found.' });
    }

    return links.map((link) => link.employeeId);
  }

  /** Query 3: recurring hours with their breaks, for every employee at once. */
  private async loadWorkingHours(
    organizationId: string,
    employeeIds: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, WorkingHoursSnapshot[]>> {
    const rows = await (tx ?? this.prisma).workingHours.findMany({
      where: { organizationId, employeeId: { in: employeeIds } },
      select: {
        employeeId: true,
        weekday: true,
        startMinute: true,
        endMinute: true,
        breaks: { select: { startMinute: true, endMinute: true } },
      },
    });

    const byEmployee = new Map<string, WorkingHoursSnapshot[]>();

    for (const row of rows) {
      const list = byEmployee.get(row.employeeId) ?? [];
      list.push({
        weekday: row.weekday,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        breaks: row.breaks.map((entry) => ({
          startMinute: entry.startMinute,
          endMinute: entry.endMinute,
        })),
      });
      byEmployee.set(row.employeeId, list);
    }

    return byEmployee;
  }

  /**
   * Query 4: exceptions and approved time off, in one round trip.
   *
   * Time off is stored as a range and the engine wants dates, so the range is
   * expanded here — in memory, per row, rather than by asking the database for a day
   * at a time. Only APPROVED rows block: a request that has not been decided must
   * not quietly remove a day the office might still refuse.
   */
  private async loadExceptionsAndTimeOff(
    organizationId: string,
    employeeIds: string[],
    window: { start: Date; end: Date },
    tx?: Prisma.TransactionClient,
  ): Promise<{
    exceptions: Map<string, AvailabilityExceptionSnapshot[]>;
    timeOff: Map<string, LocalDate[]>;
  }> {
    const client = tx ?? this.prisma;
    const zone = this.organizations.getTimezone();

    const [exceptionRows, timeOffRows] = await Promise.all([
      client.availabilityException.findMany({
        where: {
          organizationId,
          employeeId: { in: employeeIds },
          date: { gte: window.start, lt: window.end },
        },
        select: {
          employeeId: true,
          date: true,
          kind: true,
          startMinute: true,
          endMinute: true,
        },
      }),
      client.timeOff.findMany({
        where: {
          organizationId,
          employeeId: { in: employeeIds },
          status: 'APPROVED',
          startDate: { lt: window.end },
          endDate: { gte: window.start },
        },
        select: { employeeId: true, startDate: true, endDate: true },
      }),
    ]);

    const exceptions = new Map<string, AvailabilityExceptionSnapshot[]>();
    for (const row of exceptionRows) {
      const list = exceptions.get(row.employeeId) ?? [];
      list.push({
        date: dateColumnToLocalDate(row.date),
        kind: row.kind,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
      });
      exceptions.set(row.employeeId, list);
    }

    const timeOff = new Map<string, LocalDate[]>();
    for (const row of timeOffRows) {
      const list = timeOff.get(row.employeeId) ?? [];
      const from = dateColumnToLocalDate(row.startDate);
      const to = dateColumnToLocalDate(row.endDate);
      list.push(...eachLocalDate(from, to, zone));
      timeOff.set(row.employeeId, list);
    }

    return { exceptions, timeOff };
  }

  /**
   * Query 5: everything already occupying these employees.
   *
   * Bookings are compared on **block** time, not appointment time, so buffers are
   * respected — that is what `blockStartsAt`/`blockEndsAt` exist for. Only the
   * blocking statuses count; an expired or cancelled booking frees its slot, and the
   * status set is the same constant the database's exclusion constraint predicate
   * uses.
   */
  private async loadBusy(
    organizationId: string,
    employeeIds: string[],
    window: { start: Date; end: Date },
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, { start: Date; end: Date }[]>> {
    const client = tx ?? this.prisma;

    const [bookings, blocked] = await Promise.all([
      client.booking.findMany({
        where: {
          organizationId,
          employeeId: { in: employeeIds },
          status: { in: [...BLOCKING_BOOKING_STATUSES] },
          blockStartsAt: { lt: window.end },
          blockEndsAt: { gt: window.start },
        },
        // Deliberately just the three columns the engine needs. A public response is
        // built from this snapshot, and a customer name selected here would be one
        // careless projection away from being served.
        select: { employeeId: true, blockStartsAt: true, blockEndsAt: true },
      }),
      client.blockedTime.findMany({
        where: {
          organizationId,
          employeeId: { in: employeeIds },
          startsAt: { lt: window.end },
          endsAt: { gt: window.start },
        },
        select: { employeeId: true, startsAt: true, endsAt: true },
      }),
    ]);

    const busy = new Map<string, { start: Date; end: Date }[]>();

    const add = (employeeId: string, start: Date, end: Date): void => {
      const list = busy.get(employeeId) ?? [];
      list.push({ start, end });
      busy.set(employeeId, list);
    };

    for (const row of bookings) add(row.employeeId, row.blockStartsAt, row.blockEndsAt);
    for (const row of blocked) add(row.employeeId, row.startsAt, row.endsAt);

    return busy;
  }

  /** Organization-wide closures, which remove the day for everyone. */
  private async loadClosedDates(
    organizationId: string,
    window: { start: Date; end: Date },
    tx?: Prisma.TransactionClient,
  ): Promise<LocalDate[]> {
    const rows = await (tx ?? this.prisma).closedDay.findMany({
      where: { organizationId, date: { gte: window.start, lt: window.end } },
      select: { date: true },
    });

    return rows.map((row) => dateColumnToLocalDate(row.date));
  }
}

function snapshotSettings(settings: {
  schedulingIntervalMinutes: number;
  minimumNoticeHours: number;
  bookingHorizonDays: number;
}): AvailabilitySnapshot['settings'] {
  return {
    schedulingIntervalMinutes: settings.schedulingIntervalMinutes,
    minimumNoticeHours: settings.minimumNoticeHours,
    bookingHorizonDays: settings.bookingHorizonDays,
  };
}
