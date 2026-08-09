import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '../prisma/client.js';

import { OrganizationDomainsService } from './organization-domains.service.js';

import type { AppConfig } from '../config/env.schema.js';
import type { OrganizationContextService } from '../organization/organization-context.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const ORGANIZATION_ID = 'org-1';
const CENTRAL_HOST = 'buchung.example.com';

const config = {
  PUBLIC_WEB_ORIGIN: `https://${CENTRAL_HOST}`,
  PUBLIC_API_ORIGIN: `https://${CENTRAL_HOST}`,
  NODE_ENV: 'production',
} as AppConfig;

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'domain-1',
  hostname: 'studio-muster.de',
  isPrimary: false,
  verifiedAt: null,
  createdAt: new Date('2026-08-09T10:00:00.000Z'),
  ...overrides,
});

function build(options: { findMany?: unknown[]; findFirst?: unknown; create?: unknown } = {}) {
  const create = vi.fn().mockResolvedValue(options.create ?? row());
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const findMany = vi.fn().mockResolvedValue(options.findMany ?? []);
  const findFirst = vi.fn().mockResolvedValue(options.findFirst ?? null);

  const tx = { organizationDomain: { create, updateMany } };

  const prisma = {
    organizationDomain: { findMany, findFirst, deleteMany },
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => await fn(tx)),
  } as unknown as PrismaService;

  const organizations = {
    getOrganizationId: () => ORGANIZATION_ID,
  } as unknown as OrganizationContextService;

  return {
    service: new OrganizationDomainsService(prisma, organizations, config),
    create,
    updateMany,
    deleteMany,
    findMany,
    findFirst,
  };
}

/**
 * The shape a real 23505 on `organization_domains_hostname_key` arrives in, as Prisma
 * 7's pg driver adapter reports it — see `prisma-errors.spec.ts` for the captured
 * originals this mirrors. Worth spelling out rather than faking, because the detection
 * reads `constraint.fields` and a shortcut fixture would pass while production threw a
 * 500.
 */
const uniqueViolation = (): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Database error.', {
    code: 'P2002',
    clientVersion: '7.9.1',
    meta: {
      modelName: 'OrganizationDomain',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage:
            'duplicate key value violates unique constraint "organization_domains_hostname_key"',
          kind: 'UniqueConstraintViolation',
          constraint: { fields: ['hostname'] },
        },
      },
    },
  });

/**
 * The shape a real 23505 on the partial `organization_domains_primary_key` index
 * arrives in — the race two concurrent primary-domain promotions for the same
 * organization produce. Unlike the hostname violation, Postgres reports this one by
 * index name rather than a column list, so the fixture leaves `fields` empty and puts
 * the name in the message the way the driver adapter actually does.
 */
const primaryKeyViolation = (): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Database error.', {
    code: 'P2002',
    clientVersion: '7.9.1',
    meta: {
      modelName: 'OrganizationDomain',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage:
            'duplicate key value violates unique constraint "organization_domains_primary_key"',
          kind: 'UniqueConstraintViolation',
          constraint: { fields: [], index: 'organization_domains_primary_key' },
        },
      },
    },
  });

describe('OrganizationDomainsService', () => {
  describe('list', () => {
    it('reads only this organization, primary first', async () => {
      const { service, findMany } = build({ findMany: [row()] });

      const result = await service.list();

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: ORGANIZATION_ID },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        }),
      );
      expect(result.domains).toHaveLength(1);
      expect(result.domains[0]).toMatchObject({
        hostname: 'studio-muster.de',
        verifiedAt: null,
        createdAt: '2026-08-09T10:00:00.000Z',
      });
    });
  });

  describe('add', () => {
    it('stores the normalized hostname, not what was typed', async () => {
      const { service, create } = build();

      await service.add({ hostname: '  https://Studio-Muster.DE./  ', isPrimary: false });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { hostname: 'studio-muster.de', organizationId: ORGANIZATION_ID, isPrimary: false },
        }),
      );
    });

    it('demotes the previous primary in the same transaction', async () => {
      const { service, updateMany, create } = build({ create: row({ isPrimary: true }) });

      await service.add({ hostname: 'studio-muster.de', isPrimary: true });

      expect(updateMany).toHaveBeenCalledWith({
        where: { organizationId: ORGANIZATION_ID, isPrimary: true },
        data: { isPrimary: false },
      });
      expect(create).toHaveBeenCalled();
    });

    it('leaves the existing primary alone when the new domain is not primary', async () => {
      const { service, updateMany } = build();

      await service.add({ hostname: 'www.studio-muster.de', isPrimary: false });

      expect(updateMany).not.toHaveBeenCalled();
    });

    it.each([
      ['a URL with a path', 'studio-muster.de/booking'],
      ['an unparseable name', 'studio muster'],
      ['an IP literal', '203.0.113.10'],
      ['an empty label', 'studio..de'],
    ])('rejects %s before touching the database', async (_label, hostname) => {
      const { service, create } = build();

      await expect(service.add({ hostname, isPrimary: false })).rejects.toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
      expect(create).not.toHaveBeenCalled();
    });

    // An organization holding the central hostname would own the address on which
    // `?organizer=` picks the tenant, and so every other organizer's links.
    it('refuses the platform address', async () => {
      const { service, create } = build();

      await expect(service.add({ hostname: CENTRAL_HOST, isPrimary: false })).rejects.toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
      expect(create).not.toHaveBeenCalled();
    });

    // Same answer whether the row is this organization's or a stranger's: the
    // alternative is a domain oracle for anybody with an office account.
    it('maps a unique violation to ORGANIZATION_DOMAIN_TAKEN', async () => {
      const { service, create } = build();
      create.mockRejectedValue(uniqueViolation());

      await expect(service.add({ hostname: 'studio-muster.de', isPrimary: false })).rejects.toThrow(
        expect.objectContaining({ code: 'ORGANIZATION_DOMAIN_TAKEN' }),
      );
    });

    it('rethrows an unrelated database failure rather than reporting a conflict', async () => {
      const { service, create } = build();
      create.mockRejectedValue(new Error('connection terminated'));

      await expect(service.add({ hostname: 'studio-muster.de', isPrimary: false })).rejects.toThrow(
        'connection terminated',
      );
    });

    // Two requests promoting different domains of the same organization race the
    // partial unique index: both `updateMany`s step the old primary down, then both
    // inserts try to be the one true primary and the loser gets a 23505 that has
    // nothing to do with the hostname. Retrying re-runs the `updateMany` against
    // whichever row won, which is why the retry succeeds rather than looping forever.
    it('retries a primary-index race instead of surfacing it as an internal error', async () => {
      const { service, create } = build();
      create
        .mockRejectedValueOnce(primaryKeyViolation())
        .mockResolvedValueOnce(row({ isPrimary: true }));

      const result = await service.add({ hostname: 'studio-muster.de', isPrimary: true });

      expect(create).toHaveBeenCalledTimes(2);
      expect(result.domain.hostname).toBe('studio-muster.de');
    });

    it('gives up on a primary-index race that never clears', async () => {
      const { service, create } = build();
      create.mockRejectedValue(primaryKeyViolation());

      await expect(service.add({ hostname: 'studio-muster.de', isPrimary: true })).rejects.toThrow(
        primaryKeyViolation().message,
      );
      expect(create).toHaveBeenCalledTimes(4);
    });
  });

  describe('remove', () => {
    it('deletes within the tenant and returns what it deleted', async () => {
      const { service, deleteMany } = build({ findFirst: row() });

      const result = await service.remove('domain-1');

      expect(deleteMany).toHaveBeenCalledWith({
        where: { id: 'domain-1', organizationId: ORGANIZATION_ID },
      });
      expect(result.domain.hostname).toBe('studio-muster.de');
    });

    it("answers 404 for another organization's domain, exactly as for a missing one", async () => {
      const { service, deleteMany } = build({ findFirst: null });

      await expect(service.remove('domain-elsewhere')).rejects.toThrow(
        expect.objectContaining({ code: 'NOT_FOUND' }),
      );
      expect(deleteMany).not.toHaveBeenCalled();
    });
  });
});
