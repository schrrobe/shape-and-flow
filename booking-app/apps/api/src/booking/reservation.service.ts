import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { isExclusionViolation, isUniqueViolation } from '../common/prisma-errors/prisma-errors.js';
import { withSerializationRetry } from '../common/prisma-errors/serialization-retry.js';
import { isSlotBookable } from '../domain/availability/engine.js';
import { asOfficeSnapshot } from '../domain/availability/office-view.js';
import { selectEmployee } from '../domain/employee-selection/select-employee.js';
import { Money } from '../domain/money/money.js';
import { resolveEffectivePrice } from '../domain/pricing/pricing.js';
import { CLOCK } from '../domain/time/clock.js';
import { instantToLocalDate } from '../domain/time/local-time.js';
import { ManagementTokenService } from '../manage/management-token.service.js';
import { OutboxRecorder } from '../messaging/outbox/outbox.recorder.js';
import { JOB } from '../messaging/queues/job-contracts.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { BookingStatus } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AvailabilitySnapshotService } from '../public/availability-snapshot.service.js';

import { generateBookingReference } from './booking-reference.js';
import { BLOCKING_BOOKING_STATUSES, assertTransition } from './booking-status.machine.js';
import { withCalendarLock } from './calendar-lock.js';
import { CustomerUpsertService } from './customer-upsert.service.js';

import type { CustomerInput } from './customer-upsert.service.js';
import type { AvailabilitySnapshot } from '../domain/availability/types.js';
import type { EmployeeCandidate } from '../domain/employee-selection/select-employee.js';
import type { Clock } from '../domain/time/clock.js';
import type { Booking, BookingOrigin, Prisma } from '../prisma/client.js';
import type { Locale } from '@shape-and-flow/booking-contracts';

/** How many references to try before giving up. Each collision is a 1-in-a-billion event. */
const REFERENCE_ATTEMPTS = 5;

/**
 * Who is booking, which decides four things at once.
 *
 * A single discriminant rather than four flags — `skipNoticeCheck`, `confirmed`,
 * `origin`, `officeUserId` — because they are not independent. There is no such thing
 * as an office booking that respects the notice window but is born unpaid, and a set of
 * booleans invites exactly that combination to be assembled by accident.
 *
 * What it decides:
 *
 *  - **The booking window.** A customer may not book inside the minimum-notice window
 *    or past the horizon; the office may. Those are rules about what a customer may
 *    self-serve, not about what the business may write into its own calendar.
 *  - **The starting status.** A customer's booking is PENDING_PAYMENT with an expiry,
 *    held while Stripe answers. An office booking is CONFIRMED with no expiry and no
 *    payment: the money is settled at the desk, or recorded later as a manual payment.
 *  - **The origin**, which the calendar and the exports show.
 *  - **The actor** on the status-history row.
 *
 * What it does *not* decide is the collision rules. Both paths take the same advisory
 * lock, re-check the same snapshot and meet the same exclusion constraint, which is the
 * point of them sharing this file.
 */
export type ReserveActor = { type: 'CUSTOMER' } | { type: 'OFFICE'; officeUserId: string };

export interface ReserveInput {
  serviceId: string;
  /** `null` means "any available employee", resolved here before the insert. */
  employeeId: string | null;
  startsAt: Date;
  customer: CustomerInput;
  locale: Locale;
  customerNote?: string | undefined;
  origin?: BookingOrigin | undefined;
  /** Absent means a customer, which is what every pre-Stage-8 caller meant. */
  actor?: ReserveActor | undefined;
  /**
   * The request's idempotency key, bound to the booking in the same transaction.
   *
   * Present only for the public route, which is the only caller whose retry has to
   * find the reservation its previous attempt made. Absent leaves the booking
   * unbound, exactly as before.
   */
  idempotencyKey?: string | undefined;
}

export interface ReserveResult {
  booking: Booking;
  employee: { id: string; displayName: string };
  price: Money;
  /**
   * Minted only for an office booking, which is confirmed the moment it is created.
   *
   * The plaintext exists here and in the outbox payload and nowhere else — the database
   * keeps a hash — so the confirmation email can carry the /manage link while a database
   * read cannot reconstruct it.
   */
  managementToken?: string;
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
    private readonly tokens: ManagementTokenService,
    private readonly outbox: OutboxRecorder,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const organization = this.organizations.get();
    const settings = organization.settings;
    const actor = input.actor ?? { type: 'CUSTOMER' };

    const service = await this.loadService(input.serviceId);
    // Skipped for the office, which is the one rule the two paths differ on. Everything
    // below this line is identical for both.
    if (actor.type === 'CUSTOMER') this.assertWithinBookingWindow(input.startsAt);

    // Resolved before the transaction opens, because "any available employee" needs a
    // snapshot read and there is no reason to hold a lock while doing it. The
    // re-check inside the lock is what makes the choice safe.
    const employeeId = await this.resolveEmployee(input, service);

    // Null for the office: the CHECK constraint requires `expiresAt` to be non-null
    // exactly while a booking is PENDING_PAYMENT or EXPIRING, and an office booking is
    // neither.
    const expiresAt =
      actor.type === 'CUSTOMER'
        ? new Date(this.clock.now().getTime() + settings.reservationTtlMinutes * 60_000)
        : null;

    return await withSerializationRetry(
      () => this.insert({ ...input, employeeId, actor }, service, expiresAt),
      'reserve',
    );
  }

  /**
   * The reservation a previous attempt at this key already made, if it is still live.
   *
   * The public route calls this before reserving. Without it the sequence that
   * follows a Checkout failure is self-defeating: the first attempt committed a
   * reservation and then failed at the provider, so the retry the 502 asked the
   * customer for reserves the same slot again and is refused SLOT_UNAVAILABLE — by
   * the customer's own hold. The only way out was to wait five minutes for the
   * reservation to expire.
   *
   * `null` for anything not resumable — no claim, a booking that has since expired,
   * been paid, or belongs to another tenant — and the caller reserves normally. The
   * status and expiry conditions are the same ones `reserve()` would establish, so a
   * resumed booking is indistinguishable from a fresh one.
   */
  async resume(idempotencyKey: string): Promise<ReserveResult | null> {
    const organizationId = this.organizations.getOrganizationId();

    const claimed = await this.prisma.idempotencyKey.findFirst({
      where: { key: idempotencyKey, scope: 'booking.create', bookingId: { not: null } },
      select: { bookingId: true },
    });

    if (claimed?.bookingId === null || claimed?.bookingId === undefined) return null;

    // The whole row plus the employee, not a projection: `ReserveResult.booking` is a
    // generated `Booking`, and a hand-listed set of scalars would have to be revisited
    // every time the model gains a column.
    const booking = await this.prisma.booking.findFirst({
      where: {
        id: claimed.bookingId,
        organizationId,
        status: BookingStatus.PENDING_PAYMENT,
        expiresAt: { gt: this.clock.now() },
      },
      include: { employee: { select: { id: true, displayName: true } } },
    });

    if (booking === null) return null;

    const { employee, ...reserved } = booking;

    return {
      booking: reserved,
      employee,
      price: Money.fromCents(reserved.priceCentsSnapshot, reserved.currency),
    };
  }

  /**
   * The service, with the buffers and name the booking will snapshot.
   *
   * Not the price: that depends on which employee performs it, so it is read with the
   * assignment inside the transaction — see `loadEffectiveAssignment`.
   */
  private async loadService(serviceId: string): Promise<{
    id: string;
    name: string;
    durationMinutes: number;
    prepBufferMinutes: number;
    cleanupBufferMinutes: number;
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

  /**
   * The employee-service pairing, and the price that pairing actually costs.
   *
   * Two things the reservation cannot take on trust, resolved by one row read inside
   * the transaction that will do the insert:
   *
   *  - **That this employee performs this service at all.** An explicitly requested
   *    employee never passes through the availability snapshot's assignment filter —
   *    `resolveEmployee` hands the id straight back — and the slot re-check only asks
   *    whether the calendar is free. Without this read, naming an employee who was
   *    never assigned the service, was hidden from online booking, or was archived
   *    books them anyway.
   *  - **What it costs.** `EmployeeService.priceOverrideCents` is what the public
   *    catalog quotes; the booking has to snapshot the same number, or the customer is
   *    shown one price and charged another.
   *
   * A missing pairing is a `NOT_FOUND` with the service's own message, deliberately
   * indistinguishable from an unknown service: whether a particular employee exists,
   * is hidden or is archived is not something a public caller gets to learn by probing.
   * The office may book somebody who is not offered online — that is what
   * `isBookableOnline` means — but nobody may book an archived one.
   */
  private async loadEffectiveAssignment(
    tx: Prisma.TransactionClient,
    input: { organizationId: string; serviceId: string; employeeId: string; actor: ReserveActor },
  ): Promise<{ employee: { id: string; displayName: string }; price: Money }> {
    const assignment = await tx.employeeService.findFirst({
      where: {
        organizationId: input.organizationId,
        serviceId: input.serviceId,
        employeeId: input.employeeId,
        employee: {
          archivedAt: null,
          ...(input.actor.type === 'CUSTOMER' ? { isBookableOnline: true } : {}),
        },
        service: { archivedAt: null },
      },
      select: {
        priceOverrideCents: true,
        employee: { select: { id: true, displayName: true } },
        service: { select: { priceCents: true, currency: true } },
      },
    });

    if (assignment === null) {
      throw new AppError('NOT_FOUND', { message: 'Service not found.' });
    }

    return {
      employee: assignment.employee,
      price: resolveEffectivePrice(assignment.service, assignment),
    };
  }

  /**
   * Take ownership of the in-flight idempotency key, so the retry can find this row.
   *
   * The claim is what turns a key from "this request ran" into "this request holds a
   * reservation". `ReservationService.resume()` reads it back, and
   * `IdempotencyService.abandon()` keeps a bound key alive for exactly that reason.
   *
   * A key that is not claimable — swept, completed, or never begun — is refused
   * rather than ignored: reserving without a claim would produce a hold nothing can
   * find again, which is the failure this exists to remove.
   */
  private async claimIdempotencyKey(
    tx: Prisma.TransactionClient,
    key: string | undefined,
  ): Promise<string | null> {
    if (key === undefined) return null;

    const claimed = await tx.idempotencyKey.findFirst({
      where: { key, scope: 'booking.create', state: 'IN_PROGRESS' },
      select: { id: true },
    });

    if (claimed === null) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', {
        message: 'Booking attempt is not claimable.',
      });
    }

    // `Booking.idempotencyKeyId` is unique, and a previous attempt at this key may
    // still be holding it on a reservation that has since lapsed. That booking is
    // finished with; the live attempt is the one that needs the claim.
    await tx.booking.updateMany({
      where: { idempotencyKeyId: claimed.id },
      data: { idempotencyKeyId: null },
    });

    return claimed.id;
  }

  /** The transaction: lock, re-check, upsert the customer, insert, record history. */
  private async insert(
    input: ReserveInput & { employeeId: string; actor: ReserveActor },
    service: {
      id: string;
      name: string;
      durationMinutes: number;
      prepBufferMinutes: number;
      cleanupBufferMinutes: number;
    },
    expiresAt: Date | null,
  ): Promise<ReserveResult> {
    const organizationId = this.organizations.getOrganizationId();
    const { employeeId } = input;

    // The reference-collision retry lives out here, around the whole transaction, and
    // that placement is not a style choice. A failed statement poisons a PostgreSQL
    // transaction — every later statement fails with "current transaction is aborted",
    // which Prisma surfaces as P2039 — because Prisma does not wrap interactive
    // transaction statements in savepoints. Retrying the insert *inside* would therefore
    // turn a recoverable collision into a hard failure. Probed, not assumed.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.insertOnce(input, service, expiresAt, organizationId, employeeId);
      } catch (error) {
        // The key is composite — (organizationId, reference) — so the column name is what
        // the violation reports. A collision is vanishingly unlikely; re-running the whole
        // transaction, advisory lock and all, is the cheap way to be correct about it.
        if (isUniqueViolation(error, 'reference') && attempt < REFERENCE_ATTEMPTS) {
          this.logger.warn(`booking reference collided; retrying (attempt ${String(attempt)})`);
          continue;
        }

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
  }

  /** One attempt at the transaction: lock, re-check, upsert the customer, insert, record. */
  private async insertOnce(
    input: ReserveInput & { employeeId: string; actor: ReserveActor },
    service: {
      id: string;
      name: string;
      durationMinutes: number;
      prepBufferMinutes: number;
      cleanupBufferMinutes: number;
    },
    expiresAt: Date | null,
    organizationId: string,
    employeeId: string,
  ): Promise<ReserveResult> {
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

          if (!isSlotBookable(forActor(snapshot, input.actor), employeeId, input.startsAt)) {
            throw new AppError('SLOT_UNAVAILABLE', {
              message: 'That slot is no longer available.',
            });
          }

          const { employee, price } = await this.loadEffectiveAssignment(tx, {
            organizationId,
            serviceId: service.id,
            employeeId,
            actor: input.actor,
          });

          const claimedKeyId = await this.claimIdempotencyKey(tx, input.idempotencyKey);

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

          const office = input.actor.type === 'OFFICE' ? input.actor : null;
          const status = office === null ? BookingStatus.PENDING_PAYMENT : BookingStatus.CONFIRMED;

          assertTransition(null, status);

          const booking = await tx.booking.create({
            data: {
              reference: generateBookingReference(),
              organizationId,
              origin: input.origin ?? (office === null ? 'ONLINE' : 'OFFICE'),
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
              priceCentsSnapshot: price.amountCents,
              currency: price.currency,
              status,
              expiresAt,
              locale: input.locale,
              ...(claimedKeyId === null ? {} : { idempotencyKeyId: claimedKeyId }),
              ...(input.customerNote === undefined ? {} : { customerNote: input.customerNote }),
              ...(office === null
                ? {}
                : {
                    confirmedAt: this.clock.now(),
                    createdByOfficeUserId: office.officeUserId,
                  }),
            },
          });

          if (claimedKeyId !== null) {
            await tx.idempotencyKey.update({
              where: { id: claimedKeyId },
              data: { bookingId: booking.id },
            });
          }

          // Armed here rather than when the Checkout session is attached, because the
          // reservation commits before the provider is called: a failure at the
          // provider would otherwise leave a held slot with nothing scheduled to
          // release it. Recorded rather than enqueued, so "the reservation exists" and
          // "something will let it go" commit together.
          if (expiresAt !== null) {
            await this.outbox.record(tx, {
              organizationId,
              aggregateType: 'Booking',
              aggregateId: booking.id,
              eventType: JOB.BOOKING_EXPIRY_REQUESTED,
              payload: { organizationId, bookingId: booking.id },
              availableAt: expiresAt,
            });
          }

          // In the same transaction, so a booking can never exist without the row
          // that explains how it got its status.
          await tx.bookingStatusHistory.create({
            data: {
              organizationId,
              bookingId: booking.id,
              fromStatus: null,
              toStatus: status,
              actorType: office === null ? 'CUSTOMER' : 'OFFICE_USER',
              ...(office === null ? {} : { actorOfficeUserId: office.officeUserId }),
            },
          });

          // An office booking is confirmed on creation, so everything the webhook does
          // on confirmation has to happen here too — otherwise the customer gets no
          // email and no link to their own appointment.
          if (office !== null) {
            const { token } = await this.tokens.issue(
              tx,
              booking.id,
              organizationId,
              booking.endsAt,
            );

            await this.outbox.record(tx, {
              organizationId,
              aggregateType: 'Booking',
              aggregateId: booking.id,
              eventType: JOB.BOOKING_CONFIRMED,
              payload: { organizationId, bookingId: booking.id, managementToken: token },
            });

            return { booking, employee, price, managementToken: token };
          }

          return { booking, employee, price };
        }),
      // Generous but bounded. The lock is held for the whole transaction, so a
      // stuck one delays other reservations for the same employee.
      { isolationLevel: 'ReadCommitted', timeout: 15_000, maxWait: 10_000 },
    );
  }
}

/**
 * The snapshot as this actor's rules see it.
 *
 * The re-check inside the lock runs the same engine the public endpoint runs, and that
 * engine refuses a slot inside the minimum-notice window or past the horizon. For the
 * office those are not the question being asked: an office booking somebody in two
 * hours is the normal case, and the check that matters is whether the slot is *free*.
 *
 * The relaxation itself lives in `asOfficeSnapshot`, which is also what
 * `GET /office/availability` offers slots from — so what the office is shown and what it
 * is allowed to book are the same set by construction.
 */
function forActor(snapshot: AvailabilitySnapshot, actor: ReserveActor): AvailabilitySnapshot {
  return actor.type === 'CUSTOMER' ? snapshot : asOfficeSnapshot(snapshot);
}
