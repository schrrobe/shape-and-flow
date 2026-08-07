import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { api } from '../../api/client.js';
import { i18n } from '../../i18n/index.js';

import RegisterOrganizerPage from './RegisterOrganizerPage.vue';

vi.mock('../../api/client.js', () => ({
  api: { public: { registerOrganization: vi.fn() } },
}));

describe('RegisterOrganizerPage', () => {
  it('redirects to the onboarding link on successful submit', async () => {
    vi.mocked(api.public.registerOrganization).mockResolvedValue({
      id: 'org_1',
      slug: 'acme-studio',
      onboardingLink: 'https://connect.stripe.com/x',
    });

    const originalLocation = window.location;
    // @ts-expect-error -- test-only reassignment to observe the redirect
    delete window.location;
    // @ts-expect-error -- test-only stub
    window.location = { href: '' };

    const wrapper = mount(RegisterOrganizerPage, { global: { plugins: [i18n] } });
    await wrapper.find('[data-test="entity-type"]').setValue('INDIVIDUAL');
    await wrapper.find('[data-test="display-name"]').setValue('Acme Studio');
    await wrapper.find('[data-test="email"]').setValue('owner@example.com');
    await wrapper.find('[data-test="password"]').setValue('Correct-Horse-Battery-9');
    await wrapper.find('[data-test="first-name"]').setValue('Jane');
    await wrapper.find('[data-test="last-name"]').setValue('Doe');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(window.location.href).toBe('https://connect.stripe.com/x');
    // @ts-expect-error -- test-only restore, undoing the stub above
    window.location = originalLocation;
  });
});
