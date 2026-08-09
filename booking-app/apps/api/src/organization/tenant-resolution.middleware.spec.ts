import { describe, expect, it, vi } from 'vitest';

import { currentTenant, hasTenant } from './tenant-context.store.js';
import { TenantResolutionMiddleware } from './tenant-resolution.middleware.js';

import type { AppConfig } from '../config/env.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { NextFunction, Request, Response } from 'express';

const CENTRAL_HOST = 'buchung.example.com';

/**
 * Production by default, so a test that wants the loopback allowances has to say so.
 * The gate that matters is the production one; the development relaxation exists only
 * to keep the dev server and the integration suite addressable.
 */
const config = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({
    PUBLIC_WEB_ORIGIN: `https://${CENTRAL_HOST}`,
    PUBLIC_API_ORIGIN: `https://${CENTRAL_HOST}`,
    NODE_ENV: 'production',
    ...overrides,
  }) as AppConfig;

function fakeRequest(query: Record<string, unknown>, hostname = CENTRAL_HOST): Request {
  return { query, hostname } as unknown as Request;
}

/**
 * `organization.findUnique` answers slug lookups, `organizationDomain.findUnique`
 * answers hostname lookups. Both are handed back so a test can assert which one the
 * middleware consulted — "the domain was never queried" is as much of a requirement as
 * the resolution itself.
 */
function fakePrisma(options: { organization?: unknown; domain?: unknown } = {}) {
  const findOrganization = vi.fn().mockResolvedValue(options.organization ?? null);
  const findDomain = vi.fn().mockResolvedValue(options.domain ?? null);

  return {
    findOrganization,
    findDomain,
    prisma: {
      organization: { findUnique: findOrganization },
      organizationDomain: { findUnique: findDomain },
    } as unknown as PrismaService,
  };
}

const organizationRow = (id: string, slug: string) => ({
  id,
  slug,
  settings: { id: `settings-${id}` },
});

describe('TenantResolutionMiddleware', () => {
  describe('without an organizer identity', () => {
    it('falls through to the default organization when no ?organizer= param is present', async () => {
      const { prisma, findOrganization } = fakePrisma();
      const middleware = new TenantResolutionMiddleware(prisma, config());
      const next = vi.fn(() => {
        expect(hasTenant()).toBe(false);
      });

      await middleware.middleware(fakeRequest({}), {} as Response, next as NextFunction);

      expect(findOrganization).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    });

    // An unregistered hostname with no slug is a deployment that simply has one
    // organizer, or a landing page. There is no identity to get wrong, so 404 here
    // would break every single-organizer install.
    it('falls through on an unregistered host that offers no slug', async () => {
      const { prisma } = fakePrisma();
      const middleware = new TenantResolutionMiddleware(prisma, config());
      const next = vi.fn(() => {
        expect(hasTenant()).toBe(false);
      });

      await middleware.middleware(
        fakeRequest({}, 'unregistered.example'),
        {} as Response,
        next as NextFunction,
      );

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolving from the hostname', () => {
    it('resolves the tenant scope from a registered domain, with no query parameter', async () => {
      const { prisma, findDomain } = fakePrisma({
        domain: { organization: organizationRow('org-a', 'studio-muster') },
      });
      const middleware = new TenantResolutionMiddleware(prisma, config());
      const next = vi.fn(() => {
        expect(currentTenant()?.id).toBe('org-a');
      });

      await middleware.middleware(
        fakeRequest({}, 'studio-muster.de'),
        {} as Response,
        next as NextFunction,
      );

      expect(findDomain).toHaveBeenCalledWith(
        expect.objectContaining({ where: { hostname: 'studio-muster.de' } }),
      );
      expect(next).toHaveBeenCalledWith();
    });

    it('normalizes the forwarded host before looking it up', async () => {
      const { prisma, findDomain } = fakePrisma({
        domain: { organization: organizationRow('org-a', 'studio-muster') },
      });
      const middleware = new TenantResolutionMiddleware(prisma, config());

      await middleware.middleware(
        fakeRequest({}, 'Studio-Muster.DE.'),
        {} as Response,
        vi.fn() as NextFunction,
      );

      expect(findDomain).toHaveBeenCalledWith(
        expect.objectContaining({ where: { hostname: 'studio-muster.de' } }),
      );
    });

    // The whole point of resolving by domain: a link a customer kept from the central
    // address cannot redirect the visit to a different organizer's calendar.
    it('ignores a contradicting ?organizer= on a registered domain', async () => {
      const { prisma, findOrganization } = fakePrisma({
        domain: { organization: organizationRow('org-a', 'studio-muster') },
        organization: organizationRow('org-b', 'other-studio'),
      });
      const middleware = new TenantResolutionMiddleware(prisma, config());
      const next = vi.fn(() => {
        expect(currentTenant()?.id).toBe('org-a');
      });

      await middleware.middleware(
        fakeRequest({ organizer: 'other-studio' }, 'studio-muster.de'),
        {} as Response,
        next as NextFunction,
      );

      expect(findOrganization).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith();
    });

    it('ignores a malformed ?organizer= on a registered domain rather than rejecting', async () => {
      const { prisma } = fakePrisma({
        domain: { organization: organizationRow('org-a', 'studio-muster') },
      });
      const middleware = new TenantResolutionMiddleware(prisma, config());
      const next = vi.fn(() => {
        expect(currentTenant()?.id).toBe('org-a');
      });

      await middleware.middleware(
        fakeRequest({ organizer: ['a', 'b'] }, 'studio-muster.de'),
        {} as Response,
        next as NextFunction,
      );

      expect(next).toHaveBeenCalledWith();
    });

    it('rejects when a registered domain points at an organization with no settings row', async () => {
      const { prisma } = fakePrisma({
        domain: { organization: { id: 'org-a', slug: 'studio-muster', settings: null } },
      });
      const middleware = new TenantResolutionMiddleware(prisma, config());
      const next = vi.fn();

      await expect(
        middleware.middleware(
          fakeRequest({}, 'studio-muster.de'),
          {} as Response,
          next as NextFunction,
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'ORGANIZATION_NOT_FOUND' }));

      expect(next).not.toHaveBeenCalled();
    });

    // A central hostname registered as an organizer domain out of band must not take
    // over the central address, and the fast path makes that structural rather than a
    // rule the write side alone upholds.
    it('never looks up a domain for the central host', async () => {
      const { prisma, findDomain } = fakePrisma({
        organization: organizationRow('org-b', 'other-studio'),
      });
      const middleware = new TenantResolutionMiddleware(prisma, config());

      await middleware.middleware(
        fakeRequest({ organizer: 'other-studio' }, CENTRAL_HOST),
        {} as Response,
        vi.fn() as NextFunction,
      );

      expect(findDomain).not.toHaveBeenCalled();
    });
  });

  describe('resolving from ?organizer= on a central host', () => {
    it('resolves the tenant scope when ?organizer= names a real organization', async () => {
      const { prisma } = fakePrisma({ organization: organizationRow('org-1', 'acme') });
      const middleware = new TenantResolutionMiddleware(prisma, config());
      const next = vi.fn(() => {
        expect(hasTenant()).toBe(true);
      });

      await middleware.middleware(
        fakeRequest({ organizer: 'acme' }),
        {} as Response,
        next as NextFunction,
      );

      expect(next).toHaveBeenCalledWith();
    });

    it('rejects instead of falling through when ?organizer= names no organization', async () => {
      const { prisma } = fakePrisma();
      const middleware = new TenantResolutionMiddleware(prisma, config());
      const next = vi.fn();

      await expect(
        middleware.middleware(
          fakeRequest({ organizer: 'ghost' }),
          {} as Response,
          next as NextFunction,
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'ORGANIZATION_NOT_FOUND' }));

      expect(next).not.toHaveBeenCalled();
    });

    // A present-but-malformed parameter is an explicit identity that cannot be resolved,
    // not an absent one. Reading it as absent is what lets a tampered link operate on the
    // bootstrap tenant's data.
    it.each([
      ['an empty value', { organizer: '' }],
      ['repeated values', { organizer: ['a', 'b'] }],
    ])('rejects %s rather than serving the default organization', async (_label, query) => {
      const { prisma, findOrganization } = fakePrisma();
      const middleware = new TenantResolutionMiddleware(prisma, config());
      const next = vi.fn();

      await expect(
        middleware.middleware(fakeRequest(query), {} as Response, next as NextFunction),
      ).rejects.toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

      expect(findOrganization).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    it('treats the API origin as central too', async () => {
      const { prisma } = fakePrisma({ organization: organizationRow('org-1', 'acme') });
      const middleware = new TenantResolutionMiddleware(
        prisma,
        config({ PUBLIC_API_ORIGIN: 'https://api.example.com' }),
      );
      const next = vi.fn();

      await middleware.middleware(
        fakeRequest({ organizer: 'acme' }, 'api.example.com'),
        {} as Response,
        next as NextFunction,
      );

      expect(next).toHaveBeenCalledWith();
    });

    it('treats loopback as central outside production, which is how the suite reaches it', async () => {
      const { prisma } = fakePrisma({ organization: organizationRow('org-1', 'acme') });
      const middleware = new TenantResolutionMiddleware(prisma, config({ NODE_ENV: 'test' }));
      const next = vi.fn();

      await middleware.middleware(
        fakeRequest({ organizer: 'acme' }, '127.0.0.1'),
        {} as Response,
        next as NextFunction,
      );

      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('rejecting a foreign host that offers a slug', () => {
    // Without this gate, any hostname somebody points at this server becomes a working
    // front end for every tenant — pick the slug, get the catalogue.
    it('rejects an unregistered host carrying ?organizer=', async () => {
      const { prisma, findOrganization } = fakePrisma({
        organization: organizationRow('org-1', 'acme'),
      });
      const middleware = new TenantResolutionMiddleware(prisma, config());
      const next = vi.fn();

      await expect(
        middleware.middleware(
          fakeRequest({ organizer: 'acme' }, 'attacker.example'),
          {} as Response,
          next as NextFunction,
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'ORGANIZATION_NOT_FOUND' }));

      expect(findOrganization).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    });

    // The 404 must not distinguish "that slug does not exist" from "this host may not
    // ask", or the gate becomes a slug oracle for anyone with a spare domain.
    it('rejects a foreign host with an unknown slug identically', async () => {
      const { prisma } = fakePrisma();
      const middleware = new TenantResolutionMiddleware(prisma, config());

      await expect(
        middleware.middleware(
          fakeRequest({ organizer: 'ghost' }, 'attacker.example'),
          {} as Response,
          vi.fn() as NextFunction,
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'ORGANIZATION_NOT_FOUND' }));
    });

    it('rejects a request whose Host header is unusable but which offers a slug', async () => {
      const { prisma } = fakePrisma({ organization: organizationRow('org-1', 'acme') });
      const middleware = new TenantResolutionMiddleware(prisma, config());

      await expect(
        middleware.middleware(
          fakeRequest({ organizer: 'acme' }, 'not a host'),
          {} as Response,
          vi.fn() as NextFunction,
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'ORGANIZATION_NOT_FOUND' }));
    });

    it('rejects *.localhost carrying a slug in production', async () => {
      const { prisma } = fakePrisma({ organization: organizationRow('org-1', 'acme') });
      const middleware = new TenantResolutionMiddleware(prisma, config());

      await expect(
        middleware.middleware(
          fakeRequest({ organizer: 'acme' }, 'evil.localhost'),
          {} as Response,
          vi.fn() as NextFunction,
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'ORGANIZATION_NOT_FOUND' }));
    });
  });
});
