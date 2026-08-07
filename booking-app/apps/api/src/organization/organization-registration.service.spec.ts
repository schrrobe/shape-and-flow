import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { PasswordService } from '../auth/password.service.js';
import { SessionStore } from '../auth/session.store.js';
import { ENV } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { OrganizationRegistrationService } from './organization-registration.service.js';
import { StripeConnectService } from './stripe-connect.service.js';

import type { RegisterOrganizationRequest } from '@shape-and-flow/booking-contracts';

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
});
