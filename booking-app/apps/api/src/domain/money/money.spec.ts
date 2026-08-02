import { describe, expect, it } from 'vitest';

import { formatMoney } from './format.js';
import { Money } from './money.js';

/** Intl separates the amount from the symbol with U+00A0; normalise for readability. */
const plain = (value: string): string => value.replace(/\u00a0/g, ' ');

describe('Money construction', () => {
  it('rejects a fractional cent', () => {
    // A fractional cent means a rounding decision happened somewhere it should
    // not have; failing loudly is the point.
    expect(() => Money.fromCents(10.5)).toThrow(/integer/i);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => Money.fromCents(Number.NaN)).toThrow(/finite/i);
    expect(() => Money.fromCents(Number.POSITIVE_INFINITY)).toThrow(/finite/i);
    expect(() => Money.fromCents(Number.NEGATIVE_INFINITY)).toThrow(/finite/i);
  });

  it('rejects an amount beyond the safe integer range', () => {
    expect(() => Money.fromCents(Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe integer/i);
  });

  it('accepts zero and negative amounts', () => {
    expect(Money.zero().amountCents).toBe(0);
    expect(Money.fromCents(-4500).amountCents).toBe(-4500);
  });

  it('defaults to EUR and accepts an explicit currency', () => {
    expect(Money.zero().currency).toBe('EUR');
    expect(Money.fromCents(100, 'CHF').currency).toBe('CHF');
  });

  it('is frozen, so an amount cannot be mutated after it is read', () => {
    const money = Money.fromCents(4500);
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { amountCents: number }).amountCents = 1;
    }).toThrow();
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(Money.fromCents(4500).plus(Money.fromCents(7900)).amountCents).toBe(12_400);
    expect(Money.fromCents(4500).minus(Money.fromCents(7900)).amountCents).toBe(-3400);
  });

  it('does not accumulate floating-point error over many additions', () => {
    // 0.1 + 0.2 !== 0.3 in floats; in integer cents this is exact by construction.
    let total = Money.zero();
    for (let i = 0; i < 1000; i += 1) total = total.plus(Money.fromCents(1));
    expect(total.amountCents).toBe(1000);
  });

  it('refuses to mix currencies', () => {
    expect(() => Money.fromCents(100, 'EUR').plus(Money.fromCents(100, 'CHF'))).toThrow(
      /Cannot combine EUR with CHF/,
    );
    expect(() => Money.fromCents(100, 'EUR').minus(Money.fromCents(100, 'CHF'))).toThrow(
      /currency|combine/i,
    );
    expect(() => Money.fromCents(100, 'EUR').lessThan(Money.fromCents(100, 'CHF'))).toThrow(
      /combine/i,
    );
  });

  it('sums a list, and an empty list is zero', () => {
    expect(Money.sum([Money.fromCents(4500), Money.fromCents(7900)]).amountCents).toBe(12_400);
    expect(Money.sum([]).amountCents).toBe(0);
  });

  it('returns new instances rather than mutating', () => {
    const original = Money.fromCents(4500);
    const result = original.plus(Money.fromCents(100));
    expect(original.amountCents).toBe(4500);
    expect(result).not.toBe(original);
  });
});

describe('Money.percent', () => {
  it('computes an exact percentage exactly', () => {
    expect(Money.fromCents(4500).percent(30).amountCents).toBe(1350);
    expect(Money.fromCents(4500).percent(100).amountCents).toBe(4500);
    expect(Money.fromCents(4500).percent(0).amountCents).toBe(0);
  });

  it('truncates in the customer favour rather than rounding', () => {
    // 33% of 101 is 33.33 → 33, not 34.
    expect(Money.fromCents(101).percent(33).amountCents).toBe(33);
    // 50% of one cent is half a cent → 0, never 1.
    expect(Money.fromCents(1).percent(50).amountCents).toBe(0);
    // 33% of 4501 is 1485.33 → 1485.
    expect(Money.fromCents(4501).percent(33).amountCents).toBe(1485);
  });

  it('truncates toward zero for negative amounts too', () => {
    expect(Money.fromCents(-101).percent(33).amountCents).toBe(-33);
  });

  it('rejects a percentage outside 0..100 or a fractional one', () => {
    expect(() => Money.fromCents(100).percent(101)).toThrow(/between 0 and 100/);
    expect(() => Money.fromCents(100).percent(-1)).toThrow(/between 0 and 100/);
    expect(() => Money.fromCents(100).percent(33.5)).toThrow(/whole number/);
  });
});

describe('Money comparison and capping', () => {
  it('caps at a ceiling, which is how a fixed fee cannot exceed what was paid', () => {
    const paid = Money.fromCents(1000);
    expect(Money.fromCents(2000).cappedAt(paid).amountCents).toBe(1000);
    expect(Money.fromCents(500).cappedAt(paid).amountCents).toBe(500);
    expect(Money.fromCents(1000).cappedAt(paid).amountCents).toBe(1000);
  });

  it('compares, and treats a different currency as unequal rather than throwing', () => {
    expect(Money.fromCents(100).lessThan(Money.fromCents(101))).toBe(true);
    expect(Money.fromCents(101).lessThan(Money.fromCents(100))).toBe(false);
    expect(Money.fromCents(100).equals(Money.fromCents(100))).toBe(true);
    expect(Money.fromCents(100, 'EUR').equals(Money.fromCents(100, 'CHF'))).toBe(false);
  });

  it('reports sign', () => {
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.fromCents(-1).isNegative()).toBe(true);
    expect(Money.fromCents(1).isPositive()).toBe(true);
    expect(Money.zero().isPositive()).toBe(false);
  });
});

describe('Money serialisation', () => {
  it('serialises to the API money shape, not a formatted string', () => {
    expect(Money.fromCents(4500).toJSON()).toEqual({ amountCents: 4500, currency: 'EUR' });
    expect(JSON.parse(JSON.stringify({ price: Money.fromCents(4500) }))).toEqual({
      price: { amountCents: 4500, currency: 'EUR' },
    });
  });
});

describe('formatMoney', () => {
  it('formats German with a comma separator and a trailing symbol', () => {
    expect(plain(formatMoney(Money.fromCents(4500), 'de'))).toBe('45,00 €');
    expect(plain(formatMoney(Money.fromCents(7900), 'de'))).toBe('79,00 €');
    expect(plain(formatMoney(Money.fromCents(2250), 'de'))).toBe('22,50 €');
  });

  it('formats English with a point separator and a leading symbol', () => {
    expect(plain(formatMoney(Money.fromCents(4500), 'en'))).toBe('€45.00');
    expect(plain(formatMoney(Money.fromCents(2250), 'en'))).toBe('€22.50');
  });

  it('always shows two fraction digits, including for whole and zero amounts', () => {
    expect(plain(formatMoney(Money.zero(), 'de'))).toBe('0,00 €');
    expect(plain(formatMoney(Money.fromCents(100), 'de'))).toBe('1,00 €');
  });

  it('groups thousands per locale', () => {
    expect(plain(formatMoney(Money.fromCents(123_456), 'de'))).toBe('1.234,56 €');
    expect(plain(formatMoney(Money.fromCents(123_456), 'en'))).toBe('€1,234.56');
  });

  it('formats a negative amount, which a correcting entry needs', () => {
    expect(plain(formatMoney(Money.fromCents(-4500), 'de'))).toBe('-45,00 €');
  });
});
