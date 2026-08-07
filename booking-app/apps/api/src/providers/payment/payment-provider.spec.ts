import { describe, expect, it } from 'vitest';

import { connectAccountId } from './payment-provider.js';

describe('connectAccountId', () => {
  it('returns undefined when no Stripe account exists yet', () => {
    expect(connectAccountId({ stripeAccountId: null, stripeChargesEnabled: false })).toBeUndefined();
  });

  it('returns undefined when an account exists but charges are not yet enabled', () => {
    expect(
      connectAccountId({ stripeAccountId: 'acct_123', stripeChargesEnabled: false }),
    ).toBeUndefined();
  });

  it('returns the account id once charges are enabled', () => {
    expect(connectAccountId({ stripeAccountId: 'acct_123', stripeChargesEnabled: true })).toBe(
      'acct_123',
    );
  });
});
