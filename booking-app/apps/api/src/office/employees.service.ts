import { Inject, Injectable } from '@nestjs/common';

import { BLOCKING_BOOKING_STATUSES } from '../booking/booking-status.machine.js';
import { AppError } from '../common/errors/app-error.js';
import { CLOCK } from '../domain/time/clock.js';
import { dateColumnToLocalDate } from '../domain/time/local-time.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { uncoveredBookings } from './schedule-coverage.js';

import type { EmployeeSnapshot } from '../domain/availability/types.js';
import type { Clock } from '../domain/time/clock.js';
import type { Employee } from '../prisma/client.js';
import type {
  AvailabilityExceptionListResponse,
  ConflictingBooking,
  CreateAvailabilityExceptionRequest,
  CreateAvailabilityExceptionResponse,
  CreateEmployeeRequest,
  EmployeeListResponse,
  EmployeeServicesResponse,
  OfficeEmployee,
  ReplaceEmployeeServicesRequest,
  ReplaceWorkingHoursRequest,
  ReplaceWorkingHoursResponse,
  UpdateEmployeeRequest,
} from '@shape-and-flow/booking-contracts';

/** Enough of a booking to say which appointment is in the way. */
const CONFLICT_FIELDS = {
  id: true,
  reference: true,
  startsAt: true,
  endsAt: true,
  blockStartsAt: true,
  blockEndsAt: true,
  serviceNameSnapshot: true,
  customer: { select: { firstName: true, lastName: true } },
} as const;

/**
 * Staff, and the weekly rule behind their availability.
 *
 * Two shapes of refusal live here, and the difference is deliberate. **Archiving** an
 * employee with appointments ahead of them is refused outright — the row would stop
 * being bookable while those appointments still expect somebody to keep them.
 * **Shortening** their hours is not: the appointments are reported back and the change
 * is saved, because an office rearranging next month's rota should not have to cancel
 * three customers before it can press save.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(includeArchived: boolean): Promise<EmployeeListResponse> {
    const rows = await this.prisma.employee.findMany({
      where: {
        organizationId: this.organizationId(),
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ displayOrder: 'asc' }, { displayName: 'asc' }],
    });

    return { items: rows.map(toDto) };
  }

  async get(id: string): Promise<OfficeEmployee> {
    return toDto(await this.load(id));
  }

  async create(input: CreateEmployeeRequest): Promise<OfficeEmployee> {
    const employee = await this.prisma.employee.create({
      data: {
        organizationId: this.organizationId(),
        firstName: input.firstName,
        lastName: input.lastName,
        // What a customer sees, and what an office would have typed anyway. Derived
        // rather than required, so the common case is one fewer field to fill in.
        displayName: input.displayName ?? `${input.firstName} ${input.lastName}`,
        ...optional('email', input.email),
        ...optional('phone', input.phone),
        ...optional('bio', input.bio),
        ...optional('photoUrl', input.photoUrl),
        ...optional('displayOrder', input.displayOrder),
        ...optional('isBookableOnline', input.isBookableOnline),
      },
    });

    return toDto(employee);
  }

  async update(id: string, patch: UpdateEmployeeRequest): Promise<OfficeEmployee> {
    await this.load(id);

    const employee = await this.prisma.employee.update({
      where: { id },
      data: {
        ...optional('firstName', patch.firstName),
        ...optional('lastName', patch.lastName),
        ...optional('displayName', patch.displayName),
        ...optional('email', patch.email),
        ...optional('phone', patch.phone),
        ...optional('bio', patch.bio),
        ...optional('photoUrl', patch.photoUrl),
        ...optional('displayOrder', patch.displayOrder),
        ...optional('isBookableOnline', patch.isBookableOnline),
      },
    });

    return toDto(employee);
  }

  /**
   * Archive, unless there are appointments left to keep.
   *
   * "Future" is measured on `endsAt`, not `startsAt`: an appointment that began ten
   * minutes ago is still one somebody has to finish, and counting only what has not
   * started would let an employee be archived out from under it.
   */
  async archive(id: string): Promise<OfficeEmployee> {
    const employee = await this.load(id);
    if (employee.archivedAt !== null) return toDto(employee);

    const bookingCount = await this.prisma.booking.count({
      where: {
        organizationId: this.organizationId(),
        employeeId: id,
        status: { in: [...BLOCKING_BOOKING_STATUSES] },
        endsAt: { gt: this.clock.now() },
      },
    });

    if (bookingCount > 0) {
      throw new AppError('EMPLOYEE_HAS_FUTURE_BOOKINGS', {
        message: 'This employee still has appointments ahead of them.',
        details: { bookingCount },
      });
    }

    return toDto(
      await this.prisma.employee.update({
        where: { id },
        data: { archivedAt: this.clock.now() },
      }),
    );
  }

  /**
   * Replace the whole week in one transaction.
   *
   * Delete-then-insert rather than a diff: the request states what the week *is*, and
   * reconciling it into a minimal set of row edits would be more code with more ways to
   * leave a break attached to a shift that no longer exists. Breaks cascade from their
   * segment, so the delete takes them with it.
   *
   * Shape is already validated by the contract — segments do not overlap, breaks lie
   * inside their segment — so what is left here is the part only the database knows:
   * which appointments the new week no longer covers.
   */
  async replaceWorkingHours(
    employeeId: string,
    body: ReplaceWorkingHoursRequest,
  ): Promise<ReplaceWorkingHoursResponse> {
    await this.load(employeeId);
    const organizationId = this.organizationId();

    const segments = await this.prisma.$transaction(async (tx) => {
      await tx.workingHours.deleteMany({ where: { organizationId, employeeId } });

      const created = [];
      for (const segment of body.segments) {
        created.push(
          await tx.workingHours.create({
            data: {
              organizationId,
              employeeId,
              weekday: segment.weekday,
              startMinute: segment.startMinute,
              endMinute: segment.endMinute,
              breaks: {
                create: segment.breaks.map((rest) => ({
                  organizationId,
                  startMinute: rest.startMinute,
                  endMinute: rest.endMinute,
                  ...optional('label', rest.label),
                })),
              },
            },
            select: {
              id: true,
              weekday: true,
              startMinute: true,
              endMinute: true,
              breaks: {
                select: { startMinute: true, endMinute: true, label: true },
                orderBy: { startMinute: 'asc' },
              },
            },
          }),
        );
      }

      return created;
    });

    const conflicts = await this.conflictsAfterScheduleChange(employeeId, {
      employeeId,
      workingHours: body.segments.map((segment) => ({
        weekday: segment.weekday,
        startMinute: segment.startMinute,
        endMinute: segment.endMinute,
        breaks: segment.breaks,
      })),
      exceptions: [],
      timeOffDates: [],
      busy: [],
    });

    return { segments, conflictingBookings: conflicts };
  }

  /* ── availability exceptions ────────────────────────────────────────────────── */

  async listAvailabilityExceptions(employeeId: string): Promise<AvailabilityExceptionListResponse> {
    await this.load(employeeId);

    const rows = await this.prisma.availabilityException.findMany({
      where: { organizationId: this.organizationId(), employeeId },
      orderBy: { date: 'asc' },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        employeeId: row.employeeId,
        date: dateColumnToLocalDate(row.date),
        kind: row.kind,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        reason: row.reason,
      })),
    };
  }

  async createAvailabilityException(
    employeeId: string,
    body: CreateAvailabilityExceptionRequest,
  ): Promise<CreateAvailabilityExceptionResponse> {
    await this.load(employeeId);

    const exception = await this.prisma.availabilityException.create({
      data: {
        organizationId: this.organizationId(),
        employeeId,
        date: new Date(`${body.date}T00:00:00.000Z`),
        kind: body.kind,
        ...(body.kind === 'EXTRA_HOURS'
          ? { startMinute: body.startMinute, endMinute: body.endMinute }
          : {}),
        ...optional('reason', body.reason),
      },
    });

    // Same treatment as a working-hours change, and for the same reason: closing a
    // Tuesday somebody is already booked into is a thing an office is allowed to do,
    // and a thing it needs to be told about.
    const conflictingBookings = await this.conflictsAfterScheduleChange(
      employeeId,
      await this.snapshotOf(employeeId),
    );

    return {
      exception: {
        id: exception.id,
        employeeId: exception.employeeId,
        date: dateColumnToLocalDate(exception.date),
        kind: exception.kind,
        startMinute: exception.startMinute,
        endMinute: exception.endMinute,
        reason: exception.reason,
      },
      conflictingBookings,
    };
  }

  async deleteAvailabilityException(employeeId: string, id: string): Promise<void> {
    await this.load(employeeId);

    const deleted = await this.prisma.availabilityException.deleteMany({
      where: { id, employeeId, organizationId: this.organizationId() },
    });

    if (deleted.count === 0) throw notFound('Availability exception not found.');
  }

  /* ── service assignment ─────────────────────────────────────────────────────── */

  async listServices(employeeId: string): Promise<EmployeeServicesResponse> {
    await this.load(employeeId);

    const rows = await this.prisma.employeeService.findMany({
      where: { organizationId: this.organizationId(), employeeId },
      select: {
        serviceId: true,
        priceOverrideCents: true,
        service: { select: { name: true, priceCents: true, currency: true } },
      },
      orderBy: { service: { displayOrder: 'asc' } },
    });

    return {
      items: rows.map((row) => ({
        serviceId: row.serviceId,
        serviceName: row.service.name,
        priceOverrideCents: row.priceOverrideCents,
        listPriceCents: row.service.priceCents,
        effectivePriceCents: row.priceOverrideCents ?? row.service.priceCents,
        currency: row.service.currency,
      })),
    };
  }

  /**
   * Replace the assignment set.
   *
   * Removing a pairing somebody is already booked for is refused, and that asymmetry
   * with working hours is on purpose: shortening a shift leaves the appointment
   * describable — it is simply outside the rota — while removing the pairing takes away
   * the answer to "may this person perform this service", which the booking has already
   * been sold on.
   */
  async replaceServices(
    employeeId: string,
    body: ReplaceEmployeeServicesRequest,
  ): Promise<EmployeeServicesResponse> {
    await this.load(employeeId);
    const organizationId = this.organizationId();

    const wanted = new Map(
      body.assignments.map((assignment) => [
        assignment.serviceId,
        assignment.priceOverrideCents ?? null,
      ]),
    );

    const existing = await this.prisma.employeeService.findMany({
      where: { organizationId, employeeId },
      select: { serviceId: true },
    });

    const removed = existing
      .map((row) => row.serviceId)
      .filter((serviceId) => !wanted.has(serviceId));

    if (removed.length > 0) {
      const blocking = await this.prisma.booking.groupBy({
        by: ['serviceId'],
        where: {
          organizationId,
          employeeId,
          serviceId: { in: removed },
          status: { in: [...BLOCKING_BOOKING_STATUSES] },
          endsAt: { gt: this.clock.now() },
        },
        _count: { _all: true },
      });

      const first = blocking[0];
      if (first !== undefined) {
        throw new AppError('EMPLOYEE_HAS_FUTURE_BOOKINGS', {
          message: 'This employee still has appointments for a service you are removing.',
          details: { bookingCount: first._count._all, serviceId: first.serviceId },
        });
      }
    }

    const services = await this.prisma.service.findMany({
      where: { organizationId, id: { in: [...wanted.keys()] } },
      select: { id: true },
    });

    if (services.length !== wanted.size) {
      // A 404 rather than a per-id list: which of the ids was unknown is not something
      // this endpoint needs to help somebody enumerate.
      throw notFound('One of those services does not exist.');
    }

    await this.prisma.$transaction(async (tx) => {
      if (removed.length > 0) {
        await tx.employeeService.deleteMany({
          where: { organizationId, employeeId, serviceId: { in: removed } },
        });
      }

      for (const [serviceId, priceOverrideCents] of wanted) {
        await tx.employeeService.upsert({
          where: { employeeId_serviceId: { employeeId, serviceId } },
          create: { organizationId, employeeId, serviceId, priceOverrideCents },
          update: { priceOverrideCents },
          select: { id: true },
        });
      }
    });

    return await this.listServices(employeeId);
  }

  /* ── internals ──────────────────────────────────────────────────────────────── */

  /** The employee, or a 404 that does not distinguish "absent" from "another tenant's". */
  private async load(id: string): Promise<Employee> {
    const employee = await this.prisma.employee.findFirst({
      where: { id, organizationId: this.organizationId() },
    });

    if (employee === null) throw notFound('Employee not found.');
    return employee;
  }

  /**
   * The appointments a just-saved schedule no longer covers.
   *
   * Only appointments still ahead of us are considered. Yesterday's cannot be moved and
   * reporting them would bury the two that matter under a year of history.
   */
  private async conflictsAfterScheduleChange(
    employeeId: string,
    snapshot: EmployeeSnapshot,
  ): Promise<ConflictingBooking[]> {
    const bookings = await this.prisma.booking.findMany({
      where: {
        organizationId: this.organizationId(),
        employeeId,
        status: { in: [...BLOCKING_BOOKING_STATUSES] },
        endsAt: { gt: this.clock.now() },
      },
      select: CONFLICT_FIELDS,
      orderBy: { startsAt: 'asc' },
    });

    return uncoveredBookings(bookings, snapshot, this.organizations.getTimezone()).map(
      (booking) => ({
        id: booking.id,
        reference: booking.reference,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        customerName: `${booking.customer.firstName} ${booking.customer.lastName}`,
        serviceName: booking.serviceNameSnapshot,
      }),
    );
  }

  /** The employee's current rule, as the engine's snapshot shape. */
  private async snapshotOf(employeeId: string): Promise<EmployeeSnapshot> {
    const organizationId = this.organizationId();

    const [workingHours, exceptions] = await Promise.all([
      this.prisma.workingHours.findMany({
        where: { organizationId, employeeId },
        select: {
          weekday: true,
          startMinute: true,
          endMinute: true,
          breaks: { select: { startMinute: true, endMinute: true } },
        },
      }),
      this.prisma.availabilityException.findMany({
        where: { organizationId, employeeId, date: { gte: startOfUtcDay(this.clock.now()) } },
        select: { date: true, kind: true, startMinute: true, endMinute: true },
      }),
    ]);

    return {
      employeeId,
      workingHours,
      exceptions: exceptions.map((exception) => ({
        date: dateColumnToLocalDate(exception.date),
        kind: exception.kind,
        startMinute: exception.startMinute,
        endMinute: exception.endMinute,
      })),
      // Neither is consulted by the coverage check: time off and existing bookings say
      // whether a slot is *free*, and this asks whether it is *within the rota*.
      timeOffDates: [],
      busy: [],
    };
  }

  private organizationId(): string {
    return this.organizations.getOrganizationId();
  }
}

/** One day of slack, so an exception on today's date is still considered. */
function startOfUtcDay(now: Date): Date {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

/**
 * A field, present only when the caller sent it.
 *
 * `exactOptionalPropertyTypes` is on, so `{ email: undefined }` is not the same as an
 * absent key — and to Prisma the difference is "leave it alone" versus a type error.
 * `null` passes through, because clearing a field is a thing a patch may mean.
 */
function optional<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Record<Key, Value> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}

function notFound(message: string): AppError {
  return new AppError('NOT_FOUND', { message });
}

/** Exported for the controllers, which map the same row shape. */
export function toDto(employee: {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  bio: string | null;
  photoUrl: string | null;
  displayOrder: number;
  isBookableOnline: boolean;
  archivedAt: Date | null;
}): OfficeEmployee {
  return {
    id: employee.id,
    firstName: employee.firstName,
    lastName: employee.lastName,
    displayName: employee.displayName,
    email: employee.email,
    phone: employee.phone,
    bio: employee.bio,
    photoUrl: employee.photoUrl,
    displayOrder: employee.displayOrder,
    isBookableOnline: employee.isBookableOnline,
    archivedAt: employee.archivedAt?.toISOString() ?? null,
  };
}
