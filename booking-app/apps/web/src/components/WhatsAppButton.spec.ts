import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import { i18n } from '../i18n/index.js';

import WhatsAppButton from './WhatsAppButton.vue';

function mountButton(props: { number: string | null; reference?: string | null }) {
  return mount(WhatsAppButton, { props, global: { plugins: [i18n] } });
}

describe('WhatsAppButton', () => {
  it('builds a wa.me link with digits only and an encoded prefilled text', () => {
    const wrapper = mountButton({ number: '+49 151 123 456 78', reference: 'SF-7K3QD2' });

    // A number copied from a letterhead has spaces and a plus; wa.me needs neither, and silently
    // opens a broken chat rather than failing visibly.
    expect(wrapper.get('a').attributes('href')).toBe(
      `https://wa.me/4915112345678?text=${encodeURIComponent('Buchung SF-7K3QD2: ')}`,
    );
  });

  it('renders nothing when the business configured no number', () => {
    // A dead link to wa.me is worse than no button.
    expect(mountButton({ number: null }).find('a').exists()).toBe(false);
  });

  it('renders nothing for a number with no digits in it', () => {
    expect(mountButton({ number: '---' }).find('a').exists()).toBe(false);
  });

  it('opens in a new tab with rel=noopener and an accessible label', () => {
    const anchor = mountButton({ number: '+4915112345678' }).get('a');

    expect(anchor.attributes('target')).toBe('_blank');
    expect(anchor.attributes('rel')).toContain('noopener');
    expect(anchor.attributes('aria-label')).toBeTruthy();
  });

  it('prefills in English when the locale is English', () => {
    i18n.global.locale.value = 'en';

    try {
      const href =
        mountButton({ number: '+4915112345678', reference: 'SF-1' }).get('a').attributes('href') ??
        '';
      expect(decodeURIComponent(href)).toContain('Booking SF-1: ');
    } finally {
      i18n.global.locale.value = 'de';
    }
  });
});
