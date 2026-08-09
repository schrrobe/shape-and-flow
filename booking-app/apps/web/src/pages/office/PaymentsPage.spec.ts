import { loadConnectAndInitialize } from '@stripe/connect-js';
import { flushPromises, mount } from '@vue/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../../api/client.js';
import { ApiError } from '../../api/errors.js';
import { i18n } from '../../i18n/index.js';

import PaymentsPage from './PaymentsPage.vue';

vi.mock('../../api/client.js', () => ({
  api: {
    office: {
      payments: { createAccountSession: vi.fn() },
    },
  },
}));

// `create` has to hand back a real node: the page appends whatever it returns into its
// containers, and a plain object would throw rather than fail an assertion. It also has to
// carry `setOnLoadError`, which the page uses to hear about failures Connect.js reports
// after it has already returned.
const loadErrorListeners: (() => void)[] = [];

const create = vi.fn(() =>
  Object.assign(document.createElement('div'), {
    setOnLoadError: (listener: () => void) => loadErrorListeners.push(listener),
  }),
);

vi.mock('@stripe/connect-js', () => ({
  loadConnectAndInitialize: vi.fn(() => ({ create })),
}));

const mountPage = () => mount(PaymentsPage, { global: { plugins: [i18n], stubs: ['RouterLink'] } });

const onboardingIncomplete = () =>
  new ApiError({ code: 'ORGANIZATION_ONBOARDING_INCOMPLETE', status: 422 });

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
    loadErrorListeners.length = 0;
    vi.mocked(api.office.payments.createAccountSession).mockReset();
  });

  // The API refuses the session with this code until onboarding is finished, so the page
  // reads its own gate off that refusal rather than asking a second endpoint first.
  it('points an organizer who has not finished onboarding back at that flow', async () => {
    vi.mocked(api.office.payments.createAccountSession).mockRejectedValue(onboardingIncomplete());

    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.text()).toContain('until your Stripe onboarding is finished');
    expect(loadConnectAndInitialize).not.toHaveBeenCalled();
  });

  it('initialises Connect with the key from the API and mounts both components', async () => {
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

  // Connect.js asks for a secret as soon as it is initialised. The one already fetched is
  // still unused at that point, so opening the page has to cost exactly one session — and
  // one `ORGANIZATION_ACCOUNT_SESSION_CREATED` audit row.
  it('hands Connect the secret it already fetched instead of opening a second session', async () => {
    vi.mocked(api.office.payments.createAccountSession).mockResolvedValue({
      clientSecret: 'accs_secret_1',
      publishableKey: 'pk_test_from_api',
    });

    mountPage();
    await flushPromises();

    const { fetchClientSecret } = vi.mocked(loadConnectAndInitialize).mock.calls[0]?.[0] ?? {};

    await expect(fetchClientSecret?.()).resolves.toBe('accs_secret_1');
    expect(api.office.payments.createAccountSession).toHaveBeenCalledTimes(1);
  });

  // Stripe re-invokes this whenever it needs a fresh secret. An AccountSession secret is
  // single-use, so handing back a remembered one fails the second time.
  it('fetches a new client secret every time Stripe asks again', async () => {
    vi.mocked(api.office.payments.createAccountSession)
      .mockResolvedValueOnce({ clientSecret: 'accs_secret_1', publishableKey: 'pk_test_from_api' })
      .mockResolvedValueOnce({ clientSecret: 'accs_secret_2', publishableKey: 'pk_test_from_api' })
      .mockResolvedValueOnce({ clientSecret: 'accs_secret_3', publishableKey: 'pk_test_from_api' });

    mountPage();
    await flushPromises();

    const { fetchClientSecret } = vi.mocked(loadConnectAndInitialize).mock.calls[0]?.[0] ?? {};

    await expect(fetchClientSecret?.()).resolves.toBe('accs_secret_1');
    await expect(fetchClientSecret?.()).resolves.toBe('accs_secret_2');
    await expect(fetchClientSecret?.()).resolves.toBe('accs_secret_3');

    expect(api.office.payments.createAccountSession).toHaveBeenCalledTimes(3);
  });

  it('shows the API failure instead of a blank frame when the session cannot be created', async () => {
    vi.mocked(api.office.payments.createAccountSession).mockRejectedValue(new TypeError('offline'));

    const wrapper = mountPage();
    await flushPromises();

    // A `TypeError` from `fetch` is what `officeMessage` maps to its network string.
    expect(wrapper.text()).toContain('No connection to the server');
    expect(loadConnectAndInitialize).not.toHaveBeenCalled();
  });

  // Everything after the first secret happens outside the mount, so a refusal there has no
  // other way to reach the screen.
  it('shows the failure when a later secret refresh is refused', async () => {
    vi.mocked(api.office.payments.createAccountSession)
      .mockResolvedValueOnce({ clientSecret: 'accs_secret_1', publishableKey: 'pk_test_from_api' })
      .mockRejectedValueOnce(new TypeError('offline'));

    const wrapper = mountPage();
    await flushPromises();

    const { fetchClientSecret } = vi.mocked(loadConnectAndInitialize).mock.calls[0]?.[0] ?? {};

    await expect(fetchClientSecret?.()).resolves.toBe('accs_secret_1');
    await expect(fetchClientSecret?.()).rejects.toThrow('offline');
    await flushPromises();

    expect(wrapper.text()).toContain('No connection to the server');
  });

  // A component that never loads — a blocked script, a rejected key — would otherwise
  // leave the page sitting at "ready" with two empty boxes and no explanation.
  it('shows the failure when a component reports a load error', async () => {
    vi.mocked(api.office.payments.createAccountSession).mockResolvedValue({
      clientSecret: 'accs_secret_1',
      publishableKey: 'pk_test_from_api',
    });

    const wrapper = mountPage();
    await flushPromises();

    expect(loadErrorListeners).toHaveLength(2);
    loadErrorListeners[0]?.();
    await flushPromises();

    expect(wrapper.text()).toContain('The Stripe view could not be loaded');
  });
});
