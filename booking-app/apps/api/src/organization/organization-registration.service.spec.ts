import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { PasswordService } from '../auth/password.service.js';
import { SessionStore } from '../auth/session.store.js';
import { ENV } from '../config/env.schema.js';
import { Prisma } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { OrganizationRegistrationService } from './organization-registration.service.js';
import { slugify } from './slug.js';
import { StripeConnectService } from './stripe-connect.service.js';

import type { RegisterOrganizationRequest } from '@shape-and-flow/booking-contracts';

/**
 * Shape of a real 23505 unique violation on the `slug` column, as Prisma 7's
 * pg driver adapter reports it (see prisma-errors.spec.ts for the captured
 * shape this mirrors).
 */
function slugUniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Database error.', {
    code: 'P2002',
    clientVersion: '7.9.1',
    meta: {
      modelName: 'Organization',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          originalMessage: 'duplicate key value violates unique constraint "organizations_slug_key"',
          kind: 'UniqueConstraintViolation',
          constraint: { fields: ['slug'] },
        },
      },
    },
  });
}

function transactionTx() {
  return {
    organization: {
      create: vi.fn().mockImplementation(({ data }: { data: { slug: string } }) =>
        Promise.resolve({ id: 'org_1', slug: data.slug }),
      ),
    },
    organizationSettings: { create: vi.fn().mockResolvedValue({ id: 'settings_1' }) },
    officeUser: {
      create: vi.fn().mockResolvedValue({
        id: 'user_1',
        organizationId: 'org_1',
        role: 'OWNER',
        canIssueRefunds: true,
        employeeId: null,
      }),
    },
  };
}

const REQUEST: RegisterOrganizationRequest = {
  entityType: 'INDIVIDUAL',
  email: 'owner@example.com',
  password: 'Correct-Horse-Battery-9',
  displayName: 'Acme Studio',
  contactPhone: '+49 30 1234567',
  addressLine1: 'Musterstraße 1',
  postalCode: '10115',
  city: 'Berlin',
  country: 'DE',
  firstName: 'Jane',
  lastName: 'Doe',
  isSmallBusiness: false,
};

describe('OrganizationRegistrationService', () => {
  it('creates organization, owner, and Stripe account session', async () => {
    const prisma = {
      $transaction: vi.fn((fn: (tx: unknown) => unknown) =>
        fn({
          organization: {
            create: vi.fn().mockResolvedValue({ id: 'org_1', slug: 'acme-studio' }),
          },
          organizationSettings: { create: vi.fn().mockResolvedValue({ id: 'settings_1' }) },
          officeUser: {
            create: vi.fn().mockResolvedValue({
              id: 'user_1',
              organizationId: 'org_1',
              role: 'OWNER',
              canIssueRefunds: true,
              employeeId: null,
            }),
          },
        }),
      ),
      organization: { update: vi.fn().mockResolvedValue({}) },
    };

    const passwords = { hash: vi.fn().mockResolvedValue('hashed') };
    const sessions = { create: vi.fn().mockResolvedValue('sid_1') };
    const stripeConnect = {
      createExpressAccount: vi.fn().mockResolvedValue({ stripeAccountId: 'acct_1' }),
      createAccountLink: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/x' }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationRegistrationService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: passwords },
        { provide: SessionStore, useValue: sessions },
        { provide: StripeConnectService, useValue: stripeConnect },
        { provide: ENV, useValue: { PUBLIC_WEB_ORIGIN: 'https://app.example.com' } },
      ],
    }).compile();

    const service = moduleRef.get(OrganizationRegistrationService);
    const result = await service.register(REQUEST);

    expect(result.response).toEqual({
      id: 'org_1',
      slug: 'acme-studio',
      onboardingLink: 'https://connect.stripe.com/x',
    });
    expect(result.sid).toBe('sid_1');
    expect(passwords.hash).toHaveBeenCalledWith(REQUEST.password);
    expect(stripeConnect.createExpressAccount).toHaveBeenCalledWith({
      email: REQUEST.email,
      country: 'DE',
      businessType: 'individual',
    });
  });

  it('retries with a suffixed slug when the base slug collides, and succeeds on the second attempt', async () => {
    const transaction = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(slugUniqueViolation()))
      .mockImplementationOnce((fn: (tx: unknown) => unknown) => fn(transactionTx()));

    const prisma = {
      $transaction: transaction,
      organization: { update: vi.fn().mockResolvedValue({}) },
    };

    const passwords = { hash: vi.fn().mockResolvedValue('hashed') };
    const sessions = { create: vi.fn().mockResolvedValue('sid_1') };
    const stripeConnect = {
      createExpressAccount: vi.fn().mockResolvedValue({ stripeAccountId: 'acct_1' }),
      createAccountLink: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/x' }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationRegistrationService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: passwords },
        { provide: SessionStore, useValue: sessions },
        { provide: StripeConnectService, useValue: stripeConnect },
        { provide: ENV, useValue: { PUBLIC_WEB_ORIGIN: 'https://app.example.com' } },
      ],
    }).compile();

    const service = moduleRef.get(OrganizationRegistrationService);
    const result = await service.register(REQUEST);

    const base = slugify(REQUEST.displayName);
    expect(result.response.slug).not.toBe(base);
    expect(result.response.slug.startsWith(`${base}-`)).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('rejects with ORGANIZATION_CREATE_ERROR, not the raw error, once every slug attempt collides', async () => {
    const transaction = vi.fn(() => Promise.reject(slugUniqueViolation()));

    const prisma = {
      $transaction: transaction,
      organization: { update: vi.fn().mockResolvedValue({}) },
    };

    const passwords = { hash: vi.fn().mockResolvedValue('hashed') };
    const sessions = { create: vi.fn().mockResolvedValue('sid_1') };
    const stripeConnect = {
      createExpressAccount: vi.fn().mockResolvedValue({ stripeAccountId: 'acct_1' }),
      createAccountLink: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/x' }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationRegistrationService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: passwords },
        { provide: SessionStore, useValue: sessions },
        { provide: StripeConnectService, useValue: stripeConnect },
        { provide: ENV, useValue: { PUBLIC_WEB_ORIGIN: 'https://app.example.com' } },
      ],
    }).compile();

    const service = moduleRef.get(OrganizationRegistrationService);

    await expect(service.register(REQUEST)).rejects.toMatchObject({
      code: 'ORGANIZATION_CREATE_ERROR',
    });
    expect(transaction).toHaveBeenCalledTimes(5);
  });

  it('resolves with onboardingLink: null, keeping the committed organization, when Stripe fails', async () => {
    const prisma = {
      $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(transactionTx())),
      organization: { update: vi.fn().mockResolvedValue({}) },
    };

    const passwords = { hash: vi.fn().mockResolvedValue('hashed') };
    const sessions = { create: vi.fn().mockResolvedValue('sid_1') };
    const stripeConnect = {
      createExpressAccount: vi.fn().mockRejectedValue(new Error('Stripe unreachable')),
      createAccountLink: vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/x' }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationRegistrationService,
        { provide: PrismaService, useValue: prisma },
        { provide: PasswordService, useValue: passwords },
        { provide: SessionStore, useValue: sessions },
        { provide: StripeConnectService, useValue: stripeConnect },
        { provide: ENV, useValue: { PUBLIC_WEB_ORIGIN: 'https://app.example.com' } },
      ],
    }).compile();

    const service = moduleRef.get(OrganizationRegistrationService);
    const result = await service.register(REQUEST);

    expect(result.response.onboardingLink).toBeNull();
    expect(result.sid).toBe('sid_1');
    expect(stripeConnect.createAccountLink).not.toHaveBeenCalled();
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });
});
