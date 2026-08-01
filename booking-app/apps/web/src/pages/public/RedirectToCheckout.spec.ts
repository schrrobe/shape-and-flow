import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { i18n } from '../../i18n/index.js';
import { useBookingDraft } from '../../stores/booking-draft.js';

import RedirectToCheckout from './RedirectToCheckout.vue';

import type { CreateBookingResponse } from '@shape-and-flow/booking-contracts';
import type { Router } from 'vue-router';

const NOW = new Date('2026-08-14T06:00:00.000Z');

const reservation = (expiresAt = '2026-08-14T06:05:00.000Z'): CreateBookingResponse => ({
  bookingId: 'cms9gryv30000ja32145w5gke',
  reference: 'SF-DCYPFZ',
  status: 'PENDING_PAYMENT',
  employeeId: 'cms9gryv30000ja32145w5gkf',
  employeeDisplayName: 'Mara Vogt',
  startsAt: '2026-08-17T07:00:00.000Z',
  endsAt: '2026-08-17T07:30:00.000Z',
  price: { amountCents: 4500, currency: 'EUR' },
  expiresAt,
  checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_1',
});

const assign = vi.fn();

/**
 * A real router, not a mocked `$router`.
 *
 * The component calls `useRouter()`, and a mock on `$router` does not satisfy the composable —
 * it reads from the injected instance, so the mocked page threw instead of redirecting.
 */
let router: Router;

function mountPage() {
  return mount(RedirectToCheckout, {
    global: { plugins: [i18n, router], stubs: { RouterLink: true } },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);

  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- an SFC is `any` to typed linting
      { path: '/booking/checkout', name: 'booking-checkout', component: RedirectToCheckout },
      { path: '/booking/service', name: 'booking-service', component: { template: '<div />' } },
      { path: '/booking/slot', name: 'booking-slot', component: { template: '<div />' } },
    ],
  });
  vi.spyOn(router, 'replace');

  assign.mockClear();

  // `location.assign` cannot be called for real in a test environment, and the point is *whether*
  // it is called and when. Built rather than spread from the real `Location`: spreading an instance
  // drops its prototype, and listing the two fields the page uses is clearer about the contract.
  vi.stubGlobal('location', { origin: 'http://localhost:5173', assign });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RedirectToCheckout', () => {
  it('shows the resolved employee, the price and the reference before leaving', () => {
    useBookingDraft().setReservation(reservation());

    const wrapper = mountPage();

    // "Anyone" became a person, and the customer should know who — and what it costs — before a
    // payment page takes over.
    expect(wrapper.text()).toContain('Mara Vogt');
    expect(wrapper.text()).toContain('45,00');
    expect(wrapper.text()).toContain('SF-DCYPFZ');
  });

  it('waits before redirecting, so the deadline is read rather than discovered', async () => {
    useBookingDraft().setReservation(reservation());
    mountPage();

    vi.advanceTimersByTime(500);
    expect(assign).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    await flushPromises();

    expect(assign).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1');
  });

  it('offers a manual link, in case the redirect is blocked', () => {
    useBookingDraft().setReservation(reservation());

    const wrapper = mountPage();

    // An extension, a blocked assign or a slow tab must not leave the customer stranded with a
    // live reservation and no way to pay.
    expect(wrapper.get('a').attributes('href')).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
  });

  it('does not redirect once the reservation has lapsed', async () => {
    useBookingDraft().setReservation(reservation('2026-08-14T06:00:00.000Z'));
    const wrapper = mountPage();

    await flushPromises();
    vi.advanceTimersByTime(3000);
    await flushPromises();

    // Sending somebody to a Checkout session for a slot that has been released would take a
    // payment for an appointment they no longer have.
    expect(assign).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('abgelaufen');
  });

  it('sends a reload back to the start, because the checkout url is never persisted', async () => {
    // No reservation in memory: this URL was never meant to be bookmarkable.
    mountPage();
    await flushPromises();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- asserting on the spy, not calling it
    expect(router.replace).toHaveBeenCalledWith({ name: 'booking-service' });
    expect(assign).not.toHaveBeenCalled();
  });
});
