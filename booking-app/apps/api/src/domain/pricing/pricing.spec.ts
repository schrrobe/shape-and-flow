import { describe, expect, it } from 'vitest';

import { Money } from '../money/money.js';

import { computeSuggestedRetainedAmount } from './cancellation-fee.js';
import { resolveEffectivePrice } from './pricing.js';

import type { CancellationFeeSettings } from './cancellation-fee.js';

const service = { priceCents: 4500, currency: 'EUR' };

const settings = (overrides: Partial<CancellationFeeSettings> = {}): CancellationFeeSettings => ({
  freeCancellationHours: 72,
  cancellationFeePolicy: 'NONE',
  cancellationFeeAmountCents: 0,
  cancellationFeePercent: 0,
  ...overrides,
});

const STARTS_AT = new Date('2026-08-14T07:00:00.000Z');
/** `hours` before the appointment. */
const hoursBefore = (hours: number): Date => new Date(STARTS_AT.getTime() - hours * 3_600_000);

const compute = (
  paidCents: number,
  hours: number,
  overrides: Partial<CancellationFeeSettings> = {},
) =>
  computeSuggestedRetainedAmount({
    paid: Money.fromCents(paidCents),
    startsAt: STARTS_AT,
    now: hoursBefore(hours),
    settings: settings(overrides),
  });

describe('resolveEffectivePrice', () => {
  it('uses the service price when there is no link or no override', () => {
    expect(resolveEffectivePrice(service, null).amountCents).toBe(4500);
    expect(resolveEffectivePrice(service, { priceOverrideCents: null }).amountCents).toBe(4500);
  });

  it('uses the override when present', () => {
    expect(resolveEffectivePrice(service, { priceOverrideCents: 5200 }).amountCents).toBe(5200);
  });

  it('treats a zero override as a real price, not as absent', () => {
    // `||` would fall back to 4500 here. A service one employee performs free of
    // charge is a legitimate configuration.
    expect(resolveEffectivePrice(service, { priceOverrideCents: 0 }).amountCents).toBe(0);
  });

  it('carries the service currency through', () => {
    expect(resolveEffectivePrice({ priceCents: 100, currency: 'CHF' }, null).currency).toBe('CHF');
  });

  it('returns Money, so no caller can do cent arithmetic on it', () => {
    expect(resolveEffectivePrice(service, null)).toBeInstanceOf(Money);
  });

  it('rejects a negative list price or employee override', () => {
    expect(() => resolveEffectivePrice({ ...service, priceCents: -1 }, null)).toThrow(
      /non-negative/i,
    );
    expect(() => resolveEffectivePrice(service, { priceOverrideCents: -1 })).toThrow(
      /non-negative/i,
    );
  });
});

describe('computeSuggestedRetainedAmount — the window', () => {
  it('retains nothing when cancelling well before the window', () => {
    const result = compute(4500, 96);
    expect(result.feeApplies).toBe(false);
    expect(result.suggestedRetained.amountCents).toBe(0);
    expect(result.suggestedRefund.amountCents).toBe(4500);
  });

  it('treats exactly the limit as free, favouring the customer', () => {
    // A customer told "free up to 72 hours before" must not be charged at
    // precisely 72 hours.
    const result = compute(4500, 72, {
      cancellationFeePolicy: 'FIXED_AMOUNT',
      cancellationFeeAmountCents: 2000,
    });
    expect(result.feeApplies).toBe(false);
    expect(result.suggestedRetained.amountCents).toBe(0);
  });

  it('applies the fee just inside the limit', () => {
    const result = compute(4500, 71.9, {
      cancellationFeePolicy: 'FIXED_AMOUNT',
      cancellationFeeAmountCents: 2000,
    });
    expect(result.feeApplies).toBe(true);
    expect(result.suggestedRetained.amountCents).toBe(2000);
  });

  it('applies the fee to an appointment already in the past', () => {
    const result = compute(4500, -2, {
      cancellationFeePolicy: 'PERCENTAGE',
      cancellationFeePercent: 100,
    });
    expect(result.feeApplies).toBe(true);
    expect(result.suggestedRetained.amountCents).toBe(4500);
  });

  it('reports the hours remaining, so a caller can explain the decision', () => {
    expect(compute(4500, 48).hoursUntilStart).toBe(48);
    expect(compute(4500, -2).hoursUntilStart).toBe(-2);
  });

  it('honours a zero free-cancellation window, where every cancellation is free', () => {
    const result = compute(4500, 1, {
      freeCancellationHours: 0,
      cancellationFeePolicy: 'PERCENTAGE',
      cancellationFeePercent: 50,
    });
    expect(result.feeApplies).toBe(false);
    expect(result.suggestedRetained.amountCents).toBe(0);
  });
});

describe('computeSuggestedRetainedAmount — the policies', () => {
  it('NONE retains nothing even inside the window', () => {
    const result = compute(4500, 48);
    expect(result.feeApplies).toBe(true);
    expect(result.suggestedRetained.amountCents).toBe(0);
    expect(result.suggestedRefund.amountCents).toBe(4500);
  });

  it('FIXED_AMOUNT retains the configured amount', () => {
    const result = compute(4500, 48, {
      cancellationFeePolicy: 'FIXED_AMOUNT',
      cancellationFeeAmountCents: 2000,
    });
    expect(result.suggestedRetained.amountCents).toBe(2000);
    expect(result.suggestedRefund.amountCents).toBe(2500);
  });

  it('FIXED_AMOUNT never retains more than was paid', () => {
    const result = compute(1000, 48, {
      cancellationFeePolicy: 'FIXED_AMOUNT',
      cancellationFeeAmountCents: 2000,
    });
    expect(result.suggestedRetained.amountCents).toBe(1000);
    expect(result.suggestedRefund.amountCents).toBe(0);
  });

  it('treats a corrupt negative fixed-fee setting as zero', () => {
    const result = compute(1000, 48, {
      cancellationFeePolicy: 'FIXED_AMOUNT',
      cancellationFeeAmountCents: -1,
    });
    expect(result.suggestedRetained.amountCents).toBe(0);
    expect(result.suggestedRefund.amountCents).toBe(1000);
  });

  it('PERCENTAGE retains a share, truncated in the customer favour', () => {
    expect(
      compute(4501, 48, { cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 33 })
        .suggestedRetained.amountCents,
      // 1485.33 → 1485
    ).toBe(1485);

    expect(
      compute(4500, 48, { cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 50 })
        .suggestedRetained.amountCents,
    ).toBe(2250);
  });

  it('PERCENTAGE at 100 retains everything and at 0 retains nothing', () => {
    expect(
      compute(4500, 48, { cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 100 })
        .suggestedRefund.amountCents,
    ).toBe(0);
    expect(
      compute(4500, 48, { cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 0 })
        .suggestedRetained.amountCents,
    ).toBe(0);
  });

  it('retains nothing when nothing was paid, whatever the policy', () => {
    // An unpaid manual booking must not produce a fee suggestion against money
    // that was never taken.
    for (const overrides of [
      { cancellationFeePolicy: 'PERCENTAGE' as const, cancellationFeePercent: 50 },
      { cancellationFeePolicy: 'FIXED_AMOUNT' as const, cancellationFeeAmountCents: 2000 },
    ]) {
      const result = compute(0, 48, overrides);
      expect(result.suggestedRetained.amountCents).toBe(0);
      expect(result.suggestedRefund.amountCents).toBe(0);
    }
  });
});

describe('computeSuggestedRetainedAmount — invariants', () => {
  it('always splits the paid amount exactly, with neither part negative', () => {
    const cases = [
      { paid: 4500, hours: 96, overrides: {} },
      { paid: 4500, hours: 48, overrides: {} },
      {
        paid: 4501,
        hours: 1,
        overrides: { cancellationFeePolicy: 'PERCENTAGE' as const, cancellationFeePercent: 33 },
      },
      {
        paid: 1000,
        hours: 1,
        overrides: {
          cancellationFeePolicy: 'FIXED_AMOUNT' as const,
          cancellationFeeAmountCents: 9999,
        },
      },
      {
        paid: 1,
        hours: 1,
        overrides: { cancellationFeePolicy: 'PERCENTAGE' as const, cancellationFeePercent: 50 },
      },
      {
        paid: 0,
        hours: 1,
        overrides: { cancellationFeePolicy: 'PERCENTAGE' as const, cancellationFeePercent: 50 },
      },
    ];

    for (const { paid, hours, overrides } of cases) {
      const result = compute(paid, hours, overrides);
      const label = `paid=${String(paid)} hours=${String(hours)}`;

      expect(
        result.suggestedRetained.plus(result.suggestedRefund).amountCents,
        `${label}: parts must sum to the amount paid`,
      ).toBe(paid);
      expect(result.suggestedRetained.isNegative(), `${label}: retained`).toBe(false);
      expect(result.suggestedRefund.isNegative(), `${label}: refund`).toBe(false);
    }
  });

  it('preserves the currency of the amount paid', () => {
    const result = computeSuggestedRetainedAmount({
      paid: Money.fromCents(1000, 'CHF'),
      startsAt: STARTS_AT,
      now: hoursBefore(1),
      settings: settings({ cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 50 }),
    });
    expect(result.suggestedRetained.currency).toBe('CHF');
    expect(result.suggestedRefund.currency).toBe('CHF');
  });
});
