import type { Locale } from '@shape-and-flow/booking-contracts';

/**
 * The business's timezone.
 *
 * Hard-coded rather than passed in, deliberately: an appointment time in a customer's
 * own zone would be actively misleading. They are coming to a physical address, and the
 * only useful reading of "09:00" is the clock on the wall there.
 */
export const DISPLAY_ZONE = 'Europe/Berlin';

const LOCALE_TAGS: Record<Locale, string> = { de: 'de-DE', en: 'en-GB' };

/**
 * Money, formatted the way the locale expects.
 *
 * Built from integer cents through `Intl`, never by assembling a string: `45,00 €` and
 * `€45.00` differ in separator, position and spacing, and a template that concatenates
 * them gets one of the two wrong.
 */
export function formatMoneyCents(amountCents: number, currency: string, locale: Locale): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale], {
    style: 'currency',
    currency,
    // The one legitimate cents division in the codebase. `Intl` takes major units, and
    // this package cannot import the Money value object: it is browser-importable and
    // depends only on contracts. Disabled here rather than exempting the whole package,
    // because `no-restricted-syntax` is a single rule — exempting a file would also drop
    // the wall-clock ban for it.
    // eslint-disable-next-line no-restricted-syntax -- see above
  }).format(amountCents / 100);
}

/** `14.08.2026` in German, `14/08/2026` in English. */
export function formatDate(instant: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: DISPLAY_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(instant);
}

/** `09:00`. 24-hour in both locales, because that is what a German business writes. */
export function formatTime(instant: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: DISPLAY_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

/** The weekday name, so a customer can sanity-check the date without a calendar. */
export function formatWeekday(instant: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: DISPLAY_ZONE,
    weekday: 'long',
  }).format(instant);
}

/** `Freitag, 14.08.2026, 09:00`. */
export function formatDateTime(instant: Date, locale: Locale): string {
  return `${formatWeekday(instant, locale)}, ${formatDate(instant, locale)}, ${formatTime(instant, locale)}`;
}

/** `09:00–09:30`, using an en dash because that is what a range takes. */
export function formatTimeRange(startsAt: Date, endsAt: Date, locale: Locale): string {
  return `${formatTime(startsAt, locale)}–${formatTime(endsAt, locale)}`;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape a value before it reaches an HTML body.
 *
 * Every interpolation into HTML goes through this. Some of these values are typed by a
 * customer — a name, a note — and an email client that renders HTML is as capable of
 * running injected markup as a browser is. `&` is replaced first, otherwise the
 * replacements would escape each other's output.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}
