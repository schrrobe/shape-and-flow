import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import LocaleSwitch from '../components/LocaleSwitch.vue';
import { i18n, LOCALE_STORAGE_KEY } from '../i18n/index.js';

import { useLocaleStore } from './locale.js';

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  document.documentElement.lang = '';
});

describe('the locale store', () => {
  it('starts in German', () => {
    expect(useLocaleStore().current).toBe('de');
  });

  it('sets the document language, which drives screen-reader pronunciation', () => {
    useLocaleStore().set('en');

    // Without this, German copy is read aloud with English phonetics.
    expect(document.documentElement.lang).toBe('en');
  });

  it('remembers the choice for the next visit', () => {
    useLocaleStore().set('en');

    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('switches the messages the ui renders', () => {
    const store = useLocaleStore();

    store.set('en');
    expect(i18n.global.t('common.next')).toBe('Next');

    store.set('de');
    expect(i18n.global.t('common.next')).toBe('Weiter');
  });

  it('picks up a stored choice on initialize', () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, 'en');

    const store = useLocaleStore();
    store.initialize();

    expect(store.current).toBe('en');
  });
});

describe('the locale switch', () => {
  it('marks the active language and switches on click', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);

    const wrapper = mount(LocaleSwitch, { global: { plugins: [pinia, i18n] } });
    const buttons = wrapper.findAll('button');

    expect(buttons[0]?.attributes('aria-current')).toBe('true');

    await buttons[1]?.trigger('click');
    expect(useLocaleStore().current).toBe('en');
    expect(wrapper.findAll('button')[1]?.attributes('aria-current')).toBe('true');
  });

  it('labels each option with a language name, not a flag', () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useLocaleStore().set('de');

    const wrapper = mount(LocaleSwitch, { global: { plugins: [pinia, i18n] } });

    // A flag is a country. Austria and Germany share a language and not a flag.
    expect(wrapper.text()).toContain('Deutsch');
    expect(wrapper.findAll('button')[1]?.attributes('lang')).toBe('en');
  });

  it('is a labelled group, so the two buttons are announced as one control', () => {
    const pinia = createPinia();
    setActivePinia(pinia);

    const wrapper = mount(LocaleSwitch, { global: { plugins: [pinia, i18n] } });

    expect(wrapper.attributes('role')).toBe('group');
    expect(wrapper.attributes('aria-label')).toBeTruthy();
  });
});
