import { describe, expect, it } from 'vitest';

import { registerOrganizationRequestSchema } from './organizations.js';

const BASE = {
  email: 'owner@example.com',
  password: 'Correct-Horse-Battery-9',
  displayName: 'Acme Studio',
  contactPhone: '+49 30 1234567',
  addressLine1: 'Musterstraße 1',
  postalCode: '10115',
  city: 'Berlin',
};

describe('registerOrganizationRequestSchema', () => {
  it('accepts an INDIVIDUAL registration with firstName/lastName', () => {
    const result = registerOrganizationRequestSchema.safeParse({
      ...BASE,
      entityType: 'INDIVIDUAL',
      firstName: 'Jane',
      lastName: 'Doe',
    });
    expect(result.success).toBe(true);
  });

  it('rejects INDIVIDUAL without lastName', () => {
    const result = registerOrganizationRequestSchema.safeParse({
      ...BASE,
      entityType: 'INDIVIDUAL',
      firstName: 'Jane',
    });
    expect(result.success).toBe(false);
  });

  it('requires companyName for ORGANIZATION', () => {
    const result = registerOrganizationRequestSchema.safeParse({
      ...BASE,
      entityType: 'ORGANIZATION',
    });
    expect(result.success).toBe(false);
  });

  it('accepts ORGANIZATION with companyName and isSmallBusiness in Germany', () => {
    const result = registerOrganizationRequestSchema.safeParse({
      ...BASE,
      entityType: 'ORGANIZATION',
      companyName: 'Acme GmbH',
      country: 'DE',
      isSmallBusiness: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects isSmallBusiness outside Germany', () => {
    const result = registerOrganizationRequestSchema.safeParse({
      ...BASE,
      entityType: 'ORGANIZATION',
      companyName: 'Acme GmbH',
      country: 'FR',
      isSmallBusiness: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field (strict)', () => {
    const result = registerOrganizationRequestSchema.safeParse({
      ...BASE,
      entityType: 'INDIVIDUAL',
      firstName: 'Jane',
      lastName: 'Doe',
      extra: 'nope',
    });
    expect(result.success).toBe(false);
  });
});
