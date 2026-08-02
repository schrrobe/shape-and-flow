import { beforeEach, describe, expect, it } from 'vitest';

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
      const call = (): Promise<unknown> => {
        if (operation === 'groupBy') return guarded.booking.groupBy({ by: ['status'] });
        if (operation === 'aggregate') return guarded.booking.aggregate({ _count: true });
        return guarded.booking.count();
      };

      await expect(call()).rejects.toThrow(/requires organizationId/);
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

  it('accepts organizationId nested inside a top-level AND', async () => {
    await prisma.booking.create({ data: makeBooking(orgA) });

    const rows = await guarded.booking.findMany({
      where: { AND: [{ organizationId: orgA.organization.id }, { status: 'PENDING_PAYMENT' }] },
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
  it('allows findUnique, because a unique key cannot carry a tenant filter', async () => {
    const booking = await prisma.booking.create({ data: makeBooking(orgB) });

    const found = await guarded.booking.findUnique({ where: { id: booking.id } });

    // The guard permits the read; ownership is the caller's responsibility.
    expect(found?.organizationId).toBe(orgB.organization.id);
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

  it('leaves an explicit organizationId alone', async () => {
    const created = await guarded.serviceCategory.create({
      data: { organizationId: orgB.organization.id, name: 'Explicit category' },
    });

    expect(created.organizationId).toBe(orgB.organization.id);
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
