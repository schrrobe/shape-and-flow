import { errorCodeSchema } from '@shape-and-flow/booking-contracts';
import { describe, expect, it } from 'vitest';

import { detectLocale, DEFAULT_LOCALE, isLocale, LOCALES } from './index.js';

import de from './de.json';
import en from './en.json';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : flatten(value, `${prefix}${key}.`),
  );
}

function valueAt(tree: Tree, path: string): string {
  const value = path.split('.').reduce<string | Tree | undefined>((node, key) => {
    if (node === undefined || typeof node === 'string') return undefined;
    return node[key];
  }, tree);

  if (typeof value !== 'string') throw new Error(`${path} is not a string`);
  return value;
}

/** `{name}` style placeholders, which vue-i18n interpolates. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

const german = de as Tree;
const english = en as Tree;

describe('translations', () => {
  it('have identical key sets', () => {
    // A key in one file and not the other is a screen that silently falls back to German for
    // an English reader, which looks like a bug in the copy rather than a missing translation.
    expect(flatten(german).sort()).toEqual(flatten(english).sort());
  });

  it('have no empty value', () => {
    for (const [tree, name] of [
      [german, 'de'],
      [english, 'en'],
    ] as const) {
      for (const key of flatten(tree))
        expect(valueAt(tree, key).trim(), `${name}:${key}`).not.toBe('');
    }
  });

  it('cover every error code the api can return', () => {
    // The API's error codes are a contract. A code with no translation renders an empty
    // message exactly when something has already gone wrong.
    for (const code of errorCodeSchema.options) {
      expect(flatten(german), code).toContain(`errors.${code}`);
      expect(flatten(english), code).toContain(`errors.${code}`);
    }
  });

  it('covers the network failure the api cannot report', () => {
    // No response means no envelope and no code, and "check your internet" is a different
    // message from "something went wrong on our side".
    expect(flatten(german)).toContain('errors.NETWORK');
    expect(flatten(english)).toContain('errors.NETWORK');
  });

  it('includes the health-data warning for the customer note in both locales', () => {
    // The note is free text on a beauty-treatment booking, so somebody will type a medical
    // detail into it unless asked not to. GDPR calls that a special category.
    expect(valueAt(german, 'booking.notePrivacyHint')).toMatch(/Gesundheitsdaten/);
    expect(valueAt(english, 'booking.notePrivacyHint')).toMatch(/health/i);
  });

  it('uses the same interpolation placeholders in both locales', () => {
    // A translation that drops `{amount}` shows a sentence with a hole in it, and one that
    // invents `{sum}` shows the placeholder verbatim.
    for (const key of flatten(german)) {
      expect(placeholders(valueAt(english, key)), key).toEqual(placeholders(valueAt(german, key)));
    }
  });

  it('keeps German and English genuinely different, so nothing was copied as a stub', () => {
    const identical = flatten(german).filter(
      (key) => valueAt(german, key) === valueAt(english, key),
    );

    // A handful legitimately match — proper nouns and the like. A large overlap means somebody
    // duplicated the German file to satisfy the key-parity test.
    expect(identical.length).toBeLessThan(flatten(german).length / 10);
  });
});

describe('locale detection', () => {
  it('prefers an explicit ?lang= over everything else', () => {
    // A link in an email is an instruction, and the message that carried it was written in
    // that language.
    expect(detectLocale('?lang=en', 'de', ['de-DE'])).toBe('en');
  });

  it('then the stored choice, then the browser, then German', () => {
    expect(detectLocale('', 'en', ['de-DE'])).toBe('en');
    expect(detectLocale('', null, ['en-GB', 'de-DE'])).toBe('en');
    expect(detectLocale('', null, ['fr-FR'])).toBe(DEFAULT_LOCALE);
    expect(detectLocale('', null, [])).toBe(DEFAULT_LOCALE);
  });

  it('ignores a locale it does not support', () => {
    expect(detectLocale('?lang=klingon', null, ['de-DE'])).toBe('de');
    expect(isLocale('klingon')).toBe(false);
  });

  it('matches a regional tag by its base language', () => {
    expect(detectLocale('', null, ['en-US'])).toBe('en');
  });

  it('offers exactly the locales the notification templates support', () => {
    // The booking payload carries this value and the API renders emails in it, so a locale the
    // web app offers and the templates lack would be an untranslated confirmation.
    expect([...LOCALES]).toEqual(['de', 'en']);
  });
});
