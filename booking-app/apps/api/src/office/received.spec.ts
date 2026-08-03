import { describe, expect, it } from 'vitest';

import { receivedFrom, refundedFrom } from './received.js';

describe('receivedFrom', () => {
  it('uses each stored payment currency so a mixed ledger is rejected', () => {
    const booking = {
      payments: [{ amountCents: 1000, status: 'SUCCEEDED', currency: 'USD' }],
      manualPayments: [{ amountCents: 500, currency: 'EUR' }],
    };

    expect(() => receivedFrom(booking, 'EUR')).toThrow('Cannot combine EUR with USD.');
  });
});

describe('refundedFrom', () => {
  it('uses the stored refund currency so a mixed ledger is rejected', () => {
    const booking = {
      refunds: [{ amountCents: 1000, status: 'SUCCEEDED', currency: 'USD' }],
    };

    expect(() => refundedFrom(booking, 'EUR')).toThrow('Cannot combine EUR with USD.');
  });
});
