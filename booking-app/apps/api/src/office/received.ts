import { Money } from '../domain/money/money.js';

/**
 * What a booking has actually been paid, and what has gone back.
 *
 * One implementation, used by the list, the detail, the request queues, the customer
 * profile and the export. It existed as five copies until the `no-restricted-syntax`
 * rule banning raw cent arithmetic pointed at every one of them — which is what that
 * rule is for: the duplication was the real problem, and summing through `Money` is what
 * makes a currency mismatch a thrown error rather than a wrong total.
 */

/** Card payments that represent money the business received. */
const RECEIVED_PAYMENT_STATUSES = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/**
 * Money that has left. A `PENDING` refund has been decided but not yet moved, and
 * counting it as gone would understate what the business is holding.
 */
const SETTLED_REFUND_STATUS = 'SUCCEEDED';

export interface PaidSources {
  payments: readonly { amountCents: number; status: string }[];
  manualPayments: readonly { amountCents: number }[];
}

/**
 * Card and cash together.
 *
 * Both, because "unpaid" is a comparison against the price rather than a flag: a booking
 * half-settled at the desk and half on a card is paid, and one that counted only Stripe
 * would chase a customer who has already handed over the money.
 *
 * A negative manual payment — a correction — reduces the total, which is the whole point
 * of allowing one.
 */
export function receivedFrom(booking: PaidSources, currency: string): Money {
  const card = booking.payments
    .filter((payment) => RECEIVED_PAYMENT_STATUSES.includes(payment.status))
    .reduce<Money>(
      (total, payment) => total.plus(Money.fromCents(payment.amountCents, currency)),
      Money.zero(currency),
    );

  // The type argument is not decoration: `Money` structurally satisfies
  // `{ amountCents: number }`, so without it TypeScript picks the non-generic `reduce`
  // overload and the accumulator degrades to the element type.
  return booking.manualPayments.reduce<Money>(
    (total, payment) => total.plus(Money.fromCents(payment.amountCents, currency)),
    card,
  );
}

/** Refunds that have settled, which is the only money that has actually gone back. */
export function refundedFrom(
  booking: { refunds: readonly { amountCents: number; status: string }[] },
  currency: string,
): Money {
  return booking.refunds
    .filter((refund) => refund.status === SETTLED_REFUND_STATUS)
    .reduce<Money>(
      (total, refund) => total.plus(Money.fromCents(refund.amountCents, currency)),
      Money.zero(currency),
    );
}
