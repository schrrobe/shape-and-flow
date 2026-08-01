import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { isExclusionViolation, isUniqueViolation } from '../common/prisma-errors/prisma-errors.js';
import { withSerializationRetry } from '../common/prisma-errors/serialization-retry.js';
import { isSlotBookable } from '../domain/availability/engine.js';
import { selectEmployee } from '../domain/employee-selection/select-employee.js';
import { Money } from '../domain/money/money.js';
import { CLOCK } from '../domain/time/clock.js';
import { instantToLocalDate } from '../domain/time/local-time.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { BookingStatus } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AvailabilitySnapshotService } from '../public/availability-snapshot.service.js';

import { generateBookingReference } from './booking-reference.js';
import { BLOCKING_BOOKING_STATUSES, assertTransition } from './booking-status.machine.js';
import { withCalendarLock } from './calendar-lock.js';
import { CustomerUpsertService } from './customer-upsert.service.js';

import type { CustomerInput } from './customer-upsert.service.js';
import type { EmployeeCandidate } from '../domain/employee-selection/select-employee.js';
import type { Clock } from '../domain/time/clock.js';
import type { Booking, BookingOrigin, Prisma } from '../prisma/client.js';
import type { Locale } from '@shape-and-flow/booking-contracts';

/** How many references to try before giving up. Each collision is a 1-in-a-billion event. */
const REFERENCE_ATTEMPTS = 5;

export interface ReserveInput {
  serviceId: string;
  /** `null` means "any available employee", resolved here before the insert. */
  employeeId: string | null;
  startsAt: Date;
  customer: CustomerInput;
  locale: Locale;
  customerNote?: string | undefined;
  origin?: BookingOrigin | undefined;
}

export interface ReserveResult {
  booking: Booking;
  employee: { id: string; displayName: string };
  price: Money;
}

/**
 * Turns a slot request into a booking nothing else can take.
 *
 * Three mechanisms overlap here, and each covers what the others cannot:
 *
 *  - The **exclusion constraint** makes two overlapping bookings for one employee
 *    impossible at the storage layer. It is the only guarantee that holds against a
 *    bug in this file.
 *  - The **advisory lock** extends that to the tables no constraint can span —
 *    blocked times and time off — by serialising check-and-insert per employee.
 *  - The **re-check inside the lock** is what makes the answer current. Availability
 *    was computed for the customer some seconds ago; the state that matters is the
 *    state at insert time.
 *
 * Removing any one of them leaves a real hole, which is why all three are here rather
 * than whichever felt sufficient.
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger('Reservation');

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly snapshots: AvailabilitySnapshotService,
    private readonly customers: CustomerUpsertService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const organization = this.organizations.get();
    const settings = organization.settings;

    const service = await this.loadService(input.serviceId);
    this.assertWithinBookingWindow(input.startsAt);

    // Resolved before the transaction opens, because "any available employee" needs a
    // snapshot read and there is no reason to hold a lock while doing it. The
    // re-check inside the lock is what makes the choice safe.
    const employeeId = await this.resolveEmployee(input, service);

    const expiresAt = new Date(
      this.clock.now().getTime() + settings.reservationTtlMinutes * 60_000,
    );

    return await withSerializationRetry(
      () => this.insert({ ...input, employeeId }, service, expiresAt),
      'reserve',
    );
  }

  /** The service, with the buffers and price the booking will snapshot. */
  private async loadService(serviceId: string): Promise<{
    id: string;
    name: string;
    durationMinutes: number;
    prepBufferMinutes: number;
    cleanupBufferMinutes: number;
    priceCents: number;
    currency: string;
  }> {
    const organizationId = this.organizations.getOrganizationId();

    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, organizationId, archivedAt: null, isBookableOnline: true },
      select: {
        id: true,
        name: true,
        durationMinutes: true,
        prepBufferMinutes: true,
        cleanupBufferMinutes: true,
        priceCents: true,
        currency: true,
      },
    });

    if (service === null) {
      throw new AppError('NOT_FOUND', { message: 'Service not found.' });
    }

    return service;
  }

  /**
   * Refuse a slot outside the bookable window before taking any lock.
   *
   * The engine already refuses to *offer* such a slot, so this only fires for a
   * request that did not come from the availability endpoint — which is precisely the
   * request that must not be trusted.
   */
  private assertWithinBookingWindow(startsAt: Date): void {
    const settings = this.organizations.getSettings();
    const now = this.clock.now();

    const earliest = new Date(now.getTime() + settings.minimumNoticeHours * 3_600_000);
    const latest = new Date(now.getTime() + settings.bookingHorizonDays * 86_400_000);

    if (startsAt < earliest || startsAt > latest) {
      throw new AppError('OUTSIDE_BOOKING_WINDOW', {
        message:
          `Bookings need ${String(settings.minimumNoticeHours)} hours' notice and open ` +
          `${String(settings.bookingHorizonDays)} days ahead.`,
      });
    }
  }

  /**
   * Pick the employee, or verify the one that was asked for.
   *
   * "Any available" is resolved to a concrete id here rather than left null in the
   * database. A null resource would mean the exclusion constraint had nothing to
   * constrain, and the booking would be double-bookable by construction.
   */
  private async resolveEmployee(input: ReserveInput, service: { id: string }): Promise<string> {
    if (input.employeeId !== null) return input.employeeId;

    const snapshot = await this.snapshots.load({
      serviceId: service.id,
      from: instantToLocalDate(input.startsAt, this.organizations.getTimezone()),
      to: instantToLocalDate(input.startsAt, this.organizations.getTimezone()),
    });

    const free = snapshot.employees
      .map((employee) => employee.employeeId)
      .filter((employeeId) => isSlotBookable(snapshot, employeeId, input.startsAt));

    if (free.length === 0) {
      throw new AppError('SLOT_UNAVAILABLE', { message: 'That slot is no longer available.' });
    }

    const candidates = await this.loadCandidates(free, input.startsAt);
    return selectEmployee(candidates);
  }

  /**
   * Load count and display order for each free employee, so the pick is load-balanced.
   *
   * One grouped query and one employee query, not one per candidate.
   */
  private async loadCandidates(
    employeeIds: string[],
    startsAt: Date,
  ): Promise<EmployeeCandidate[]> {
    const organizationId = this.organizations.getOrganizationId();
    const zone = this.organizations.getTimezone();
    const date = instantToLocalDate(startsAt, zone);

    // The local day, as an instant range. Padded like the snapshot window for the same
    // reason: local midnight is not UTC midnight.
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);

    const [employees, counts] = await Promise.all([
      this.prisma.employee.findMany({
        where: { organizationId, id: { in: employeeIds } },
        select: { id: true, displayOrder: true },
      }),
      this.prisma.booking.groupBy({
        by: ['employeeId'],
        where: {
          organizationId,
          employeeId: { in: employeeIds },
          status: { in: [...BLOCKING_BOOKING_STATUSES] },
          startsAt: { gte: dayStart, lt: dayEnd },
        },
        _count: { _all: true },
      }),
    ]);

    const byEmployee = new Map(counts.map((row) => [row.employeeId, row._count._all]));

    return employees.map((employee) => ({
      employeeId: employee.id,
      bookingsThatDay: byEmployee.get(employee.id) ?? 0,
      displayOrder: employee.displayOrder,
    }));
  }

  /** The transaction: lock, re-check, upsert the customer, insert, record history. */
  private async insert(
    input: ReserveInput & { employeeId: string },
    service: {
      id: string;
      name: string;
      durationMinutes: number;
      prepBufferMinutes: number;
      cleanupBufferMinutes: number;
      priceCents: number;
      currency: string;
    },
    expiresAt: Date,
  ): Promise<ReserveResult> {
    const organizationId = this.organizations.getOrganizationId();
    const { employeeId } = input;

    try {
      return await this.prisma.$transaction(
        async (tx) =>
          await withCalendarLock(tx, [employeeId], async () => {
            // Read *after* the lock. The snapshot the customer saw is stale by
            // definition; this one cannot be overtaken before the insert.
            const snapshot = await this.snapshots.loadForSlot(tx, {
              serviceId: service.id,
              employeeId,
              startsAt: input.startsAt,
            });

            if (!isSlotBookable(snapshot, employeeId, input.startsAt)) {
              throw new AppError('SLOT_UNAVAILABLE', {
                message: 'That slot is no longer available.',
              });
            }

            const employee = await tx.employee.findFirstOrThrow({
              where: { id: employeeId, organizationId },
              select: { id: true, displayName: true },
            });

            const customer = await this.customers.upsert(tx, organizationId, input.customer);

            // Buffers come from the snapshot, so a service edited between the read and
            // the insert cannot shift the block bounds under us.
            const endsAt = new Date(
              input.startsAt.getTime() + snapshot.service.durationMinutes * 60_000,
            );
            const blockStartsAt = new Date(
              input.startsAt.getTime() - snapshot.service.prepBufferMinutes * 60_000,
            );
            const blockEndsAt = new Date(
              endsAt.getTime() + snapshot.service.cleanupBufferMinutes * 60_000,
            );

            assertTransition(null, BookingStatus.PENDING_PAYMENT);

            const booking = await this.insertWithReference(tx, {
              organizationId,
              origin: input.origin ?? 'ONLINE',
              customerId: customer.id,
              employeeId,
              serviceId: service.id,
              startsAt: input.startsAt,
              endsAt,
              blockStartsAt,
              blockEndsAt,
              serviceNameSnapshot: service.name,
              durationMinutesSnapshot: snapshot.service.durationMinutes,
              prepBufferMinutesSnapshot: snapshot.service.prepBufferMinutes,
              cleanupBufferMinutesSnapshot: snapshot.service.cleanupBufferMinutes,
              priceCentsSnapshot: service.priceCents,
              currency: service.currency,
              status: BookingStatus.PENDING_PAYMENT,
              expiresAt,
              locale: input.locale,
              ...(input.customerNote === undefined ? {} : { customerNote: input.customerNote }),
            });

            // In the same transaction, so a booking can never exist without the row
            // that explains how it got its status.
            await tx.bookingStatusHistory.create({
              data: {
                organizationId,
                bookingId: booking.id,
                fromStatus: null,
                toStatus: BookingStatus.PENDING_PAYMENT,
                actorType: 'CUSTOMER',
              },
            });

            return {
              booking,
              employee,
              price: Money.fromCents(service.priceCents, service.currency),
            };
          }),
        // Generous but bounded. The lock is held for the whole transaction, so a
        // stuck one delays other reservations for the same employee.
        { isolationLevel: 'ReadCommitted', timeout: 15_000, maxWait: 10_000 },
      );
    } catch (error) {
      // The constraint fired, which means another transaction won the slot between the
      // re-check and the insert. A 409 is the honest answer; a 500 would be a lie.
      if (isExclusionViolation(error, 'bookings_no_overlap')) {
        this.logger.debug(`slot taken concurrently for employee ${employeeId}`);
        throw new AppError('SLOT_UNAVAILABLE', {
          message: 'That slot is no longer available.',
        });
      }

      throw error;
    }
  }

  /**
   * Insert, retrying on a reference collision.
   *
   * The retry is inside the transaction, so a collision costs one statement rather
   * than the whole reservation. Note the savepoint behaviour this relies on: a failed
   * statement inside a Prisma interactive transaction does not abort the transaction,
   * so a second insert can follow the first.
   */
  private async insertWithReference(
    tx: Prisma.TransactionClient,
    data: Omit<Prisma.BookingUncheckedCreateInput, 'reference'>,
  ): Promise<Booking> {
    for (let attempt = 1; ; attempt += 1) {
      const reference = generateBookingReference();

      try {
        return await tx.booking.create({ data: { ...data, reference } });
      } catch (error) {
        // The key is composite — (organizationId, reference) — so the column name is what
        // the violation reports.
        const collided = isUniqueViolation(error, 'reference');

        if (!collided || attempt >= REFERENCE_ATTEMPTS) throw error;

        this.logger.warn(`booking reference ${reference} collided; retrying`);
      }
    }
  }
}
