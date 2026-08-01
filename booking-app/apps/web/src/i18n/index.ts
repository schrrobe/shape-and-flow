import { createI18n } from 'vue-i18n';

import de from './de.json';
import en from './en.json';

export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'de';

/** Where a chosen locale is remembered between visits. */
export const LOCALE_STORAGE_KEY = 'sf.locale';

/**
 * The business's timezone, not the reader's.
 *
 * A customer is coming to a physical address, so the only useful reading of "09:00" is the
 * clock on the wall there. Someone booking from another timezone must not be shown their own.
 */
export const DISPLAY_ZONE = 'Europe/Berlin';

const TAGS: Record<Locale, string> = { de: 'de-DE', en: 'en-GB' };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Pick the locale to start in.
 *
 * `?lang=` first, because a link in an email is an explicit instruction and the notification
 * that carried it was written in that language. Then the stored choice, then what the browser
 * asks for, then German.
 */
export function detectLocale(
  search: string,
  stored: string | null,
  languages: readonly string[],
): Locale {
  const requested = new URLSearchParams(search).get('lang');
  if (isLocale(requested)) return requested;

  if (isLocale(stored)) return stored;

  for (const language of languages) {
    const base = language.split('-')[0];
    if (isLocale(base)) return base;
  }

  return DEFAULT_LOCALE;
}

const dateTimeFormats = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    {
      date: { timeZone: DISPLAY_ZONE, day: '2-digit', month: '2-digit', year: 'numeric' },
      time: { timeZone: DISPLAY_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
      weekdayLong: { timeZone: DISPLAY_ZONE, weekday: 'long' },
      dayMonth: { timeZone: DISPLAY_ZONE, weekday: 'short', day: '2-digit', month: '2-digit' },
      full: {
        timeZone: DISPLAY_ZONE,
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      },
    },
  ]),
);

const numberFormats = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    { currency: { style: 'currency', currency: 'EUR', currencyDisplay: 'symbol' } },
  ]),
);

/**
 * Composition mode, no legacy API, and German as the fallback.
 *
 * `fallbackLocale: 'de'` rather than English: German is the language the copy is authored in,
 * so a key that exists only in one file exists in that one. `missingWarn` stays on in
 * development because a silent fallback is how a half-translated screen ships.
 */
export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages: { de, en },
  datetimeFormats: dateTimeFormats,
  numberFormats,
  missingWarn: import.meta.env.DEV,
  fallbackWarn: import.meta.env.DEV,
});

/** Apply a locale everywhere it is visible: the app, the document, and the next visit. */
export function applyLocale(locale: Locale): void {
  i18n.global.locale.value = locale;

  // `lang` drives screen-reader pronunciation and the browser's own hyphenation. Forgetting it
  // makes German copy read aloud with English phonetics.
  document.documentElement.lang = locale;

  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Private mode, or storage disabled. Losing the preference is not worth failing over.
  }
}

export function localeTag(locale: Locale): string {
  return TAGS[locale];
}
