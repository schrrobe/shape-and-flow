import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it } from 'vitest';

import App from './App.vue';
import { i18n } from './i18n/index.js';
import { router } from './router/index.js';

describe('the application shell', () => {
  it('starts with a skip link that only appears on focus', async () => {
    await router.push('/');
    await router.isReady();

    const wrapper = mount(App, { global: { plugins: [router, i18n, createPinia()] } });
    const skip = wrapper.get('a[href="#main"]');

    // Visually hidden until focused, and first in the DOM — otherwise a keyboard user tabs
    // through the header again on every navigation.
    expect(skip.classes()).toContain('sr-only');
    expect(wrapper.html().indexOf('#main')).toBeLessThan(wrapper.html().indexOf('<header'));
  });

  it('points the skip link at the main landmark that exists', async () => {
    await router.push('/');
    await router.isReady();

    const wrapper = mount(App, { global: { plugins: [router, i18n, createPinia()] } });

    expect(wrapper.get('main').attributes('id')).toBe('main');
  });
});
