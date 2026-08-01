import { useI18n } from 'vue-i18n';

import type { MoneyDto } from '@shape-and-flow/booking-contracts';

/**
 * Cents to a formatted price.
 *
 * The one place in this app that divides by 100. Everything else passes integer cents around,
 * which is what the API sends and what the ESLint rule enforces — floating-point money is how a
 * total ends up one cent off. `Intl` takes major units, so the conversion has to happen
 * somewhere, and having it happen exactly here is the point.
 */
export function useMoney(): { money: (value: MoneyDto | number) => string } {
  const { n } = useI18n();

  function money(value: MoneyDto | number): string {
    const cents = typeof value === 'number' ? value : value.amountCents;

    return n(cents / 100, 'currency');
  }

  return { money };
}
