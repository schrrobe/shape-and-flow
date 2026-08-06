import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../../i18n/index.js';
import { router } from '../../router/index.js';
import { useSession } from '../../stores/session.js';

import BookingDetail from './BookingDetail.vue';

import type { OfficeBookingDetail, OfficeUserDto } from '@shape-and-flow/booking-contracts';
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

function detail(): OfficeBookingDetail {
  return {
    id: 'b1',
    reference: 'SF-ABC123',
    status: 'CONFIRMED',
    displayStatus: 'CONFIRMED',
    origin: 'ONLINE',
    startsAt: '2026-08-14T07:00:00.000Z',
    endsAt: '2026-08-14T07:30:00.000Z',
    employeeId: 'e1',
    employeeName: 'Nora Feld',
    serviceName: 'Facial Massage 30',
    customerId: 'c1',
    customerName: 'Anna Becker',
    price: { amountCents: 4500, currency: 'EUR' },
    paid: { amountCents: 4500, currency: 'EUR' },
    createdAt: '2026-08-01T09:00:00.000Z',
    serviceId: 's1',
    blockStartsAt: '2026-08-14T07:00:00.000Z',
    blockEndsAt: '2026-08-14T07:30:00.000Z',
    durationMinutes: 30,
    prepBufferMinutes: 0,
    cleanupBufferMinutes: 0,
    locale: 'de',
    customerNote: null,
    confirmedAt: '2026-08-01T09:01:00.000Z',
    canceledAt: null,
    completedAt: null,
    expiresAt: null,
    createdByOfficeUserId: null,
    canceledByOfficeUserId: null,
    cancellationReason: null,
    customer: {
      id: 'c1',
      firstName: 'Anna',
      lastName: 'Becker',
      email: 'anna@example.test',
      phone: null,
    },
    payments: [],
    manualPayments: [],
    refunds: [],
    statusHistory: [],
    notifications: [],
    openCancellationRequest: null,
    openRescheduleRequest: null,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let pinia: Pinia;
let refundKeys: string[] = [];
/** How many refund attempts the fake API refuses before it accepts one. */
let refundFailures = 0;
let cancelKeys: string[] = [];
/** How many cancellation attempts the fake API refuses before it accepts one. */
let cancelFailures = 0;

beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  refundKeys = [];
  refundFailures = 0;
  cancelKeys = [];
  cancelFailures = 0;

  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.endsWith('/office/bookings/b1/cancel') && init?.method === 'POST') {
      const headers = new Headers(init.headers);
      cancelKeys.push(headers.get('Idempotency-Key') ?? '');

      if (cancelFailures > 0) {
        cancelFailures -= 1;
        return Promise.resolve(json({ code: 'INTERNAL', correlationId: 'c1' }, 500));
      }

      return Promise.resolve(json({ bookingId: 'b1', refundId: null }));
    }

    if (url.includes('/refunds') && init?.method === 'POST') {
      const headers = new Headers(init.headers);
      refundKeys.push(headers.get('Idempotency-Key') ?? '');

      if (refundFailures > 0) {
        refundFailures -= 1;
        // A 500 is what a lost response looks like from the browser: the server may have
        // done the work, and the reply says nothing either way.
        return Promise.resolve(json({ code: 'INTERNAL', correlationId: 'c1' }, 500));
      }

      return Promise.resolve(json({ refundId: 'r1' }));
    }

    if (url.includes('/auth/me')) {
      return Promise.resolve(json({ user: OWNER }));
    }

    if (url.includes('/office/bookings/b1')) {
      return Promise.resolve(json(detail()));
    }

    return Promise.resolve(json({ code: 'NOT_FOUND', correlationId: 'c1' }, 404));
  });

  // The session first: the office routes are guarded, and a guard that finds nobody signed
  // in redirects the push to the login screen — where `route.params.id` is undefined.
  useSession(pinia).user = OWNER;

  await router.push('/office/bookings/b1');
  await router.isReady();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountDetail() {
  const wrapper = mount(BookingDetail, {
    // The dialog teleports to `body`, so it is only reachable through the document.
    attachTo: document.body,
    global: { plugins: [pinia, router, i18n] },
  });
  await flushPromises();

  return wrapper;
}

/** An element of the open dialog, which lives in `body` rather than in the wrapper. */
function inDialog(selector: string): HTMLElement {
  const element = document.body.querySelector<HTMLElement>(`[role="dialog"] ${selector}`);
  if (element === null) throw new Error(`no ${selector} in the open dialog`);

  return element;
}

/** The same, for the one case that needs to type into a field. */
function inputInDialog(selector: string): HTMLInputElement {
  const element = inDialog(selector);
  if (!(element instanceof HTMLInputElement)) throw new Error(`${selector} is not an input`);

  return element;
}

async function openRefundFor(amount: string) {
  const wrapper = await mountDetail();

  await wrapper.get('[data-test=action-refund]').trigger('click');

  const input = inputInDialog('[data-test=refund-amount]');
  input.value = amount;
  input.dispatchEvent(new Event('input'));
  await flushPromises();

  return wrapper;
}

async function openCancelFor(reason: string) {
  const wrapper = await mountDetail();

  await wrapper.get('[data-test=action-cancel]').trigger('click');

  const input = inputInDialog('[data-test=cancel-reason]');
  input.value = reason;
  input.dispatchEvent(new Event('input'));
  await flushPromises();

  return wrapper;
}

/** The confirm button of the open dialog, which is the last of its two footer buttons. */
function confirmButton(): HTMLButtonElement {
  const buttons = [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
  const confirm = buttons.at(-1);
  if (confirm === undefined) throw new Error('no confirm button in the open dialog');

  return confirm;
}

async function confirm(): Promise<void> {
  confirmButton().click();
  await flushPromises();
}

describe('BookingDetail refunds', () => {
  beforeAll(() => {
    i18n.global.locale.value = 'en';
  });

  afterAll(() => {
    i18n.global.locale.value = 'de';
  });

  it('sends the same idempotency key when the operator retries the same refund', async () => {
    refundFailures = 1;
    await openRefundFor('10.00');

    await confirm();
    await confirm();

    // Two attempts, one operation. The usual reason to retry is that the first response
    // never arrived — the server may already have sent the money, and a fresh key would
    // ask it to send it again.
    expect(refundKeys).toHaveLength(2);
    expect(refundKeys[0]).toBe(refundKeys[1]);
    expect(refundKeys[0]).not.toBe('');
  });

  it('mints a new key once the amount changes, because that is a different refund', async () => {
    refundFailures = 1;
    await openRefundFor('10.00');

    await confirm();

    const input = inputInDialog('[data-test=refund-amount]');
    input.value = '20.00';
    input.dispatchEvent(new Event('input'));
    await flushPromises();

    await confirm();

    expect(refundKeys).toHaveLength(2);
    expect(refundKeys[0]).not.toBe(refundKeys[1]);
  });

  it('refuses to confirm an amount above what the customer paid, and says so', async () => {
    await openRefundFor('90.00');

    expect(confirmButton().disabled).toBe(true);
    expect(inDialog('[data-test=refund-invalid]').textContent).toMatch(/more than/i);

    await confirm();

    expect(refundKeys).toHaveLength(0);
  });
});

describe('BookingDetail cancellations', () => {
  beforeAll(() => {
    i18n.global.locale.value = 'en';
  });

  afterAll(() => {
    i18n.global.locale.value = 'de';
  });

  it('sends the same idempotency key when the operator retries the same cancellation', async () => {
    cancelFailures = 1;
    await openCancelFor('Krankheit');

    await confirm();
    await confirm();

    expect(cancelKeys).toHaveLength(2);
    expect(cancelKeys[0]).toBe(cancelKeys[1]);
    expect(cancelKeys[0]).not.toBe('');
  });

  it('mints a new key when the cancellation reason changes', async () => {
    cancelFailures = 1;
    await openCancelFor('Krankheit');

    await confirm();

    const input = inputInDialog('[data-test=cancel-reason]');
    input.value = 'Geschlossen';
    input.dispatchEvent(new Event('input'));
    await flushPromises();

    await confirm();

    expect(cancelKeys).toHaveLength(2);
    expect(cancelKeys[0]).not.toBe(cancelKeys[1]);
  });
});
