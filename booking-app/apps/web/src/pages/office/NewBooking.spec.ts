import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { router } from '../../router/index.js';
import { useSession } from '../../stores/session.js';

import NewBooking from './NewBooking.vue';

import type { OfficeUserDto } from '@shape-and-flow/booking-contracts';
import type { Pinia } from 'pinia';

enableAutoUnmount(afterEach);

const OWNER: OfficeUserDto = {
  id: 'u1',
  email: 'ola@shapeandflow.test',
  firstName: 'Ola',
  lastName: 'Winter',
  role: 'OWNER',
  canIssueRefunds: true,
  employeeId: null,
};

/** 09:00 and 09:15 Berlin on the same day, both free, with different people free at each. */
const NINE = '2026-08-14T07:00:00.000Z';
const QUARTER_PAST = '2026-08-14T07:15:00.000Z';
const SERVICE_ID = 'cms9gryv30000ja32145w5gke';
const OFFLINE_SERVICE_ID = 'cms9gryv30001ja32145w5gke';
const EMPLOYEE_ONE_ID = 'cms9gryv30002ja32145w5gke';
const EMPLOYEE_TWO_ID = 'cms9gryv30003ja32145w5gke';
const CUSTOMER_ID = 'cms9gryv30004ja32145w5gke';
const BOOKING_ID = 'cms9gryv30005ja32145w5gke';

interface Call {
  url: string;
  method: string;
  body: unknown;
  idempotencyKey: string | undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let pinia: Pinia;
let calls: Call[] = [];
let createResponse: () => Response;
let availabilityCalls = 0;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  calls = [];
  availabilityCalls = 0;
  createResponse = () =>
    json({ bookingId: BOOKING_ID, reference: 'SF-ABC123', status: 'CONFIRMED' });

  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const raw = init?.body;
    const headers = new Headers(init?.headers ?? {});

    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined,
      idempotencyKey: headers.get('Idempotency-Key') ?? undefined,
    });

    if (url.includes('/office/bookings') && init?.method === 'POST') {
      return Promise.resolve(createResponse());
    }
    if (url.includes('/office/services')) {
      return Promise.resolve(
        json({
          items: [
            {
              id: SERVICE_ID,
              serviceCategoryId: null,
              name: 'Facial Massage 30',
              description: null,
              durationMinutes: 30,
              prepBufferMinutes: 0,
              cleanupBufferMinutes: 5,
              price: { amountCents: 4500, currency: 'EUR' },
              isBookableOnline: true,
              displayOrder: 0,
              archivedAt: null,
            },
            {
              id: OFFLINE_SERVICE_ID,
              serviceCategoryId: null,
              name: 'Not sold online',
              description: null,
              durationMinutes: 30,
              prepBufferMinutes: 0,
              cleanupBufferMinutes: 0,
              price: { amountCents: 4500, currency: 'EUR' },
              isBookableOnline: false,
              displayOrder: 1,
              archivedAt: null,
            },
          ],
        }),
      );
    }
    if (url.includes('/office/employees')) {
      return Promise.resolve(
        json({
          items: [
            { id: EMPLOYEE_ONE_ID, displayName: 'Mara Vogt' },
            { id: EMPLOYEE_TWO_ID, displayName: 'Jonas Reit' },
          ],
        }),
      );
    }
    if (url.includes('/office/availability')) {
      availabilityCalls += 1;

      return Promise.resolve(
        json({
          serviceId: SERVICE_ID,
          timezone: 'Europe/Berlin',
          days: [
            {
              date: '2026-08-14',
              slots: [
                {
                  startsAt: NINE,
                  endsAt: '2026-08-14T07:30:00.000Z',
                  employeeIds: [EMPLOYEE_ONE_ID, EMPLOYEE_TWO_ID],
                },
                {
                  startsAt: QUARTER_PAST,
                  endsAt: '2026-08-14T07:45:00.000Z',
                  employeeIds: [EMPLOYEE_TWO_ID],
                },
              ],
            },
          ],
        }),
      );
    }
    if (url.includes('/office/customers')) {
      return Promise.resolve(
        json({
          items: [
            {
              id: CUSTOMER_ID,
              firstName: 'Anna',
              lastName: 'Becker',
              email: 'anna@example.com',
              phone: null,
              locale: 'de',
              internalNote: null,
              marketingConsentAt: null,
              archivedAt: null,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          nextCursor: null,
        }),
      );
    }

    return Promise.resolve(json({ code: 'NOT_FOUND', correlationId: 'c1' }, 404));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountPage(user: Partial<OfficeUserDto> = {}) {
  useSession(pinia).user = { ...OWNER, ...user };

  await router.replace({ name: 'office-booking-new', query: { date: '2026-08-14' } });
  await router.isReady();

  const wrapper = mount(NewBooking, { global: { plugins: [pinia, router] } });
  await flushPromises();

  return wrapper;
}

/** Fill everything a new customer needs, leaving the slot and person to the caller. */
async function fillNewCustomer(wrapper: Awaited<ReturnType<typeof mountPage>>): Promise<void> {
  await wrapper.get('[data-test=first-name]').setValue('Anna');
  await wrapper.get('[data-test=last-name]').setValue('Becker');
  await wrapper.get('[data-test=email]').setValue('anna@example.com');
}

async function chooseServiceAndSlot(
  wrapper: Awaited<ReturnType<typeof mountPage>>,
  startsAt = NINE,
): Promise<void> {
  await wrapper.get('[data-test=service]').setValue(SERVICE_ID);
  await flushPromises();

  await wrapper.get(`[data-test=slot][data-start="${startsAt}"]`).trigger('click');
  await flushPromises();
}

function lastWrite(): Call {
  const call = calls.filter((entry) => entry.method === 'POST').at(-1);
  if (call === undefined) throw new Error('nothing was written');
  return call;
}

describe('NewBooking', () => {
  it('offers nothing to a role that may not create bookings', async () => {
    const wrapper = await mountPage({ role: 'EMPLOYEE', employeeId: EMPLOYEE_ONE_ID });

    expect(wrapper.find('[data-test=forbidden]').exists()).toBe(true);
    expect(wrapper.find('[data-test=create]').exists()).toBe(false);
    // And nothing was asked of the API on the way to being refused.
    expect(calls).toEqual([]);
  });

  it('offers only services that can actually be booked', async () => {
    const wrapper = await mountPage();

    const labels = wrapper
      .get('[data-test=service]')
      .findAll('option')
      .map((option) => option.text());

    expect(labels.join(' ')).toContain('Facial Massage 30');
    expect(labels.join(' ')).not.toContain('Not sold online');
  });

  it('takes its times from the office route, not the public one', async () => {
    const wrapper = await mountPage();
    await wrapper.get('[data-test=service]').setValue(SERVICE_ID);
    await flushPromises();

    expect(calls.some((call) => call.url.includes('/public/availability'))).toBe(false);
    expect(calls.some((call) => call.url.includes('/office/availability'))).toBe(true);
    expect(wrapper.findAll('[data-test=slot]')).toHaveLength(2);
  });

  it('narrows the people to whoever is free at the chosen time', async () => {
    const wrapper = await mountPage();

    // 09:15 has one candidate, so it is chosen rather than asked about.
    await chooseServiceAndSlot(wrapper, QUARTER_PAST);
    expect((wrapper.get('[data-test=employee]').element as HTMLSelectElement).value).toBe(
      EMPLOYEE_TWO_ID,
    );

    const names = wrapper
      .get('[data-test=employee]')
      .findAll('option')
      .map((option) => option.text());
    expect(names).toContain('Jonas Reit');
    expect(names).not.toContain('Mara Vogt');
  });

  it('books a new customer and lands on the booking it created', async () => {
    const wrapper = await mountPage();

    await chooseServiceAndSlot(wrapper);
    await wrapper.get('[data-test=employee]').setValue(EMPLOYEE_ONE_ID);
    await fillNewCustomer(wrapper);
    await wrapper.get('[data-test=note]').setValue('Allergic to lavender');

    await wrapper.get('[data-test=create]').trigger('click');
    await flushPromises();

    expect(lastWrite().body).toMatchObject({
      serviceId: SERVICE_ID,
      employeeId: EMPLOYEE_ONE_ID,
      startsAt: NINE,
      customer: { email: 'anna@example.com', firstName: 'Anna', lastName: 'Becker', locale: 'de' },
      customerNote: 'Allergic to lavender',
    });

    await vi.waitFor(() => {
      expect(router.currentRoute.value.name).toBe('office-booking');
    });
    expect(router.currentRoute.value.params.id).toBe(BOOKING_ID);
  });

  it('books an existing customer by id once one is chosen', async () => {
    const wrapper = await mountPage();

    await wrapper.get('[data-test=customer-search]').setValue('becker');
    await wrapper.get('[data-test=search]').trigger('click');
    await flushPromises();

    await wrapper.get('[data-test=pick-customer]').trigger('click');
    await chooseServiceAndSlot(wrapper);
    await wrapper.get('[data-test=employee]').setValue(EMPLOYEE_ONE_ID);

    await wrapper.get('[data-test=create]').trigger('click');
    await flushPromises();

    expect(lastWrite().body).toMatchObject({ customer: { customerId: CUSTOMER_ID } });
  });

  it('keeps one idempotency key across a retry of the same booking', async () => {
    createResponse = () => json({ code: 'INTERNAL', correlationId: 'c1' }, 500);

    const wrapper = await mountPage();
    await chooseServiceAndSlot(wrapper);
    await wrapper.get('[data-test=employee]').setValue(EMPLOYEE_ONE_ID);
    await fillNewCustomer(wrapper);

    await wrapper.get('[data-test=create]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-test=create]').trigger('click');
    await flushPromises();

    const keys = calls.filter((call) => call.method === 'POST').map((call) => call.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
  });

  it('mints a new key once the details change', async () => {
    createResponse = () => json({ code: 'INTERNAL', correlationId: 'c1' }, 500);

    const wrapper = await mountPage();
    await chooseServiceAndSlot(wrapper);
    await wrapper.get('[data-test=employee]').setValue(EMPLOYEE_ONE_ID);
    await fillNewCustomer(wrapper);

    await wrapper.get('[data-test=create]').trigger('click');
    await flushPromises();

    // A different appointment is a different request, and replaying the first key with it
    // is what `IDEMPOTENCY_KEY_REUSED` is for.
    await wrapper.get('[data-test=note]').setValue('Now with a note');
    await wrapper.get('[data-test=create]').trigger('click');
    await flushPromises();

    const keys = calls.filter((call) => call.method === 'POST').map((call) => call.idempotencyKey);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('re-reads the day when the server refuses the slot', async () => {
    createResponse = () => json({ code: 'SLOT_UNAVAILABLE', correlationId: 'c1' }, 409);

    const wrapper = await mountPage();
    await chooseServiceAndSlot(wrapper);
    await wrapper.get('[data-test=employee]').setValue(EMPLOYEE_ONE_ID);
    await fillNewCustomer(wrapper);

    const before = availabilityCalls;
    await wrapper.get('[data-test=create]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-test=save-error]').text().length).toBeGreaterThan(0);
    expect(availabilityCalls).toBe(before + 1);
    // Nothing is left selected from a slot the server has just refused.
    expect(wrapper.find('[data-test=employee]').exists()).toBe(false);
  });
});
