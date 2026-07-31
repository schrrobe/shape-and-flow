import { beforeEach, describe, expect, it } from 'vitest';

import { BLOCKING_BOOKING_STATUSES, isBlocking } from '../../src/booking/booking-status.machine.js';
import {
  isCheckViolation,
  isExclusionViolation,
  isUniqueViolation,
} from '../../src/common/prisma-errors/prisma-errors.js';
import { BookingStatus } from '../../src/prisma/client.js';
import { constraintDefinition, indexExists, prisma, resetDatabase } from '../database.harness.js';
import { makeBooking, seedOrganization } from '../factories/index.js';

import type { SeedContext } from '../factories/index.js';

/**
 * The guarantees this suite protects are the ones that cannot be recovered from
 * in production: a double-booked employee, or a lost constraint after a
 * migration. Every assertion runs against a real PostgreSQL, because a mocked
 * database cannot enforce an exclusion constraint and would prove nothing.
 */

const at = (iso: string): Date => new Date(iso);

/** Non-blocking statuses must be ignored by the constraint predicate. */
const NON_BLOCKING_STATUSES = [
  BookingStatus.EXPIRED,
  BookingStatus.PAYMENT_FAILED,
  BookingStatus.CANCELED_BY_CUSTOMER,
  BookingStatus.CANCELED_BY_BUSINESS,
  BookingStatus.COMPLETED,
  BookingStatus.NO_SHOW,
] as const;

let ctx: SeedContext;

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);
});

describe('bookings_no_overlap', () => {
  it('rejects an overlapping booking for the same employee', async () => {
    await prisma.booking.create({
      data: makeBooking(ctx, {
        blockStartsAt: at('2026-08-14T07:00:00.000Z'),
        blockEndsAt: at('2026-08-14T07:30:00.000Z'),
      }),
    });

    let caught: unknown;
    try {
      await prisma.booking.create({
        data: makeBooking(ctx, {
          blockStartsAt: at('2026-08-14T07:15:00.000Z'),
          blockEndsAt: at('2026-08-14T07:45:00.000Z'),
        }),
      });
    } catch (error) {
      caught = error;
    }

    expect(isExclusionViolation(caught, 'bookings_no_overlap')).toBe(true);
    // Must not be mistaken for a different integrity failure.
    expect(isUniqueViolation(caught)).toBe(false);
    expect(isCheckViolation(caught)).toBe(false);
  });

  it('allows back-to-back bookings, because the bounds are half-open', async () => {
    await prisma.booking.create({
      data: makeBooking(ctx, {
        blockStartsAt: at('2026-08-14T07:00:00.000Z'),
        blockEndsAt: at('2026-08-14T07:30:00.000Z'),
      }),
    });

    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, {
          blockStartsAt: at('2026-08-14T07:30:00.000Z'),
          blockEndsAt: at('2026-08-14T08:00:00.000Z'),
        }),
      }),
    ).resolves.toBeDefined();
  });

  it('allows the identical range for a different employee', async () => {
    await prisma.booking.create({
      data: makeBooking(ctx, {
        blockStartsAt: at('2026-08-14T07:00:00.000Z'),
        blockEndsAt: at('2026-08-14T07:30:00.000Z'),
      }),
    });

    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, {
          employeeId: ctx.employee2.id,
          blockStartsAt: at('2026-08-14T07:00:00.000Z'),
          blockEndsAt: at('2026-08-14T07:30:00.000Z'),
        }),
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a booking fully contained inside an existing one', async () => {
    await prisma.booking.create({
      data: makeBooking(ctx, {
        blockStartsAt: at('2026-08-14T07:00:00.000Z'),
        blockEndsAt: at('2026-08-14T09:00:00.000Z'),
      }),
    });

    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, {
          blockStartsAt: at('2026-08-14T07:30:00.000Z'),
          blockEndsAt: at('2026-08-14T08:00:00.000Z'),
        }),
      }),
    ).rejects.toSatisfy((error: unknown) => isExclusionViolation(error, 'bookings_no_overlap'));
  });

  it.each(NON_BLOCKING_STATUSES)('ignores an existing %s booking', async (status) => {
    expect(isBlocking(status)).toBe(false);

    await prisma.booking.create({
      data: makeBooking(ctx, {
        status,
        blockStartsAt: at('2026-08-15T07:00:00.000Z'),
        blockEndsAt: at('2026-08-15T07:30:00.000Z'),
      }),
    });

    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, {
          blockStartsAt: at('2026-08-15T07:00:00.000Z'),
          blockEndsAt: at('2026-08-15T07:30:00.000Z'),
        }),
      }),
    ).resolves.toBeDefined();
  });

  it.each(BLOCKING_BOOKING_STATUSES)('blocks when the existing booking is %s', async (status) => {
    await prisma.booking.create({
      data: makeBooking(ctx, {
        status,
        blockStartsAt: at('2026-08-16T07:00:00.000Z'),
        blockEndsAt: at('2026-08-16T07:30:00.000Z'),
      }),
    });

    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, {
          blockStartsAt: at('2026-08-16T07:10:00.000Z'),
          blockEndsAt: at('2026-08-16T07:40:00.000Z'),
        }),
      }),
    ).rejects.toSatisfy((error: unknown) => isExclusionViolation(error, 'bookings_no_overlap'));
  });

  it('blocks a still-unpaid reservation, so paying is not a race', async () => {
    await prisma.booking.create({
      data: makeBooking(ctx, {
        status: BookingStatus.PENDING_PAYMENT,
        blockStartsAt: at('2026-08-17T07:00:00.000Z'),
        blockEndsAt: at('2026-08-17T07:30:00.000Z'),
      }),
    });

    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, {
          status: BookingStatus.CONFIRMED,
          blockStartsAt: at('2026-08-17T07:00:00.000Z'),
          blockEndsAt: at('2026-08-17T07:30:00.000Z'),
        }),
      }),
    ).rejects.toSatisfy((error: unknown) => isExclusionViolation(error, 'bookings_no_overlap'));
  });
});

describe('range integrity', () => {
  it('rejects a zero-length range instead of silently allowing duplicates', async () => {
    // tstzrange(x, x) is empty and overlaps nothing, so without the CHECK an
    // unlimited number of zero-length bookings could stack on one instant.
    let caught: unknown;
    try {
      await prisma.booking.create({
        data: makeBooking(ctx, {
          blockStartsAt: at('2026-08-18T07:00:00.000Z'),
          blockEndsAt: at('2026-08-18T07:00:00.000Z'),
        }),
      });
    } catch (error) {
      caught = error;
    }

    expect(isCheckViolation(caught, 'bookings_block_range_check')).toBe(true);
  });

  it('rejects an inverted range', async () => {
    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, {
          blockStartsAt: at('2026-08-18T08:00:00.000Z'),
          blockEndsAt: at('2026-08-18T07:00:00.000Z'),
        }),
      }),
    ).rejects.toSatisfy((error: unknown) => isCheckViolation(error, 'bookings_block_range_check'));
  });

  it('requires expiresAt exactly while the booking is unpaid', async () => {
    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, { status: BookingStatus.PENDING_PAYMENT, expiresAt: null }),
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'bookings_expires_at_matches_status'),
    );

    await expect(
      prisma.booking.create({
        data: makeBooking(ctx, {
          status: BookingStatus.CONFIRMED,
          expiresAt: at('2026-08-14T06:00:00.000Z'),
        }),
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isCheckViolation(error, 'bookings_expires_at_matches_status'),
    );
  });
});

describe('blocked_times_no_overlap', () => {
  const blockedTime = (startsAt: string, endsAt: string) => ({
    organizationId: ctx.organization.id,
    employeeId: ctx.employee1.id,
    startsAt: at(startsAt),
    endsAt: at(endsAt),
    createdByOfficeUserId: ctx.owner.id,
  });

  it('rejects two overlapping blocked times for one employee', async () => {
    await prisma.blockedTime.create({
      data: blockedTime('2026-08-19T07:00:00.000Z', '2026-08-19T08:00:00.000Z'),
    });

    await expect(
      prisma.blockedTime.create({
        data: blockedTime('2026-08-19T07:30:00.000Z', '2026-08-19T08:30:00.000Z'),
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isExclusionViolation(error, 'blocked_times_no_overlap'),
    );
  });

  it('has no status predicate, so it applies unconditionally', async () => {
    const definition = await constraintDefinition('blocked_times_no_overlap');
    expect(definition).toContain('EXCLUDE USING gist');
    expect(definition).not.toContain('WHERE');
  });

  it('does not constrain a booking and a blocked time against each other', async () => {
    // PostgreSQL cannot express a cross-table exclusion constraint. This is the
    // gap the per-employee advisory lock exists to close, and asserting it here
    // documents why that lock is not optional.
    await prisma.booking.create({
      data: makeBooking(ctx, {
        blockStartsAt: at('2026-08-21T07:00:00.000Z'),
        blockEndsAt: at('2026-08-21T07:30:00.000Z'),
      }),
    });

    await expect(
      prisma.blockedTime.create({
        data: blockedTime('2026-08-21T07:00:00.000Z', '2026-08-21T07:30:00.000Z'),
      }),
    ).resolves.toBeDefined();
  });
});

describe('constraint inventory', () => {
  it('keeps every calendar constraint present after migrate deploy', async () => {
    const names = [
      'bookings_no_overlap',
      'bookings_block_range_check',
      'bookings_customer_range_check',
      'bookings_expires_at_matches_status',
      'blocked_times_no_overlap',
      'blocked_times_range_check',
    ];

    for (const name of names) {
      expect(await constraintDefinition(name), `${name} is missing`).not.toBeNull();
    }
  });

  it('keeps the constraint predicate and the TypeScript constant in agreement', async () => {
    const definition = await constraintDefinition('bookings_no_overlap');
    expect(definition).not.toBeNull();

    for (const status of BLOCKING_BOOKING_STATUSES) {
      expect(definition, `${status} missing from the predicate`).toContain(`'${status}'`);
    }

    // And nothing extra: a status added to the predicate but not to the constant
    // would silently block slots the application believes are free.
    const quoted = [...(definition ?? '').matchAll(/'([A-Z_]+)'::"BookingStatus"/g)].map(
      (match) => match[1] ?? '',
    );
    expect([...new Set(quoted)].sort()).toEqual([...BLOCKING_BOOKING_STATUSES].sort());
  });

  it('uses half-open bounds in the range expression', async () => {
    const definition = await constraintDefinition('bookings_no_overlap');
    expect(definition).toContain("'[)'");
  });

  it('enforces at most one open request per booking', async () => {
    expect(await indexExists('cancellation_requests_one_open')).toBe(true);
    expect(await indexExists('reschedule_requests_one_open')).toBe(true);
  });
});

describe('one open request per booking', () => {
  it('rejects a second pending cancellation request', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(ctx) });
    const data = {
      organizationId: ctx.organization.id,
      bookingId: booking.id,
      suggestedRetainedAmountCents: 0,
    };

    await prisma.cancellationRequest.create({ data });

    await expect(prisma.cancellationRequest.create({ data })).rejects.toSatisfy((error: unknown) =>
      isUniqueViolation(error, 'cancellation_requests_one_open'),
    );
  });

  it('allows a new request once the previous one is decided', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(ctx) });
    const data = {
      organizationId: ctx.organization.id,
      bookingId: booking.id,
      suggestedRetainedAmountCents: 0,
    };

    const first = await prisma.cancellationRequest.create({ data });
    await prisma.cancellationRequest.update({
      where: { id: first.id },
      data: { decision: 'REJECTED', decidedAt: new Date() },
    });

    await expect(prisma.cancellationRequest.create({ data })).resolves.toBeDefined();
  });
});
