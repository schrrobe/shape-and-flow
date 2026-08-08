import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { STRIPE_CLIENT } from '../providers/providers.module.js';

import { StripeConnectService } from './stripe-connect.service.js';

describe('StripeConnectService', () => {
  it('throws when Stripe is not configured', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [StripeConnectService, { provide: STRIPE_CLIENT, useValue: null }],
    }).compile();

    const service = moduleRef.get(StripeConnectService);
    await expect(
      service.createExpressAccount({ email: 'a@b.com', country: 'DE', businessType: 'individual' }),
    ).rejects.toThrow('PAYMENT_PROVIDER');
  });

  it('creates an Express account with the given business type', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'acct_123' });
    const stripe = { accounts: { create } };

    const moduleRef = await Test.createTestingModule({
      providers: [StripeConnectService, { provide: STRIPE_CLIENT, useValue: stripe }],
    }).compile();

    const service = moduleRef.get(StripeConnectService);
    const result = await service.createExpressAccount({
      email: 'a@b.com',
      country: 'DE',
      businessType: 'individual',
    });

    expect(result).toEqual({ stripeAccountId: 'acct_123' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'express', country: 'DE', email: 'a@b.com' }),
      undefined,
    );
  });

  // Account creation is not naturally idempotent. Without a key, a double-click makes
  // two Express accounts and the one the row does not name is an orphan whose completion
  // events are ignored forever.
  it('passes the idempotency key through to Stripe', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'acct_123' });
    const stripe = { accounts: { create } };

    const moduleRef = await Test.createTestingModule({
      providers: [StripeConnectService, { provide: STRIPE_CLIENT, useValue: stripe }],
    }).compile();

    await moduleRef.get(StripeConnectService).createExpressAccount({
      email: 'a@b.com',
      country: 'DE',
      businessType: 'individual',
      idempotencyKey: 'org-org_1-express-account',
    });

    expect(create).toHaveBeenCalledWith(expect.any(Object), {
      idempotencyKey: 'org-org_1-express-account',
    });
  });

  it('creates an account link with the given return url', async () => {
    const create = vi.fn().mockResolvedValue({ url: 'https://connect.stripe.com/setup/xyz' });
    const stripe = { accountLinks: { create } };

    const moduleRef = await Test.createTestingModule({
      providers: [StripeConnectService, { provide: STRIPE_CLIENT, useValue: stripe }],
    }).compile();

    const service = moduleRef.get(StripeConnectService);
    const result = await service.createAccountLink('acct_123', 'https://app.example.com/return');

    expect(result).toEqual({ url: 'https://connect.stripe.com/setup/xyz' });
    expect(create).toHaveBeenCalledWith({
      account: 'acct_123',
      type: 'account_onboarding',
      return_url: 'https://app.example.com/return',
      refresh_url: 'https://app.example.com/return',
    });
  });
});
