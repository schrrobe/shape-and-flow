import { beforeEach, describe, expect, it } from 'vitest';

import { isForeignKeyViolation } from '../../src/common/prisma-errors/prisma-errors.js';
import { assertOwned } from '../../src/prisma/tenant.extension.js';
import { guardedFor, prisma, resetDatabase } from '../database.harness.js';
import { makeBooking, seedOrganization } from '../factories/index.js';

import type { TenantPrismaClient } from '../../src/prisma/tenant.extension.js';
import type { SeedContext } from '../factories/index.js';

/**
 * Two organizations, and the guard between them.
 *
 * Phase 1 runs a single organization, so none of this is load-bearing today.
 * It is written now so that every query added in the meantime is already scoped,
 * and the ones that are not fail here rather than leaking the day a second
 * organization exists.
 */

let orgA: SeedContext;
let orgB: SeedContext;
let guarded: TenantPrismaClient;

beforeEach(async () => {
  await resetDatabase();
  orgA = await seedOrganization(prisma, { slug: 'org-a' });
  orgB = await seedOrganization(prisma, { slug: 'org-b' });
  guarded = guardedFor(orgA.organization.id);
});

describe('guarded reads', () => {
  it('throws when findMany omits organizationId, naming the model and operation', async () => {
    await expect(guarded.booking.findMany({ where: { status: 'CONFIRMED' } })).rejects.toThrow(
      /Booking\.findMany requires organizationId/,
    );
  });

  it('throws when findMany has no where clause at all', async () => {
    await expect(guarded.booking.findMany()).rejects.toThrow(/requires organizationId/);
  });

  it.each(['count', 'aggregate', 'groupBy'] as const)(
    'throws when %s omits organizationId',
    async (operation) => {
      const call =
        operation === 'groupBy'
          ? guarded.booking.groupBy({ by: ['status'] })
          : operation === 'aggregate'
            ? guarded.booking.aggregate({ _count: true })
            : guarded.booking.count();

      await expect(call).rejects.toThrow(/requires organizationId/);
    },
  );

  it('throws when updateMany or deleteMany omits organizationId', async () => {
    await expect(
      guarded.booking.updateMany({ where: { status: 'CONFIRMED' }, data: { status: 'COMPLETED' } }),
    ).rejects.toThrow(/requires organizationId/);

    await expect(guarded.booking.deleteMany({ where: { status: 'EXPIRED' } })).rejects.toThrow(
      /requires organizationId/,
    );
  });

  it('allows a scoped findMany and returns only that organization', async () => {
    await prisma.booking.create({ data: makeBooking(orgA) });
    await prisma.booking.create({ data: makeBooking(orgB) });

    const rows = await guarded.booking.findMany({
      where: { organizationId: orgA.organization.id },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationId).toBe(orgA.organization.id);
  });

  it('rejects a foreign tenant id and non-equality tenant filters', async () => {
    await prisma.booking.create({ data: makeBooking(orgB) });

    await expect(
      guarded.booking.findMany({ where: { organizationId: orgB.organization.id } }),
    ).rejects.toThrow(/current organization/i);
    await expect(
      guarded.booking.findMany({
        where: { organizationId: { not: orgA.organization.id } },
      }),
    ).rejects.toThrow(/current organization/i);
  });

  it('accepts organizationId nested inside a top-level AND', async () => {
    await prisma.booking.create({ data: makeBooking(orgA) });

    const rows = await guarded.booking.findMany({
      where: { AND: [{ organizationId: orgA.organization.id }, { status: 'PENDING_PAYMENT' }] },
    });

    expect(rows).toHaveLength(1);
  });

  it('accepts an explicit equals filter for the current organization', async () => {
    await prisma.booking.create({ data: makeBooking(orgA) });

    const rows = await guarded.booking.findMany({
      where: { organizationId: { equals: orgA.organization.id } },
    });

    expect(rows).toHaveLength(1);
  });

  it('does not accept an unrelated field that merely looks scoped', async () => {
    await expect(
      guarded.booking.findMany({ where: { OR: [{ organizationId: orgA.organization.id }] } }),
    ).rejects.toThrow(/requires organizationId/);
  });
});

describe('unique-key access', () => {
  it('rejects findUnique without an explicit tenant predicate', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(orgB) });

    await expect(guarded.booking.findUnique({ where: { id: booking.id } })).rejects.toThrow(
      /requires organizationId/,
    );
  });

  it('rejects findUnique with a foreign tenant predicate', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(orgB) });

    await expect(
      guarded.booking.findUnique({
        where: { id: booking.id, organizationId: orgB.organization.id },
      }),
    ).rejects.toThrow(/current organization/i);
  });

  it('allows findUnique when the unique selector is scoped to the current tenant', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(orgA) });

    const found = await guarded.booking.findUnique({
      where: { id: booking.id, organizationId: orgA.organization.id },
    });

    expect(found?.organizationId).toBe(orgA.organization.id);
  });

  it('does not treat a scoped relation filter as ownership of the target row', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(orgB) });

    await expect(
      guarded.booking.findUnique({
        where: {
          id: booking.id,
          employee: { organizationId: orgA.organization.id },
        } as never,
      }),
    ).rejects.toThrow(/requires organizationId/);
  });

  it('assertOwned turns a foreign row into 404, never 403', () => {
    const foreign = { organizationId: orgB.organization.id };

    expect(() => assertOwned(foreign, orgA.organization.id)).toThrow(/not found/i);
    // 403 would confirm the id exists, which is an enumeration oracle.
    expect(() => assertOwned(foreign, orgA.organization.id)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', status: 404 }),
    );
  });

  it('assertOwned passes an owned row straight through', () => {
    const own = { organizationId: orgA.organization.id, id: 'x' };
    expect(assertOwned(own, orgA.organization.id)).toBe(own);
  });

  it('assertOwned rejects null with the same 404', () => {
    expect(() => assertOwned(null, orgA.organization.id)).toThrow(/not found/i);
  });
});

describe('creates', () => {
  it('injects organizationId when it is omitted', async () => {
    const created = await guarded.serviceCategory.create({
      // The type still requires organizationId; the injection is a safety net for
      // a path that forgets it, not the intended way to write a create.
      data: { name: 'Injected category' } as never,
    });

    expect(created.organizationId).toBe(orgA.organization.id);
  });

  it('rejects a foreign explicit organizationId before creating a row', async () => {
    await expect(
      guarded.serviceCategory.create({
        data: { organizationId: orgB.organization.id, name: 'Explicit category' },
      }),
    ).rejects.toThrow(/current organization/i);

    await expect(
      prisma.serviceCategory.findFirst({ where: { name: 'Explicit category' } }),
    ).resolves.toBeNull();
  });

  it('allows an explicit organizationId when it matches the bound tenant', async () => {
    await expect(
      guarded.serviceCategory.create({
        data: { organizationId: orgA.organization.id, name: 'Owned category' },
      }),
    ).resolves.toMatchObject({ organizationId: orgA.organization.id });
  });

  it('injects per row in createMany', async () => {
    await guarded.serviceCategory.createMany({
      data: [{ name: 'Bulk one' }, { name: 'Bulk two' }] as never,
    });

    const rows = await prisma.serviceCategory.findMany({
      where: { organizationId: orgA.organization.id, name: { startsWith: 'Bulk' } },
    });

    expect(rows).toHaveLength(2);
  });

  it('rejects a foreign organizationId in any createMany row', async () => {
    await expect(
      guarded.serviceCategory.createMany({
        data: [
          { organizationId: orgA.organization.id, name: 'Owned bulk row' },
          { organizationId: orgB.organization.id, name: 'Foreign bulk row' },
        ],
      }),
    ).rejects.toThrow(/current organization/i);
  });

  it('rejects nested relation creates through the guarded client', async () => {
    await expect(
      guarded.serviceCategory.create({
        data: {
          organizationId: orgA.organization.id,
          name: 'Nested category',
          services: {
            create: {
              organizationId: orgB.organization.id,
              name: 'Foreign nested service',
              durationMinutes: 30,
              priceCents: 5000,
            },
          },
        } as never,
      }),
    ).rejects.toThrow(/nested writes/i);
  });
});

describe('upserts', () => {
  it('rejects an upsert whose unique key belongs to another tenant', async () => {
    await expect(
      guarded.serviceCategory.upsert({
        where: {
          organizationId_name: {
            organizationId: orgB.organization.id,
            name: 'Massage',
          },
        },
        create: { organizationId: orgA.organization.id, name: 'Never created' },
        update: { name: 'Never updated' },
      }),
    ).rejects.toThrow(/current organization/i);
  });

  it('injects the tenant into an owned upsert create payload', async () => {
    const created = await guarded.serviceCategory.upsert({
      where: {
        organizationId_name: {
          organizationId: orgA.organization.id,
          name: 'Upserted category',
        },
      },
      create: { name: 'Upserted category' } as never,
      update: {},
    });

    expect(created.organizationId).toBe(orgA.organization.id);
  });

  it('rejects a foreign tenant in an upsert create payload', async () => {
    await expect(
      guarded.serviceCategory.upsert({
        where: {
          organizationId_name: {
            organizationId: orgA.organization.id,
            name: 'Foreign create payload',
          },
        },
        create: { organizationId: orgB.organization.id, name: 'Foreign create payload' },
        update: {},
      }),
    ).rejects.toThrow(/current organization/i);
  });

  it('rejects a foreign tenant in an upsert update payload', async () => {
    await expect(
      guarded.serviceCategory.upsert({
        where: {
          organizationId_name: {
            organizationId: orgA.organization.id,
            name: 'Massage',
          },
        },
        create: { organizationId: orgA.organization.id, name: 'Massage' },
        update: { organizationId: orgB.organization.id },
      }),
    ).rejects.toThrow(/current organization/i);
  });
});

describe('updates', () => {
  it('rejects changing organizationId through an update payload', async () => {
    await expect(
      guarded.serviceCategory.update({
        where: {
          organizationId_name: {
            organizationId: orgA.organization.id,
            name: 'Massage',
          },
        },
        data: { organizationId: orgB.organization.id },
      }),
    ).rejects.toThrow(/current organization/i);
  });

  it('rejects nested relation updates through the guarded client', async () => {
    const category = await prisma.serviceCategory.create({
      data: { organizationId: orgA.organization.id, name: 'Owned for nested update' },
    });

    await expect(
      guarded.serviceCategory.update({
        where: { id: category.id, organizationId: orgA.organization.id },
        data: {
          services: { updateMany: { where: {}, data: { archivedAt: new Date() } } },
        } as never,
      }),
    ).rejects.toThrow(/nested writes/i);
  });
});

describe('models that are deliberately unguarded', () => {
  it('does not guard Organization, the tenant root', async () => {
    await expect(guarded.organization.findMany()).resolves.toHaveLength(2);
  });

  it('does not guard the pre-tenant infrastructure tables', async () => {
    // Their organizationId is nullable because the row is written before the
    // tenant is known, and the reconcilers scan them globally on purpose.
    await expect(guarded.idempotencyKey.findMany()).resolves.toEqual([]);
    await expect(guarded.stripeWebhookEvent.findMany()).resolves.toEqual([]);
    await expect(guarded.messagingWebhookEvent.findMany()).resolves.toEqual([]);
  });
});

describe('database tenant consistency', () => {
  it('rejects a booking child row that names another tenant', async () => {
    const foreignBooking = await prisma.booking.create({ data: makeBooking(orgB) });

    await expect(
      prisma.bookingStatusHistory.create({
        data: {
          organizationId: orgA.organization.id,
          bookingId: foreignBooking.id,
          toStatus: 'PENDING_PAYMENT',
          actorType: 'SYSTEM',
        },
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('rejects a refund whose payment belongs to another tenant', async () => {
    const ownBooking = await prisma.booking.create({ data: makeBooking(orgA) });
    const foreignBooking = await prisma.booking.create({ data: makeBooking(orgB) });
    const foreignPayment = await prisma.payment.create({
      data: {
        organizationId: orgB.organization.id,
        bookingId: foreignBooking.id,
        amountCents: 4500,
        currency: 'EUR',
        status: 'SUCCEEDED',
      },
    });

    await expect(
      prisma.refund.create({
        data: {
          organizationId: orgA.organization.id,
          bookingId: ownBooking.id,
          paymentId: foreignPayment.id,
          amountCents: 4500,
          currency: 'EUR',
          status: 'PENDING',
          reason: 'GOODWILL',
          idempotencyKey: 'foreign-payment-refund',
        },
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });
});

describe('transactions', () => {
  it('applies the guard inside an interactive transaction', async () => {
    await expect(
      guarded.$transaction(
        async (tx) => await tx.booking.findMany({ where: { status: 'CONFIRMED' } }),
      ),
    ).rejects.toThrow(/requires organizationId/);
  });

  it('allows a scoped query inside a transaction', async () => {
    await prisma.booking.create({ data: makeBooking(orgA) });

    const rows = await guarded.$transaction(
      async (tx) => await tx.booking.findMany({ where: { organizationId: orgA.organization.id } }),
    );

    expect(rows).toHaveLength(1);
  });

  it('injects organizationId into writes inside an interactive transaction', async () => {
    const created = await guarded.$transaction(
      async (tx) =>
        await tx.serviceCategory.create({ data: { name: 'Transactional category' } as never }),
    );

    expect(created.organizationId).toBe(orgA.organization.id);
  });
});

describe('the raw client', () => {
  it('remains unguarded, so a deliberately global query is possible but visible', async () => {
    await prisma.booking.create({ data: makeBooking(orgA) });
    await prisma.booking.create({ data: makeBooking(orgB) });

    // Reaching for `prisma` instead of the guarded client is a choice a reviewer
    // can see in the constructor.
    await expect(prisma.booking.findMany()).resolves.toHaveLength(2);
  });
});
