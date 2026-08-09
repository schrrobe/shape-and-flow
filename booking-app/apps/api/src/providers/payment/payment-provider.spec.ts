import { describe, expect, it } from 'vitest';

import { AppError } from '../../common/errors/app-error.js';
import { PaymentsMode } from '../../prisma/client.js';

import { accountForNewCharge, accountOfRecordedPayment } from './payment-provider.js';

describe('accountForNewCharge', () => {
  it('charges the platform account for a platform organization', () => {
    expect(
      accountForNewCharge({
        paymentsMode: PaymentsMode.PLATFORM,
        stripeAccountId: null,
        stripeChargesEnabled: false,
      }),
    ).toBeUndefined();
  });

  it('returns the connected account once charges are enabled', () => {
    expect(
      accountForNewCharge({
        paymentsMode: PaymentsMode.CONNECT,
        stripeAccountId: 'acct_123',
        stripeChargesEnabled: true,
      }),
    ).toBe('acct_123');
  });

  it('refuses a connected organization whose account cannot take charges yet', () => {
    expect(() =>
      accountForNewCharge({
        paymentsMode: PaymentsMode.CONNECT,
        stripeAccountId: 'acct_123',
        stripeChargesEnabled: false,
      }),
    ).toThrow(AppError);
  });

  // The registration path keeps an organization whose Stripe account creation failed.
  // Reading that null as "legacy platform tenant" is what would let a brand-new
  // organizer take money onto the platform account.
  it('refuses a connected organization that has no account yet', () => {
    expect(() =>
      accountForNewCharge({
        paymentsMode: PaymentsMode.CONNECT,
        stripeAccountId: null,
        stripeChargesEnabled: false,
      }),
    ).toThrow(AppError);
  });
});

describe('accountOfRecordedPayment', () => {
  it('reads the platform account from a null column', () => {
    expect(accountOfRecordedPayment({ stripeAccountId: null })).toBeUndefined();
  });

  it('reads the account the payment was created on', () => {
    expect(accountOfRecordedPayment({ stripeAccountId: 'acct_123' })).toBe('acct_123');
  });
});
