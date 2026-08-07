import { describe, expect, it, vi } from 'vitest';

import { OrganizationContextService } from './organization-context.service.js';
import { runWithTenant } from './tenant-context.store.js';

import type { OrganizationWithSettings } from './organization-context.service.js';
import type { AppConfig } from '../config/env.schema.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const config = { DEFAULT_ORGANIZATION_SLUG: 'shape-and-flow' } as AppConfig;

const organization = {
  id: 'org-1',
  slug: 'shape-and-flow',
  name: 'Shape and Flow',
  timezone: 'Europe/Berlin',
  settings: {
    id: 'settings-1',
    organizationId: 'org-1',
    schedulingIntervalMinutes: 15,
  },
} as OrganizationWithSettings;

function serviceReturning(value: unknown): {
  service: OrganizationContextService;
  findUnique: ReturnType<typeof vi.fn>;
} {
  const findUnique = vi.fn().mockResolvedValue(value);
  const prisma = { organization: { findUnique } } as unknown as PrismaService;
  return { service: new OrganizationContextService(config, prisma), findUnique };
}

describe('OrganizationContextService', () => {
  it('refuses reads before bootstrap has loaded the organization', () => {
    const { service } = serviceReturning(organization);

    expect(() => service.get()).toThrow(/before bootstrap/i);
  });

  it('loads the configured organization and exposes its context', async () => {
    const { service, findUnique } = serviceReturning(organization);

    await service.onApplicationBootstrap();

    expect(findUnique).toHaveBeenCalledWith({
      where: { slug: 'shape-and-flow' },
      include: { settings: true },
    });
    expect(service.get()).toMatchObject({ id: 'org-1', slug: 'shape-and-flow' });
    expect(service.getOrganizationId()).toBe('org-1');
    expect(service.getTimezone()).toBe('Europe/Berlin');
    expect(service.getSettings()).toMatchObject({ schedulingIntervalMinutes: 15 });
  });

  it('fails bootstrap when the configured organization does not exist', async () => {
    const { service } = serviceReturning(null);

    await expect(service.refresh()).rejects.toThrow(/shape-and-flow.*not found/i);
  });

  it('fails bootstrap when the organization has no settings row', async () => {
    const { settings: _settings, ...withoutSettings } = organization;
    const { service } = serviceReturning({ ...withoutSettings, settings: null });

    await expect(service.refresh()).rejects.toThrow(/no settings row/i);
  });

  it('replaces the process-local settings snapshot on refresh', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(organization)
      .mockResolvedValueOnce({
        ...organization,
        settings: { ...organization.settings, schedulingIntervalMinutes: 30 },
      });
    const service = new OrganizationContextService(config, {
      organization: { findUnique },
    } as unknown as PrismaService);

    await service.refresh();
    await service.refresh();

    expect(service.getSettings().schedulingIntervalMinutes).toBe(30);
  });

  it('returns bootstrap organization outside any tenant scope', async () => {
    const { service } = serviceReturning(organization);

    await service.onApplicationBootstrap();

    expect(service.get().id).toBe('org-1');
  });

  it('returns scoped organization inside runWithTenant', async () => {
    const { service } = serviceReturning(organization);
    await service.onApplicationBootstrap();

    const scoped = {
      ...organization,
      id: 'org-2',
      slug: 'acme',
    } as OrganizationWithSettings;

    runWithTenant(scoped, () => {
      expect(service.get().id).toBe('org-2');
      expect(service.getOrganizationId()).toBe('org-2');
      expect(service.getTimezone()).toBe('Europe/Berlin');
    });

    expect(service.get().id).toBe('org-1');
  });

  it('loads settings for an explicit organization id, independent of ALS or bootstrap state', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(organization) // bootstrap load
      .mockResolvedValueOnce({ ...organization, id: 'org-2', settings: { ...organization.settings, id: 'settings-2', organizationId: 'org-2', schedulingIntervalMinutes: 30 } });
    // `getSettingsFor` calls `findUniqueOrThrow`, not `findUnique`; aliased to the same
    // mock so both bootstrap's `findUnique` call and this method's call draw from the
    // same queued responses in call order.
    const prisma = {
      organization: { findUnique, findUniqueOrThrow: findUnique },
    } as unknown as PrismaService;
    const service = new OrganizationContextService(config, prisma);
    await service.onApplicationBootstrap();

    const settings = await service.getSettingsFor('org-2');

    expect(settings.schedulingIntervalMinutes).toBe(30);
    expect(service.get().id).toBe('org-1');
  });

  it('loads the timezone for an explicit organization id', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(organization)
      .mockResolvedValueOnce({ ...organization, id: 'org-2', timezone: 'America/New_York' });
    const prisma = {
      organization: { findUnique, findUniqueOrThrow: findUnique },
    } as unknown as PrismaService;
    const service = new OrganizationContextService(config, prisma);
    await service.onApplicationBootstrap();

    const timezone = await service.getTimezoneFor('org-2');

    expect(timezone).toBe('America/New_York');
  });
});
