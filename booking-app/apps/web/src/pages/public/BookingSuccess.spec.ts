import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { i18n } from '../../i18n/index.js';
import { DRAFT_STORAGE_KEY, useBookingDraft } from '../../stores/booking-draft.js';

import BookingSuccess from './BookingSuccess.vue';

import type { Router } from 'vue-router';

const ORGANIZATION = {
  whatsappNumber: '+4915112345678',
  freeCancellationHours: 72,
};

function bySession(status: string) {
  return {
    reference: 'SF-DCYPFZ',
    status,
    startsAt: '2026-08-17T07:00:00.000Z',
    endsAt: '2026-08-17T07:30:00.000Z',
    employeeDisplayName: 'Mara Vogt',
    serviceName: 'Facial Massage 30 min',
    price: { amountCents: 4500, currency: 'EUR' },
    managementUrlIssued: true,
  };
}

/** Queued so the page's polling can be watched call by call. */
let sessionResponses: string[] = [];
let sessionCalls = 0;

let router: Router;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function mountPage(query = '?session_id=cs_test_1') {
  await router.replace(`/booking/success${query}`);
  await router.isReady();

  return mount(BookingSuccess, {
    global: { plugins: [i18n, createPinia(), router], stubs: { RouterLink: true } },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  vi.useFakeTimers();

  sessionResponses = [];
  sessionCalls = 0;

  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- an SFC is `any` to typed linting
      { path: '/booking/success', name: 'booking-success', component: BookingSuccess },
      { path: '/booking/service', name: 'booking-service', component: { template: '<div />' } },
    ],
  });

  vi.stubGlobal('fetch', (url: string) => {
    if (url.includes('/organizations/current')) return Promise.resolve(json(ORGANIZATION));

    if (url.includes('/bookings/by-session/')) {
      const status = sessionResponses[sessionCalls] ?? 'PENDING_PAYMENT';
      sessionCalls += 1;
      return Promise.resolve(json(bySession(status)));
    }

    throw new Error(`unexpected request: ${url}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BookingSuccess', () => {
  it('shows the reference and the appointment once confirmed', async () => {
    sessionResponses = ['CONFIRMED'];

    const wrapper = await mountPage();
    await flushPromises();

    expect(wrapper.text()).toContain('SF-DCYPFZ');
    expect(wrapper.text()).toContain('Mara Vogt');
    expect(wrapper.text()).toContain('Termin bestätigt');
  });

  it('names the address the confirmation went to, after clearing the draft', async () => {
    // `draft.reset()` runs on mount, and the template read `draft.email` — so the one
    // sentence that tells the customer where to look for their confirmation rendered
    // with an empty address.
    sessionResponses = ['CONFIRMED'];
    useBookingDraft().email = 'anna@example.com';

    const wrapper = await mountPage();
    await flushPromises();

    expect(wrapper.text()).toContain('anna@example.com');
    expect(useBookingDraft().email).toBe('');
    expect(sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull();
  });

  it('stops polling as soon as it is confirmed', async () => {
    sessionResponses = ['CONFIRMED'];

    await mountPage();
    await flushPromises();

    await vi.advanceTimersByTimeAsync(20_000);

    // One call, not six. Continuing to poll a settled booking is load for nothing.
    expect(sessionCalls).toBe(1);
  });

  it('shows a waiting state while the payment is still pending', async () => {
    sessionResponses = ['PENDING_PAYMENT'];

    const wrapper = await mountPage();
    await flushPromises();

    // The browser is racing a Stripe webhook it cannot see.
    expect(wrapper.text()).toContain('Zahlung wird bestätigt');
    expect(wrapper.text()).not.toContain('Termin bestätigt');
  });

  it('keeps polling with widening gaps until it confirms', async () => {
    sessionResponses = ['PENDING_PAYMENT', 'PENDING_PAYMENT', 'CONFIRMED'];

    const wrapper = await mountPage();
    await flushPromises();
    expect(sessionCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sessionCalls).toBe(2);

    // The second gap is longer than the first: a fixed interval would hammer the API for the
    // rare slow case.
    await vi.advanceTimersByTimeAsync(1000);
    expect(sessionCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sessionCalls).toBe(3);

    await flushPromises();
    expect(wrapper.text()).toContain('Termin bestätigt');
  });

  it('never claims failure when it gives up', async () => {
    sessionResponses = Array.from({ length: 10 }, () => 'PENDING_PAYMENT');

    const wrapper = await mountPage();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(40_000);
    await flushPromises();

    // Telling a customer their payment failed when it merely has not been confirmed yet sends
    // them to pay a second time.
    expect(wrapper.text()).toContain('Zahlung wird noch geprüft');
    expect(wrapper.text()).not.toMatch(/fehlgeschlagen|failed/i);
  });

  it('gives up after roughly thirty seconds rather than forever', async () => {
    sessionResponses = Array.from({ length: 20 }, () => 'PENDING_PAYMENT');

    await mountPage();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);

    // Six attempts spanning ~30s. An unbounded poll is a tab that spins all afternoon.
    expect(sessionCalls).toBe(7);
  });

  it('offers the WhatsApp link with the reference', async () => {
    sessionResponses = ['CONFIRMED'];

    const wrapper = await mountPage();
    await flushPromises();

    const href = wrapper.get('a[href^="https://wa.me"]').attributes('href') ?? '';
    expect(href).toContain('4915112345678');
    expect(decodeURIComponent(href)).toContain('SF-DCYPFZ');
  });

  it('says nothing alarming when opened without a session id', async () => {
    const wrapper = await mountPage('');
    await flushPromises();

    // Somebody navigated here directly. There is nothing to resolve and nothing wrong.
    expect(sessionCalls).toBe(0);
    expect(wrapper.text()).toContain('Zahlung wird noch geprüft');
  });

  it('does not show the management link, because that is a credential', async () => {
    sessionResponses = ['CONFIRMED'];

    const wrapper = await mountPage();
    await flushPromises();

    // This page is reachable by anyone holding a session id; the token travels by email.
    expect(wrapper.html()).not.toContain('/manage#');
  });
});
