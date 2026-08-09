import { loadConnectAndInitialize } from '@stripe/connect-js';
import { flushPromises, mount } from '@vue/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../api/client.js';
import { i18n } from '../../i18n/index.js';

import PaymentsPage from './PaymentsPage.vue';

vi.mock('../../api/client.js', () => ({
  api: {
    office: {
      organization: { current: vi.fn() },
      payments: { createAccountSession: vi.fn() },
    },
  },
}));

// `create` has to hand back a real node: the page appends whatever it returns into its
// containers, and a plain object would throw rather than fail an assertion.
const create = vi.fn(() => document.createElement('div'));

vi.mock('@stripe/connect-js', () => ({
  loadConnectAndInitialize: vi.fn(() => ({ create })),
}));

const mountPage = () => mount(PaymentsPage, { global: { plugins: [i18n], stubs: ['RouterLink'] } });

describe('PaymentsPage', () => {
  beforeAll(() => {
    i18n.global.locale.value = 'en';
  });

  afterAll(() => {
    i18n.global.locale.value = 'de';
  });

  beforeEach(() => {
    vi.mocked(loadConnectAndInitialize).mockClear();
    create.mockClear();
    vi.mocked(api.office.payments.createAccountSession).mockReset();
  });

  it('points an organizer who has not finished onboarding back at that flow', async () => {
    vi.mocked(api.office.organization.current).mockResolvedValue({ stripeChargesEnabled: false });

    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.text()).toContain('until your Stripe onboarding is finished');
    // Not merely "no components rendered": asking Stripe for a session at all would be a
    // guaranteed 422 from our own API.
    expect(api.office.payments.createAccountSession).not.toHaveBeenCalled();
    expect(loadConnectAndInitialize).not.toHaveBeenCalled();
  });

  it('initialises Connect with the key from the API and mounts both components', async () => {
    vi.mocked(api.office.organization.current).mockResolvedValue({ stripeChargesEnabled: true });
    vi.mocked(api.office.payments.createAccountSession).mockResolvedValue({
      clientSecret: 'accs_secret_1',
      publishableKey: 'pk_test_from_api',
    });

    const wrapper = mountPage();
    await flushPromises();

    expect(loadConnectAndInitialize).toHaveBeenCalledWith(
      expect.objectContaining({ publishableKey: 'pk_test_from_api' }),
    );
    expect(create).toHaveBeenCalledWith('payments');
    expect(create).toHaveBeenCalledWith('payouts');
    expect(wrapper.find('[data-test="payments-component"]').element.children).toHaveLength(1);
    expect(wrapper.find('[data-test="payouts-component"]').element.children).toHaveLength(1);
  });

  // Stripe re-invokes this whenever it needs a fresh secret. An AccountSession secret is
  // single-use, so handing back a remembered one fails the second time.
  it('fetches a new client secret every time Stripe asks', async () => {
    vi.mocked(api.office.organization.current).mockResolvedValue({ stripeChargesEnabled: true });
    vi.mocked(api.office.payments.createAccountSession).mockResolvedValue({
      clientSecret: 'accs_secret_1',
      publishableKey: 'pk_test_from_api',
    });

    mountPage();
    await flushPromises();

    const { fetchClientSecret } = vi.mocked(loadConnectAndInitialize).mock.calls[0]?.[0] ?? {};
    const before = vi.mocked(api.office.payments.createAccountSession).mock.calls.length;

    await expect(fetchClientSecret?.()).resolves.toBe('accs_secret_1');
    await expect(fetchClientSecret?.()).resolves.toBe('accs_secret_1');

    expect(api.office.payments.createAccountSession).toHaveBeenCalledTimes(before + 2);
  });

  it('shows the API failure instead of a blank frame when the session cannot be created', async () => {
    vi.mocked(api.office.organization.current).mockResolvedValue({ stripeChargesEnabled: true });
    vi.mocked(api.office.payments.createAccountSession).mockRejectedValue(new TypeError('offline'));

    const wrapper = mountPage();
    await flushPromises();

    // A `TypeError` from `fetch` is what `officeMessage` maps to its network string.
    expect(wrapper.text()).toContain('No connection to the server');
    expect(loadConnectAndInitialize).not.toHaveBeenCalled();
  });
});
