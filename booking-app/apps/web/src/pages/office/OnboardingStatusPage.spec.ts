import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { api } from '../../api/client.js';

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
  it('shows a retry button while onboarding is pending, not only when it has failed', async () => {
    vi.mocked(api.office.organization.current).mockResolvedValue({ stripeChargesEnabled: false });

    const wrapper = mount(OnboardingStatusPage);
    await flushPromises();

    expect(wrapper.text()).toContain('Stripe is still processing');
    expect(wrapper.find('button').exists()).toBe(true);
  });
});
