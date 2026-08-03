import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SettingsPage from './SettingsPage.vue';

import type { OfficeSettingsResponse } from '@shape-and-flow/booking-contracts';
import type { Pinia } from 'pinia';

enableAutoUnmount(afterEach);

function settings(overrides: Partial<OfficeSettingsResponse> = {}): OfficeSettingsResponse {
  return {
    organization: {
      id: 'org0000000000000000001',
      name: 'Shape and Flow',
      legalName: 'Shape and Flow GmbH',
      contactEmail: 'hallo@shape-and-flow.example',
      contactPhone: '+49301234567',
      whatsappNumber: null,
      addressLine1: 'Beispielstraße 1',
      addressLine2: null,
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
      timezone: 'Europe/Berlin',
      currency: 'EUR',
      defaultLocale: 'de',
    },
    schedulingIntervalMinutes: 15,
    bookingHorizonDays: 180,
    minimumNoticeHours: 24,
    reservationTtlMinutes: 5,
    freeCancellationHours: 72,
    cancellationFeePolicy: 'NONE',
    cancellationFeeAmountCents: 0,
    cancellationFeePercent: 0,
    reminderOffsetsMinutes: [1440],
    smsRemindersEnabled: false,
    customerNoteEnabled: true,
    dataRetentionDays: 1095,
    officeNotificationEmail: 'buero@shape-and-flow.example',
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let pinia: Pinia;
let stored: OfficeSettingsResponse;
let readStatus = 200;
let patches: unknown[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  stored = settings();
  readStatus = 200;
  patches = [];

  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (!url.includes('/office/settings')) {
      return Promise.resolve(json({ code: 'NOT_FOUND', correlationId: 'c1' }, 404));
    }

    if (init?.method === 'PATCH') {
      const body = JSON.parse(
        typeof init.body === 'string' ? init.body : '{}',
      ) as Partial<OfficeSettingsResponse>;
      patches.push(body);
      stored = { ...stored, ...body };

      return Promise.resolve(json(stored));
    }

    if (readStatus !== 200) {
      return Promise.resolve(json({ code: 'FORBIDDEN_ROLE', correlationId: 'c1' }, readStatus));
    }

    return Promise.resolve(json(stored));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountPage() {
  const wrapper = mount(SettingsPage, { global: { plugins: [pinia] } });
  await flushPromises();

  return wrapper;
}

function lastPatch(): Record<string, unknown> {
  const patch = patches.at(-1);
  if (patch === undefined) throw new Error('nothing was saved');

  return patch as Record<string, unknown>;
}

describe('SettingsPage', () => {
  it('switches the cancellation fee on, which is the whole point of the policy', async () => {
    const wrapper = await mountPage();

    await wrapper.get('[data-test=fee-policy]').setValue('PERCENTAGE');
    await wrapper.get('[data-test=fee-percent]').setValue('50');
    await wrapper.get('[data-test=save]').trigger('click');
    await flushPromises();

    // Before this control existed the percentage was inert: the policy stayed `NONE` and
    // nothing was ever retained, however large the number typed beside it.
    expect(lastPatch()).toMatchObject({
      cancellationFeePolicy: 'PERCENTAGE',
      cancellationFeePercent: 50,
    });
  });

  it('sends a fixed amount in cents', async () => {
    const wrapper = await mountPage();

    await wrapper.get('[data-test=fee-policy]').setValue('FIXED_AMOUNT');
    await wrapper.get('[data-test=fee-amount]').setValue('12,50');
    await wrapper.get('[data-test=save]').trigger('click');
    await flushPromises();

    expect(lastPatch()).toMatchObject({
      cancellationFeePolicy: 'FIXED_AMOUNT',
      cancellationFeeAmountCents: 1250,
    });
  });

  it('shows only the amount the chosen policy uses', async () => {
    const wrapper = await mountPage();

    expect(wrapper.find('[data-test=fee-percent]').exists()).toBe(false);
    expect(wrapper.find('[data-test=fee-amount]').exists()).toBe(false);

    await wrapper.get('[data-test=fee-policy]').setValue('PERCENTAGE');
    expect(wrapper.find('[data-test=fee-percent]').exists()).toBe(true);
    expect(wrapper.find('[data-test=fee-amount]').exists()).toBe(false);

    await wrapper.get('[data-test=fee-policy]').setValue('FIXED_AMOUNT');
    expect(wrapper.find('[data-test=fee-percent]').exists()).toBe(false);
    expect(wrapper.find('[data-test=fee-amount]').exists()).toBe(true);
  });

  it('fills both amounts from what is stored', async () => {
    stored = settings({
      cancellationFeePolicy: 'FIXED_AMOUNT',
      cancellationFeeAmountCents: 2000,
      cancellationFeePercent: 25,
    });

    const wrapper = await mountPage();

    expect((wrapper.get('[data-test=fee-policy]').element as HTMLSelectElement).value).toBe(
      'FIXED_AMOUNT',
    );
    expect((wrapper.get('[data-test=fee-amount]').element as HTMLInputElement).value).toBe('20.00');

    // The percentage survives a switch back, rather than being lost because the field it
    // lives in was hidden at the time.
    await wrapper.get('[data-test=fee-policy]').setValue('PERCENTAGE');
    expect((wrapper.get('[data-test=fee-percent]').element as HTMLInputElement).value).toBe('25');
  });

  it('offers no form to somebody the settings were refused to', async () => {
    readStatus = 403;

    const wrapper = await mountPage();

    expect(wrapper.find('[data-test=error]').exists()).toBe(true);
    expect(wrapper.find('[data-test=save]').exists()).toBe(false);
  });
});
