import { describe, expect, it } from 'vitest';

import { currentTenant, hasTenant, runWithTenant } from './tenant-context.store.js';

import type { OrganizationWithSettings } from './organization-context.service.js';

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
