import { Money } from '../money/money.js';

import type { CancellationFeePolicy } from '../../prisma/client.js';

/**
 * What a late cancellation would retain.
 *
 * The result is a *suggestion*. Outside the free-cancellation window the
 * customer cancels themselves and is refunded in full. Inside it, an owner or
 * admin decides, and may retain any amount between zero and what was paid — both
 * the suggestion and the chosen amount are stored, so a deviation is auditable
 * rather than invisible.
 *
 * Naming note: the plan called the flag `insideFreeWindow`, but its own examples
 * set it true when the appointment is *close* — which is when cancellation is not
 * free. `feeApplies` says what is meant without needing the examples to
 * disambiguate it.
 */

export interface CancellationFeeSettings {
  freeCancellationHours: number;
  cancellationFeePolicy: CancellationFeePolicy;
  cancellationFeeAmountCents: number;
  cancellationFeePercent: number;
}

export interface CancellationFeeInput {
  /** What the customer has actually paid. Zero for an unpaid manual booking. */
  paid: Money;
  startsAt: Date;
  now: Date;
  settings: CancellationFeeSettings;
}

export interface CancellationFeeOutcome {
  /** True when the appointment is close enough that a fee may be retained. */
  feeApplies: boolean;
  hoursUntilStart: number;
  suggestedRetained: Money;
  /** Both amounts are returned so no caller has to subtract by hand. */
  suggestedRefund: Money;
}

export function computeSuggestedRetainedAmount(
  input: CancellationFeeInput,
): CancellationFeeOutcome {
  const { paid, startsAt, now, settings } = input;

  const hoursUntilStart = (startsAt.getTime() - now.getTime()) / 3_600_000;

  // The boundary favours the customer: cancelling exactly at the limit is free.
  // A customer told "free up to 72 hours before" should not be charged at
  // precisely 72 hours.
  const feeApplies = hoursUntilStart < settings.freeCancellationHours;

  const retained = feeApplies ? retainedFor(paid, settings) : Money.zero(paid.currency);

  return {
    feeApplies,
    hoursUntilStart,
    suggestedRetained: retained,
    suggestedRefund: paid.minus(retained),
  };
}

function retainedFor(paid: Money, settings: CancellationFeeSettings): Money {
  // Nothing paid means nothing to retain, whatever the policy says. Without this
  // a percentage policy on an unpaid booking would compute a fee against zero
  // and a fixed policy would suggest retaining money that was never taken.
  if (!paid.isPositive()) return Money.zero(paid.currency);

  switch (settings.cancellationFeePolicy) {
    case 'NONE':
      return Money.zero(paid.currency);

    case 'FIXED_AMOUNT':
      // Capped: a fee larger than the amount paid cannot be retained.
      return Money.fromCents(
        Math.max(0, settings.cancellationFeeAmountCents),
        paid.currency,
      ).cappedAt(paid);

    case 'PERCENTAGE':
      // Money.percent truncates, so the fractional cent stays with the customer.
      return paid.percent(settings.cancellationFeePercent);
  }
}
