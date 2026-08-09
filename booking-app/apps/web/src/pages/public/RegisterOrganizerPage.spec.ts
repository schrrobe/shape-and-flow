import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { api } from '../../api/client.js';
import { ApiError } from '../../api/errors.js';
import { i18n } from '../../i18n/index.js';

import RegisterOrganizerPage from './RegisterOrganizerPage.vue';

import type { Router } from 'vue-router';

vi.mock('../../api/client.js', () => ({
  api: { public: { registerOrganization: vi.fn() } },
}));

// A real router, not a mocked `$router`: the component calls `useRouter()`, which reads
// the injected instance rather than a stubbed prop, so a mock on `$router` would not
// satisfy it and the page would throw instead of navigating.
let router: Router;

function mountPage() {
  return mount(RegisterOrganizerPage, { global: { plugins: [i18n, router] } });
}

async function fillAndSubmit(wrapper: ReturnType<typeof mountPage>): Promise<void> {
  await wrapper.find('[data-test="entity-type"]').setValue('INDIVIDUAL');
  await wrapper.find('[data-test="display-name"]').setValue('Acme Studio');
  await wrapper.find('[data-test="email"]').setValue('owner@example.com');
  await wrapper.find('[data-test="password"]').setValue('Correct-Horse-Battery-9');
  await wrapper.find('[data-test="first-name"]').setValue('Jane');
  await wrapper.find('[data-test="last-name"]').setValue('Doe');
  await wrapper.find('form').trigger('submit');
  await flushPromises();
}

beforeEach(() => {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/organizer/registrieren', name: 'register-organizer', component: {} },
      { path: '/office/onboarding-status', name: 'onboarding-status', component: {} },
    ],
  });
  vi.spyOn(router, 'push');
});

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

    const wrapper = mountPage();
    await fillAndSubmit(wrapper);

    expect(window.location.href).toBe('https://connect.stripe.com/x');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting on the spy, not calling it
    expect(router.push).not.toHaveBeenCalled();
    // @ts-expect-error -- test-only restore, undoing the stub above
    window.location = originalLocation;
  });

  it('sends the owner to the onboarding-status page when Stripe failed but the account exists', async () => {
    // The organization and owner are already created, and the owner is already logged in
    // via the Set-Cookie on this same response — a null link means only the Stripe call
    // failed, not the registration. Nothing to redirect to, so the recovery page is next.
    vi.mocked(api.public.registerOrganization).mockResolvedValue({
      id: 'org_1',
      slug: 'acme-studio',
      onboardingLink: null,
    });

    const wrapper = mountPage();
    await fillAndSubmit(wrapper);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting on the spy, not calling it
    expect(router.push).toHaveBeenCalledWith({ name: 'onboarding-status' });
  });

  it('shows a translated message when registration fails', async () => {
    vi.mocked(api.public.registerOrganization).mockRejectedValue(
      new ApiError({ code: 'ORGANIZATION_CREATE_ERROR', status: 422 }),
    );

    const wrapper = mountPage();
    await fillAndSubmit(wrapper);

    // German is the app's default/fallback locale, which is what an unconfigured `i18n`
    // instance renders in a test that never changes it.
    expect(wrapper.text()).toContain(
      'Ihr Konto konnte nicht angelegt werden. Bitte überprüfen Sie Ihre Angaben und versuchen Sie es erneut.',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting on the spy, not calling it
    expect(router.push).not.toHaveBeenCalled();
  });
});
