import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import { i18n } from '../../i18n/index.js';
import { useBookingDraft } from '../../stores/booking-draft.js';

import BookingLayout from './BookingLayout.vue';

import type { Router } from 'vue-router';

let router: Router;

/**
 * Flat routes, not the nested ones the app uses.
 *
 * `BookingLayout` is mounted directly, so its own `RouterView` renders whatever matched at depth
 * zero. With the real nested shape that record is the layout itself, and the test recurses.
 */
const step = { template: '<div />' };

async function mountLayout(path: string) {
  await router.replace(path);
  await router.isReady();

  return mount(BookingLayout, { global: { plugins: [i18n, router] } });
}

/** The customer has chosen a treatment and "anyone", so `slot` is where they stand. */
function pickServiceAndEmployee(): void {
  const draft = useBookingDraft();
  draft.setService('cm000000000000000service1', {
    name: 'Facial Massage 30 min',
    priceCents: 4500,
  });
  draft.setEmployee(null);
}

/**
 * `A` or `SPAN` for one step — which is the whole question here.
 *
 * Typed structurally rather than as a `VueWrapper`: the wrapper `mount` returns is generic over the
 * component and reaches typed linting as `any`, so naming the two methods this needs keeps the
 * helper honest without a cast.
 */
function tagOf(wrapper: { get: (selector: string) => { element: Element } }, name: string): string {
  return wrapper.get(`[data-test="step-${name}"]`).element.tagName;
}

beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();

  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/booking/service', name: 'booking-service', component: step },
      { path: '/booking/employee', name: 'booking-employee', component: step },
      { path: '/booking/slot', name: 'booking-slot', component: step },
      { path: '/booking/details', name: 'booking-details', component: step },
      { path: '/booking/checkout', name: 'booking-checkout', component: step },
    ],
  });
});

describe('BookingLayout step indicator', () => {
  it('links back to the steps already cleared, and not to the ones ahead', async () => {
    pickServiceAndEmployee();

    const wrapper = await mountLayout('/booking/slot');
    await flushPromises();

    expect(tagOf(wrapper, 'service')).toBe('A');
    expect(tagOf(wrapper, 'employee')).toBe('A');

    // The current step is not a link to itself, and "Ihre Daten" has no time to show yet.
    expect(tagOf(wrapper, 'slot')).toBe('SPAN');
    expect(tagOf(wrapper, 'details')).toBe('SPAN');
  });

  it('navigates when one of them is clicked', async () => {
    pickServiceAndEmployee();

    const wrapper = await mountLayout('/booking/slot');
    await flushPromises();

    await wrapper.get('[data-test="step-service"]').trigger('click');
    await flushPromises();

    expect(router.currentRoute.value.name).toBe('booking-service');
  });

  it('offers the later step once its prerequisite is there', async () => {
    pickServiceAndEmployee();
    useBookingDraft().setSlot(new Date('2026-08-17T07:00:00.000Z'));

    const wrapper = await mountLayout('/booking/slot');
    await flushPromises();

    expect(tagOf(wrapper, 'details')).toBe('A');
  });

  it('offers nothing from checkout, where a reservation is held', async () => {
    pickServiceAndEmployee();
    useBookingDraft().setSlot(new Date('2026-08-17T07:00:00.000Z'));

    const wrapper = await mountLayout('/booking/checkout');
    await flushPromises();

    // A payment page is open and a slot is reserved against it. Sending the customer back to
    // change the treatment from here strands both.
    expect(wrapper.findAll('a')).toHaveLength(0);
  });

  it('keeps only the first step offered when nothing has been chosen', async () => {
    const wrapper = await mountLayout('/booking/service');
    await flushPromises();

    expect(tagOf(wrapper, 'service')).toBe('SPAN');
    expect(tagOf(wrapper, 'employee')).toBe('SPAN');
    expect(wrapper.findAll('a')).toHaveLength(0);
  });
});
