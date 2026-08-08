import { flushPromises, mount } from '@vue/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { api } from '../../api/client.js';
import { i18n } from '../../i18n/index.js';

import OnboardingStatusPage from './OnboardingStatusPage.vue';

vi.mock('../../api/client.js', () => ({
  api: {
    office: {
      organization: {
        current: vi.fn(),
        requestOnboardingLink: vi.fn(),
      },
    },
  },
}));

describe('OnboardingStatusPage', () => {
  beforeAll(() => {
    i18n.global.locale.value = 'en';
  });

  afterAll(() => {
    i18n.global.locale.value = 'de';
  });

  it('shows a retry button while onboarding is pending, not only when it has failed', async () => {
    vi.mocked(api.office.organization.current).mockResolvedValue({ stripeChargesEnabled: false });

    const wrapper = mount(OnboardingStatusPage, { global: { plugins: [i18n] } });
    await flushPromises();

    expect(wrapper.text()).toContain('Stripe is still processing');
    expect(wrapper.find('button').exists()).toBe(true);
  });
});
