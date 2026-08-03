import type { Money } from './money.js';
import type { Locale } from '../../prisma/client.js';

/**
 * Locale-aware money formatting for customer-facing text.
 *
 * Formatters are memoised at module scope because constructing an
 * Intl.NumberFormat is expensive relative to using one, and notification
 * rendering formats many amounts in a loop.
 *
 * German is `de-DE` (45,00 €) and English is `en-IE` (€45.00) rather than
 * `en-US`: the business charges euros, and en-IE is the English locale that
 * formats euros natively instead of rendering them as a foreign currency.
 */

const BCP47: Record<Locale, string> = { de: 'de-DE', en: 'en-IE' };

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(locale: Locale, currency: string): Intl.NumberFormat {
  const key = `${locale}:${currency}`;
  const existing = formatters.get(key);
  if (existing) return existing;

  const created = new Intl.NumberFormat(BCP47[locale], {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  formatters.set(key, created);
  return created;
}

/**
 * Format an amount for display.
 *
 * Note that Intl separates the number from the currency symbol with a
 * non-breaking space (U+00A0), which is correct typography — callers comparing
 * against a literal need to account for it.
 */
export function formatMoney(money: Money, locale: Locale): string {
  return formatterFor(locale, money.currency).format(money.amountCents / 100);
}
