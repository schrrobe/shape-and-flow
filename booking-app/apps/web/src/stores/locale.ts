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
export const useLocaleStore = defineStore('locale', () => {
  const current = ref<Locale>(DEFAULT_LOCALE);

  function initialize(): void {
    let stored: string | null = null;

    try {
      stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    } catch {
      stored = null;
    }

    set(detectLocale(window.location.search, stored, navigator.languages));
  }

  function set(locale: Locale): void {
    current.value = locale;
    applyLocale(locale);
  }

  return { current, initialize, set };
});
