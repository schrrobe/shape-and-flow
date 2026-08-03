import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { i18n } from '../../i18n/index.js';

import ManageBooking from './ManageBooking.vue';

import type { Router } from 'vue-router';

const TOKEN = 'tok_abc123';

/**
 * A manage response, with the policy merged rather than replaced.
 *
 * The obvious `...overrides` last would overwrite the whole `cancellationPolicy` with a partial one,
 * silently dropping `cancellable` — which made the fee-window test assert against a page that was
 * rendering "cannot be cancelled" for the wrong reason.
 */
function manageBooking(
  overrides: Record<string, unknown> = {},
  policy: Record<string, unknown> = {},
) {
  return {
    reference: 'SF-DCYPFZ',
    status: 'CONFIRMED',
    displayStatus: 'CONFIRMED',
    startsAt: '2026-08-17T07:00:00.000Z',
    endsAt: '2026-08-17T07:30:00.000Z',
    timezone: 'Europe/Berlin',
    serviceName: 'Facial Massage 30 min',
    durationMinutes: 30,
    employeeDisplayName: 'Mara Vogt',
    price: { amountCents: 4500, currency: 'EUR' },
    paid: { amountCents: 4500, currency: 'EUR' },
    refunded: { amountCents: 0, currency: 'EUR' },
    customerNote: null,
    ...overrides,
    cancellationPolicy: {
      feePolicy: 'PERCENTAGE',
      freeUntil: '2026-08-14T07:00:00.000Z',
      feeApplies: false,
      suggestedRetained: { amountCents: 0, currency: 'EUR' },
      suggestedRefund: { amountCents: 4500, currency: 'EUR' },
      cancellable: true,
      ...policy,
    },
  };
}

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

let calls: Recorded[] = [];
let bookingResponse: () => Response;
let cancelResponse: () => Response;
let router: Router;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function mountPage(fragment = `#${TOKEN}`) {
  history.replaceState(null, '', `/manage${fragment}`);
  await router.replace('/manage');
  await router.isReady();

  return mount(ManageBooking, {
    global: { plugins: [i18n, createPinia(), router], stubs: { RouterLink: true } },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  calls = [];

  bookingResponse = () => json(manageBooking());
  cancelResponse = () =>
    json({
      outcome: 'CANCELED',
      refundExpected: { amountCents: 4500, currency: 'EUR' },
      suggestedRetained: null,
    });

  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- an SFC is `any` to typed linting
      { path: '/manage', name: 'manage', component: ManageBooking },
      {
        path: '/manage/reschedule',
        name: 'manage-reschedule',
        component: { template: '<div />' },
      },
    ],
  });

  vi.stubGlobal('fetch', (url: string, init: RequestInit | undefined) => {
    calls.push({ url, init });

    if (url.includes('/organizations/current')) {
      return Promise.resolve(json({ whatsappNumber: '+4915112345678' }));
    }
    if (url.includes('/manage/cancel')) return Promise.resolve(cancelResponse());
    if (url.includes('/manage/booking')) return Promise.resolve(bookingResponse());

    throw new Error(`unexpected request: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

describe('ManageBooking', () => {
  it('loads the booking with the token from the fragment', async () => {
    const wrapper = await mountPage();
    await flushPromises();

    const bookingCall = calls.find((call) => call.url.includes('/manage/booking'));
    expect((bookingCall?.init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(wrapper.text()).toContain('SF-DCYPFZ');
    expect(wrapper.text()).toContain('Mara Vogt');
  });

  it('makes no request at all without a token', async () => {
    const wrapper = await mountPage('');
    await flushPromises();

    // A 401 would say nothing more than "your link is incomplete" already does.
    expect(calls).toHaveLength(0);
    expect(wrapper.text()).toContain('Link unvollständig');
  });

  it('renders the expired-link page for a 401, not a raw error', async () => {
    bookingResponse = () =>
      json({ code: 'UNAUTHENTICATED', message: 'x', correlationId: 'c' }, 401);

    const wrapper = await mountPage();
    await flushPromises();

    // Opening an old email is the normal way to meet a token's lifetime.
    expect(wrapper.text()).toContain('Link unvollständig');
  });

  it('states the refund before the confirm button, not after', async () => {
    const wrapper = await mountPage();
    await flushPromises();

    // Somebody about to give up money should not have to press anything to find out how much.
    expect(wrapper.text()).toContain('45,00');
    expect(wrapper.text()).toContain('kostenfrei');
  });

  it('states what is retained when the fee window applies', async () => {
    bookingResponse = () =>
      json(
        manageBooking(
          {},
          {
            feeApplies: true,
            suggestedRetained: { amountCents: 2250, currency: 'EUR' },
            suggestedRefund: { amountCents: 2250, currency: 'EUR' },
          },
        ),
      );

    const wrapper = await mountPage();
    await flushPromises();

    expect(wrapper.text()).toContain('22,50');
    // And that the office decides, because inside the window it is a request.
    expect(wrapper.text()).toContain('entscheidet das Studio');
  });

  it('does not say it keeps nothing, when it keeps nothing', async () => {
    bookingResponse = () =>
      json(
        manageBooking(
          {},
          { feeApplies: true, suggestedRetained: { amountCents: 0, currency: 'EUR' } },
        ),
      );

    const wrapper = await mountPage();
    await flushPromises();

    // A business can be inside its fee window and still keep nothing. "We keep 0,00 €" is a
    // sentence that makes a customer read it three times.
    expect(wrapper.text()).not.toContain('behalten wir 0,00');
    expect(wrapper.text()).toContain('kostenfrei');
    // The office still decides, and that has to stay visible.
    expect(wrapper.text()).toContain('entscheidet das Studio');
  });

  it('restates the consequence inside the confirmation dialog', async () => {
    const wrapper = await mountPage();
    await flushPromises();

    await wrapper.get('button').trigger('click');
    await flushPromises();

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('45,00');

    wrapper.unmount();
  });

  it('shows the immediate outcome distinctly from a request', async () => {
    const wrapper = await mountPage();
    await flushPromises();

    await wrapper.get('button').trigger('click');
    await flushPromises();

    const confirm = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Termin stornieren'),
    );
    confirm?.click();
    await flushPromises();

    expect(wrapper.text()).toContain('Termin storniert');
    expect(wrapper.text()).not.toContain('Anfrage eingegangen');

    wrapper.unmount();
  });

  it('shows the requested outcome when the office has to decide', async () => {
    cancelResponse = () =>
      json({
        outcome: 'REQUESTED',
        refundExpected: null,
        suggestedRetained: { amountCents: 2250, currency: 'EUR' },
      });

    const wrapper = await mountPage();
    await flushPromises();

    await wrapper.get('button').trigger('click');
    await flushPromises();

    const confirm = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Termin stornieren'),
    );
    confirm?.click();
    await flushPromises();

    // One message for both outcomes would leave the customer unsure whether the appointment is
    // actually gone.
    expect(wrapper.text()).toContain('Anfrage eingegangen');
    expect(wrapper.text()).not.toContain('Termin storniert');

    wrapper.unmount();
  });

  it('re-reads the booking after cancelling rather than guessing the status', async () => {
    const wrapper = await mountPage();
    await flushPromises();
    const before = calls.filter((call) => call.url.includes('/manage/booking')).length;

    await wrapper.get('button').trigger('click');
    await flushPromises();

    const confirm = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Termin stornieren'),
    );
    confirm?.click();
    await flushPromises();

    // The server decides the status and the refund; a guessed status is a lie on a page about
    // money.
    expect(calls.filter((call) => call.url.includes('/manage/booking')).length).toBe(before + 1);

    wrapper.unmount();
  });

  it('says nothing can be cancelled once the appointment has started', async () => {
    bookingResponse = () => json(manageBooking({}, { cancellable: false }));

    const wrapper = await mountPage();
    await flushPromises();

    expect(wrapper.text()).toContain('kann nicht mehr storniert');
  });

  it('keeps the token out of every request url', async () => {
    await mountPage();
    await flushPromises();

    for (const call of calls) expect(call.url).not.toContain(TOKEN);
  });
});
