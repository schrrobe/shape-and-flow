import { Money } from '../money/money.js';

/**
 * What a service costs for a given employee.
 *
 * There is one definition of this, used by the public quote, the Checkout line
 * item and the price snapshot written onto the booking. If the quote and the
 * charge were computed separately they could drift, and the customer would be
 * shown one number and billed another.
 */

export interface ServicePricing {
  priceCents: number;
  currency: string;
}

/** The employee-service link, which may override the price for that pairing. */
export interface EmployeeServicePricing {
  priceOverrideCents: number | null;
}

export function resolveEffectivePrice(
  service: ServicePricing,
  link: EmployeeServicePricing | null,
): Money {
  // `??` rather than `||`: zero is a legitimate override — a service a particular
  // employee performs free of charge — and `||` would silently fall back to the
  // list price.
  const cents = link?.priceOverrideCents ?? service.priceCents;
  return Money.fromCents(cents, service.currency);
}
