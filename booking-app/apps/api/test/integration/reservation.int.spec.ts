import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BOOKING_REFERENCE_PATTERN } from '../../src/booking/booking-reference.js';
import { BLOCKING_BOOKING_STATUSES } from '../../src/booking/booking-status.machine.js';
import { CustomerUpsertService } from '../../src/booking/customer-upsert.service.js';
import { ReservationService } from '../../src/booking/reservation.service.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { AvailabilitySnapshotService } from '../../src/public/availability-snapshot.service.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';

import type { ReserveInput } from '../../src/booking/reservation.service.js';
import type { OrganizationContextService } from '../../src/organization/organization-context.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import type { SeedContext } from '../factories/index.js';

/** References the generator will hand out before falling back to the real one. */
const forcedReferences: string[] = [];

vi.mock('../../src/booking/booking-reference.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/booking/booking-reference.js')>();

  return {
    ...actual,
    generateBookingReference: (): string =>
      forcedReferences.shift() ?? actual.generateBookingReference(),
  };
});

const db = prisma as unknown as PrismaService;

/** Monday 08:00 Berlin. The seeded Friday slot is comfortably past the 24-hour notice. */
const NOW = new Date('2026-08-10T06:00:00.000Z');

let ctx: SeedContext;
let clock: FixedClock;
let service: ReservationService;

function input(overrides: Partial<ReserveInput> = {}): ReserveInput {
  return {
    serviceId: ctx.service30.id,
    employeeId: ctx.employee1.id,
    startsAt: SLOT_FRIDAY_0900,
    customer: {
      email: 'anna@example.com',
      firstName: 'Anna',
      lastName: 'Becker',
      phone: '+4915112345678',
      locale: 'de',
    },
    locale: 'de',
    ...overrides,
  };
}

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);

  const organization = await loadOrganization(ctx.organization.id);
  const organizations = {
    get: () => organization,
    getOrganizationId: () => organization.id,
    getSettings: () => organization.settings,
    getTimezone: () => organization.timezone,
  } as OrganizationContextService;

  clock = new FixedClock(NOW);
  const snapshots = new AvailabilitySnapshotService(db, organizations, clock);

  service = new ReservationService(
    db,
    organizations,
    snapshots,
    new CustomerUpsertService(),
    clock,
  );
});

describe('a successful reservation', () => {
  it('creates a PENDING_PAYMENT booking with every snapshot and an expiry', async () => {
    const { booking, price } = await service.reserve(input());

    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(booking.priceCentsSnapshot).toBe(ctx.service30.priceCents);
    expect(booking.durationMinutesSnapshot).toBe(30);
    expect(booking.serviceNameSnapshot).toBe(ctx.service30.name);
    expect(booking.reference).toMatch(BOOKING_REFERENCE_PATTERN);
    expect(price.amountCents).toBe(ctx.service30.priceCents);

    // Five-minute reservation TTL from the seeded settings.
    expect(booking.expiresAt).toEqual(new Date(NOW.getTime() + 5 * 60_000));
  });

  it('extends the block bounds by the service buffers, leaving the appointment alone', async () => {
    const { booking } = await service.reserve(input());

    // The customer is told 09:00–09:30; the calendar is blocked to 09:35.
    expect(booking.startsAt).toEqual(SLOT_FRIDAY_0900);
    expect(booking.endsAt).toEqual(new Date(SLOT_FRIDAY_0900.getTime() + 30 * 60_000));
    expect(booking.blockStartsAt).toEqual(SLOT_FRIDAY_0900);
    expect(booking.blockEndsAt.getTime() - booking.endsAt.getTime()).toBe(5 * 60_000);
  });

  it('writes a status-history row in the same transaction', async () => {
    const { booking } = await service.reserve(input());

    const history = await prisma.bookingStatusHistory.findMany({
      where: { bookingId: booking.id },
    });

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: null,
      toStatus: 'PENDING_PAYMENT',
      actorType: 'CUSTOMER',
    });
  });

  it('resolves the organization itself and never from the caller', async () => {
    const { booking } = await service.reserve(input());
    expect(booking.organizationId).toBe(ctx.organization.id);
  });

  it('stores the customer note when one is given', async () => {
    const { booking } = await service.reserve(input({ customerNote: 'Erstbesuch' }));
    expect(booking.customerNote).toBe('Erstbesuch');
  });
});

describe('any available employee', () => {
  it('resolves to a concrete employee, so the constraint has something to constrain', async () => {
    const { booking, employee } = await service.reserve(input({ employeeId: null }));

    expect(booking.employeeId).toBe(employee.id);
    expect([ctx.employee1.id, ctx.employee2.id]).toContain(booking.employeeId);
  });

  it('load-balances across the team rather than filling one calendar', async () => {
    const first = await service.reserve(input({ employeeId: null }));
    const second = await service.reserve(
      input({ employeeId: null, startsAt: new Date(SLOT_FRIDAY_0900.getTime() + 60 * 60_000) }),
    );

    // The second employee now has fewer bookings that day, so selectEmployee prefers
    // them. Without this the whole day would land on one person.
    expect(second.booking.employeeId).not.toBe(first.booking.employeeId);
  });

  it('reports SLOT_UNAVAILABLE when nobody is free', async () => {
    await service.reserve(input({ employeeId: ctx.employee1.id }));
    await service.reserve(input({ employeeId: ctx.employee2.id }));

    await expect(service.reserve(input({ employeeId: null }))).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });
});

describe('double-booking', () => {
  it('rejects a second reservation for the same employee and slot', async () => {
    await service.reserve(input());

    await expect(service.reserve(input())).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });

  it('serialises twenty concurrent attempts on one slot into exactly one booking', async () => {
    // The whole point of the advisory lock and the exclusion constraint, driven
    // concurrently rather than argued about.
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => service.reserve(input())),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      }
    }

    expect(
      await prisma.booking.count({
        where: { employeeId: ctx.employee1.id, blockStartsAt: SLOT_FRIDAY_0900 },
      }),
    ).toBe(1);
  });

  it('lets two employees be reserved for the same instant concurrently', async () => {
    // Per-employee locking, not a global one: these must not wait for each other.
    const results = await Promise.all([
      service.reserve(input({ employeeId: ctx.employee1.id })),
      service.reserve(input({ employeeId: ctx.employee2.id })),
    ]);

    expect(new Set(results.map((result) => result.booking.employeeId)).size).toBe(2);
  });

  it('rejects a slot overlapping a blocked time, which no constraint can see', async () => {
    // This is the case the advisory lock exists for. `blocked_times` is a different
    // table, so `bookings_no_overlap` cannot express it.
    await prisma.blockedTime.create({
      data: {
        organizationId: ctx.organization.id,
        employeeId: ctx.employee1.id,
        startsAt: SLOT_FRIDAY_0900,
        endsAt: new Date(SLOT_FRIDAY_0900.getTime() + 30 * 60_000),
        createdByOfficeUserId: ctx.owner.id,
      },
    });

    await expect(service.reserve(input())).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });

  it('rejects a slot on a day the employee has approved time off', async () => {
    await prisma.timeOff.create({
      data: {
        organizationId: ctx.organization.id,
        employeeId: ctx.employee1.id,
        startDate: new Date('2026-08-14T00:00:00.000Z'),
        endDate: new Date('2026-08-14T00:00:00.000Z'),
        status: 'APPROVED',
      },
    });

    await expect(service.reserve(input())).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });
});

describe('rejected requests', () => {
  it('rejects a start time that is not on the scheduling grid', async () => {
    // 09:07 is not a slot the engine would ever have offered, so a request for it did
    // not come from the availability endpoint.
    await expect(
      service.reserve(input({ startsAt: new Date('2026-08-14T07:07:00.000Z') })),
    ).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });

  it('rejects a slot inside the notice window', async () => {
    await expect(
      service.reserve(input({ startsAt: new Date(NOW.getTime() + 60 * 60_000) })),
    ).rejects.toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
  });

  it('rejects a slot beyond the booking horizon', async () => {
    await expect(
      service.reserve(input({ startsAt: new Date('2028-01-14T07:00:00.000Z') })),
    ).rejects.toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
  });

  it('rejects an archived service without saying it exists', async () => {
    await prisma.service.update({
      where: { id: ctx.service30.id },
      data: { archivedAt: NOW },
    });

    await expect(service.reserve(input())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('leaves no booking and no new customer behind when it rejects', async () => {
    // A first-time customer, so the rollback of the upsert is observable. The seeded
    // organization already contains anna@example.com.
    await expect(
      service.reserve(
        input({
          startsAt: new Date('2026-08-14T07:07:00.000Z'),
          customer: { ...input().customer, email: 'first-timer@example.com' },
        }),
      ),
    ).rejects.toThrow();

    expect(await prisma.booking.count()).toBe(0);
    expect(
      await prisma.customer.count({ where: { emailNormalized: 'first-timer@example.com' } }),
    ).toBe(0);
  });
});

describe('the customer record', () => {
  it('creates a first-time customer once, and matches them on normalised email after', async () => {
    const email = 'Bea@Example.COM';

    await service.reserve(input({ customer: { ...input().customer, email } }));
    expect(await prisma.customer.count({ where: { emailNormalized: 'bea@example.com' } })).toBe(1);

    // Different case and stray whitespace: the same person, so no second row.
    await service.reserve(
      input({
        employeeId: ctx.employee2.id,
        customer: { ...input().customer, email: ' bea@example.com ' },
      }),
    );

    expect(
      await prisma.customer.count({
        where: { organizationId: ctx.organization.id, emailNormalized: 'bea@example.com' },
      }),
    ).toBe(1);
  });

  it('does not let a later booking rewrite the stored name', async () => {
    await service.reserve(input());
    await service.reserve(
      input({
        employeeId: ctx.employee2.id,
        customer: { ...input().customer, firstName: 'Typo', lastName: 'Mistake' },
      }),
    );

    const customer = await prisma.customer.findFirstOrThrow({
      where: { emailNormalized: 'anna@example.com' },
    });

    // A typo in a booking form must not silently rewrite the record the office knows
    // the customer by.
    expect(customer.firstName).toBe('Anna');
    expect(customer.lastName).toBe('Becker');
  });

  it('does update the locale, which the customer just told us', async () => {
    await service.reserve(input());
    await service.reserve(
      input({
        employeeId: ctx.employee2.id,
        locale: 'en',
        customer: { ...input().customer, locale: 'en' },
      }),
    );

    const customer = await prisma.customer.findFirstOrThrow({
      where: { emailNormalized: 'anna@example.com' },
    });

    expect(customer.locale).toBe('en');
  });
});

describe('the reserved slot', () => {
  it('blocks the slot for availability, in a status the engine treats as busy', async () => {
    const { booking } = await service.reserve(input());

    expect(BLOCKING_BOOKING_STATUSES).toContain(booking.status);

    // Proven through the loader the availability endpoint uses, not by inspecting the
    // row: an unpaid reservation has to remove the slot from what a second customer
    // is offered.
    await expect(service.reserve(input())).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });

  it('frees the slot again once the booking reaches a non-blocking status', async () => {
    const { booking } = await service.reserve(input());

    await prisma.booking.update({
      where: { id: booking.id },
      data: { status: 'EXPIRED', expiresAt: null },
    });

    await expect(service.reserve(input())).resolves.toBeDefined();
  });
});

describe('a reference collision', () => {
  it('retries the whole transaction and succeeds with a fresh reference', async () => {
    // An existing booking owns the reference the generator will produce first. The
    // *whole* transaction has to be retried, not just the insert: a failed statement
    // poisons a PostgreSQL transaction, so an in-transaction retry would fail with
    // P2039 instead of recovering.
    const first = await service.reserve(input());
    await prisma.booking.update({
      where: { id: first.booking.id },
      data: { status: 'CANCELED_BY_CUSTOMER', canceledAt: NOW, expiresAt: null },
    });

    forcedReferences.push(first.booking.reference);
    const second = await service.reserve(input());

    expect(second.booking.reference).not.toBe(first.booking.reference);
    expect(second.booking.reference).toMatch(BOOKING_REFERENCE_PATTERN);
    expect(forcedReferences).toHaveLength(0);
  });

  it('gives up after the bounded number of attempts', async () => {
    const first = await service.reserve(input());
    await prisma.booking.update({
      where: { id: first.booking.id },
      data: { status: 'CANCELED_BY_CUSTOMER', canceledAt: NOW, expiresAt: null },
    });

    // Enough collisions to exhaust the retries. Better a 500 than an unbounded loop
    // holding an advisory lock.
    for (let index = 0; index < 6; index += 1) forcedReferences.push(first.booking.reference);

    await expect(service.reserve(input())).rejects.toThrow();
    forcedReferences.length = 0;
  });
});
