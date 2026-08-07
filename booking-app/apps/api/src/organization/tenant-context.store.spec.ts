import { describe, expect, it, vi } from 'vitest';

import { currentTenant, hasTenant, runWithOrganization, runWithTenant } from './tenant-context.store.js';

import type { OrganizationWithSettings } from './organization-context.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const ORG = {
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

describe('tenant-context.store', () => {
  it('has no tenant outside any scope', () => {
    expect(hasTenant()).toBe(false);
    expect(currentTenant()).toBeUndefined();
  });

  it('exposes the organization inside runWithTenant', () => {
    runWithTenant(ORG, () => {
      expect(hasTenant()).toBe(true);
      expect(currentTenant()).toBe(ORG);
    });
  });

  it('closes the scope once runWithTenant returns', () => {
    runWithTenant(ORG, () => {
      expect(currentTenant()).toBe(ORG);
    });

    expect(hasTenant()).toBe(false);
    expect(currentTenant()).toBeUndefined();
  });
});

describe('runWithOrganization', () => {
  it('loads the organization by id and runs fn inside its tenant scope', async () => {
    const organization = {
      id: 'org-2',
      slug: 'acme',
      timezone: 'America/New_York',
      settings: { id: 'settings-2', organizationId: 'org-2', schedulingIntervalMinutes: 15 },
    };
    const findUniqueOrThrow = vi.fn().mockResolvedValue(organization);
    const prisma = { organization: { findUniqueOrThrow } } as unknown as PrismaService;

    expect(hasTenant()).toBe(false);

    const result = await runWithOrganization('org-2', prisma, () => {
      expect(currentTenant()?.id).toBe('org-2');
      return 'done';
    });

    expect(result).toBe('done');
    expect(hasTenant()).toBe(false);
    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: 'org-2' },
      include: { settings: true },
    });
  });
});
