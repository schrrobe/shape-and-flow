import { AppError } from '../../common/errors/app-error.js';

/**
 * Money as integer minor units.
 *
 * Every amount in this system is cents in an `Int` column, and every
 * calculation goes through this type. Nothing else may do arithmetic on a value
 * whose name ends in `Cents` — an ESLint rule enforces that, with this directory
 * as the only exception — so there is exactly one place where a rounding or
 * currency mistake can be made, and it is tested.
 *
 * Instances are frozen and every operation returns a new instance, so an amount
 * cannot be mutated after it has been read.
 */

export const DEFAULT_CURRENCY = 'EUR';

function assertValidAmount(amountCents: number): void {
  if (!Number.isFinite(amountCents)) {
    throw new AppError('INVALID_MONEY', {
      status: 500,
      message: `Money requires a finite amount, received ${String(amountCents)}.`,
    });
  }

  if (!Number.isInteger(amountCents)) {
    throw new AppError('INVALID_MONEY', {
      status: 500,
      message:
        `Money requires an integer number of cents, received ${String(amountCents)}. ` +
        'A fractional cent means a rounding decision was made somewhere it should not have been.',
    });
  }

  if (!Number.isSafeInteger(amountCents)) {
    throw new AppError('INVALID_MONEY', {
      status: 500,
      message: `Money amount ${String(amountCents)} exceeds the safe integer range.`,
    });
  }
}

export interface MoneyJson {
  amountCents: number;
  currency: string;
}

export class Money {
  private constructor(
    readonly amountCents: number,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static fromCents(amountCents: number, currency: string = DEFAULT_CURRENCY): Money {
    assertValidAmount(amountCents);
    return new Money(amountCents, currency);
  }

  static zero(currency: string = DEFAULT_CURRENCY): Money {
    return new Money(0, currency);
  }

  /** Sum, in a fixed currency. An empty list needs an explicit currency. */
  static sum(amounts: readonly Money[], currency: string = DEFAULT_CURRENCY): Money {
    return amounts.reduce<Money>((total, amount) => total.plus(amount), Money.zero(currency));
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new AppError('CURRENCY_MISMATCH', {
        status: 500,
        message: `Cannot combine ${this.currency} with ${other.currency}.`,
        details: { left: this.currency, right: other.currency },
      });
    }
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.amountCents + other.amountCents, this.currency);
  }

  /** May return a negative amount: a compensating correction needs one. */
  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.amountCents - other.amountCents, this.currency);
  }

  /**
   * A whole-number percentage of this amount, truncated toward zero.
   *
   * Truncation is the deliberate choice, not rounding: for a cancellation fee it
   * leaves the fractional cent with the customer rather than the business. 50%
   * of one cent is zero, never one.
   */
  percent(percent: number): Money {
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw new AppError('INVALID_PERCENTAGE', {
        status: 500,
        message: `Percentage must be a whole number between 0 and 100, received ${String(percent)}.`,
      });
    }

    return Money.fromCents(Math.trunc((this.amountCents * percent) / 100), this.currency);
  }

  /** Clamp to at most `ceiling`, e.g. a fee that cannot exceed what was paid. */
  cappedAt(ceiling: Money): Money {
    this.assertSameCurrency(ceiling);
    return this.amountCents > ceiling.amountCents ? ceiling : this;
  }

  isZero(): boolean {
    return this.amountCents === 0;
  }

  isNegative(): boolean {
    return this.amountCents < 0;
  }

  isPositive(): boolean {
    return this.amountCents > 0;
  }

  lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amountCents < other.amountCents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountCents === other.amountCents;
  }

  /** The API money shape. Never a formatted string, never a float. */
  toJSON(): MoneyJson {
    return { amountCents: this.amountCents, currency: this.currency };
  }

  /** Diagnostics only — user-facing text goes through formatMoney. */
  toString(): string {
    return `${String(this.amountCents)} ${this.currency}`;
  }
}
