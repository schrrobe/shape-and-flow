import { defineStore } from 'pinia';
import { ref } from 'vue';

import { applyLocale, detectLocale, DEFAULT_LOCALE, LOCALE_STORAGE_KEY } from '../i18n/index.js';

import type { Locale } from '../i18n/index.js';

/**
 * The chosen language.
 *
 * A store rather than a composable because the booking payload carries the locale: what the
 * customer reads the form in is what their confirmation and reminders are written in, so the
 * value has to be readable from the submit path, not only from a component.
 */
/** Storage can throw in private mode; a missing preference is not worth failing over. */
function readStored(): string | null {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export const useLocaleStore = defineStore('locale', () => {
  const current = ref<Locale>(DEFAULT_LOCALE);

  function initialize(): void {
    set(detectLocale(window.location.search, readStored(), navigator.languages));
  }

  function set(locale: Locale): void {
    current.value = locale;
    applyLocale(locale);
  }

  return { current, initialize, set };
});
