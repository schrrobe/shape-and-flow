import { SfSkeleton } from '@shape-and-flow/booking-ui';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../../i18n/index.js';
import { useSession } from '../../stores/session.js';

import RequestsPage from './RequestsPage.vue';

import type {
  OfficeCancellationRequest,
  OfficeRescheduleRequest,
  OfficeUserDto,
} from '@shape-and-flow/booking-contracts';
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function cancellationRequest(
  overrides: { paidCents?: number; suggestedRetainedAmountCents?: number } = {},
): OfficeCancellationRequest {
  const paidCents = overrides.paidCents ?? 4500;

  return {
    id: 'req-cancel-1',
    booking: {
      id: 'b1',
      reference: 'SF-ABC123',
      startsAt: '2026-08-14T07:00:00.000Z',
      employeeId: 'e1',
      serviceName: 'Facial Massage 30',
      customerName: 'Anna Becker',
      price: { amountCents: 4500, currency: 'EUR' },
      paid: { amountCents: paidCents, currency: 'EUR' },
    },
    reason: 'Something came up',
    requestedAt: '2026-08-12T09:00:00.000Z',
    decision: 'PENDING',
    suggestedRetainedAmountCents: overrides.suggestedRetainedAmountCents ?? 2250,
    retainedAmountCents: null,
    decidedAt: null,
    decisionNote: null,
  };
}

function rescheduleRequest(): OfficeRescheduleRequest {
  return {
    id: 'req-move-1',
    booking: {
      id: 'b2',
      reference: 'SF-DEF456',
      startsAt: '2026-08-10T07:00:00.000Z',
      employeeId: 'e1',
      serviceName: 'Facial Massage 30',
      customerName: 'Anna Becker',
      price: { amountCents: 4500, currency: 'EUR' },
      paid: { amountCents: 4500, currency: 'EUR' },
    },
    requestedStartsAt: '2026-08-14T12:00:00.000Z',
    requestedEmployeeId: null,
    reason: null,
    requestedAt: '2026-08-09T09:00:00.000Z',
    decision: 'PENDING',
    decidedAt: null,
    decisionNote: null,
    resultingBookingId: null,
  };
}

let pinia: Pinia;
let calls: { url: string; body: unknown }[] = [];
let cancellationItems: OfficeCancellationRequest[] = [];
let rescheduleItems: OfficeRescheduleRequest[] = [];

/**
 * The last *write*, which is what the assertions are about.
 *
 * Not simply the last call: every decision is followed by a reload, so `calls.at(-1)` is
 * the GET that refreshed the queue rather than the decision that was sent.
 */
function lastCall(): { url: string; body: unknown } {
  const call = calls.filter((entry) => entry.body !== undefined).at(-1);
  if (call === undefined) throw new Error('nothing was sent');
  return call;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  calls = [];
  cancellationItems = [];
  rescheduleItems = [];

  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const raw = init?.body;
    const body: unknown = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined;
    calls.push({ url, body });

    if (url.includes('/office/cancellation-requests') && init?.method === 'POST') {
      // Decided, so the reload finds nothing — which is what the real queue does.
      cancellationItems = [];
      return Promise.resolve(json({ requestId: 'req-cancel-1' }));
    }
    if (url.includes('/office/reschedule-requests') && init?.method === 'POST') {
      rescheduleItems = [];
      return Promise.resolve(json({ requestId: 'req-move-1', newBookingId: 'b3' }));
    }
    if (url.includes('/office/cancellation-requests')) {
      return Promise.resolve(json({ items: cancellationItems }));
    }
    if (url.includes('/office/reschedule-requests')) {
      return Promise.resolve(json({ items: rescheduleItems }));
    }

    return Promise.resolve(json({ code: 'NOT_FOUND', correlationId: 'c1' }, 404));
  });
});

async function mountWithRequest(
  overrides: { paidCents?: number; suggestedRetainedAmountCents?: number } = {},
  user: Partial<OfficeUserDto> = {},
) {
  cancellationItems = [cancellationRequest(overrides)];

  const session = useSession(pinia);
  session.user = { ...OWNER, ...user };

  const wrapper = mount(RequestsPage, { global: { plugins: [pinia, i18n] } });
  await flushPromises();

  return wrapper;
}

async function mountWithRescheduleRequest() {
  rescheduleItems = [rescheduleRequest()];

  const session = useSession(pinia);
  session.user = OWNER;

  const wrapper = mount(RequestsPage, { global: { plugins: [pinia, i18n] } });
  await flushPromises();

  return wrapper;
}

describe('RequestsPage', () => {
  beforeAll(() => {
    i18n.global.locale.value = 'en';
  });

  afterAll(() => {
    i18n.global.locale.value = 'de';
  });

  it('shows the suggested retained amount and lets the decider override it', async () => {
    const wrapper = await mountWithRequest({ paidCents: 4500, suggestedRetainedAmountCents: 2250 });

    expect(wrapper.get('[data-test=suggested]').text()).toContain('22,50');

    await wrapper.get('[data-test=retained]').setValue('10.00');
    await wrapper.get('[data-test=approve]').trigger('click');
    await flushPromises();

    expect(lastCall().body).toMatchObject({ decision: 'APPROVED', retainedAmountCents: 1000 });
  });

  it('sends no retained amount when the field is untouched', async () => {
    const wrapper = await mountWithRequest();

    await wrapper.get('[data-test=approve]').trigger('click');
    await flushPromises();

    // Omitted rather than echoed back: the API falls back to the frozen suggestion, which
    // is the number the customer was shown. Re-sending it would work today and diverge the
    // moment the two are computed differently.
    expect(lastCall().body).not.toHaveProperty('retainedAmountCents');
  });

  it('states the resulting refund amount before the decider confirms', async () => {
    const wrapper = await mountWithRequest({ paidCents: 4500, suggestedRetainedAmountCents: 2250 });

    // The field says what is *kept*; the number that leaves the business is the
    // difference, and that is what has to be on screen.
    expect(wrapper.get('[data-test=refund-preview]').text()).toContain('22,50');
  });

  it('updates the refund preview as the retained amount is typed', async () => {
    const wrapper = await mountWithRequest({ paidCents: 4500, suggestedRetainedAmountCents: 2250 });

    await wrapper.get('[data-test=retained]').setValue('10.00');

    expect(wrapper.get('[data-test=refund-preview]').text()).toContain('35,00');
  });

  it('hides the retained-amount field when the user lacks the refund capability', async () => {
    const wrapper = await mountWithRequest({}, { role: 'ADMIN', canIssueRefunds: false });

    // Hidden, not disabled: an admin without the capability can still refuse a request or
    // approve it keeping everything, and a greyed-out field would suggest otherwise.
    expect(wrapper.find('[data-test=retained]').exists()).toBe(false);
  });

  it('rejects a retained amount above the paid amount client-side', async () => {
    const wrapper = await mountWithRequest({ paidCents: 4500 });

    await wrapper.get('[data-test=retained]').setValue('50.00');

    expect(wrapper.get('[data-test=approve]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test=refund-preview]').text()).toMatch(/more than/i);
  });

  it('shows an approved reschedule as the new appointment time', async () => {
    const wrapper = await mountWithRescheduleRequest();

    expect(wrapper.get('[data-test=requested-start]').text()).toContain('14.08.2026');

    await wrapper.get('[data-test=approve]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-test=decided]').text()).toMatch(/14\.08\.2026/);
  });

  it('reloads after a decision, so a stale queue is never left on screen', async () => {
    const wrapper = await mountWithRequest();

    await wrapper.get('[data-test=approve]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test=empty]').exists()).toBe(true);
  });

  it('does not ask for cancellations an admin may not decide', async () => {
    rescheduleItems = [rescheduleRequest()];

    const session = useSession(pinia);
    session.user = { ...OWNER, role: 'EMPLOYEE', canIssueRefunds: false, employeeId: 'e1' };

    mount(RequestsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();

    // §10.5 gives an employee `cancellation.decide: none`, so asking would be a request
    // that 403s on every load and an error banner on a screen that is working correctly.
    expect(calls.some((call) => call.url.includes('cancellation-requests'))).toBe(false);
  });

  it('keeps the cancellation queue when the reschedule queue fails', async () => {
    cancellationItems = [cancellationRequest()];

    vi.stubGlobal('fetch', (url: string) => {
      if (url.includes('/office/reschedule-requests')) {
        return Promise.resolve(json({ code: 'FORBIDDEN', correlationId: 'c1' }, 403));
      }
      if (url.includes('/office/cancellation-requests')) {
        return Promise.resolve(json({ items: cancellationItems }));
      }

      return Promise.resolve(json({ code: 'NOT_FOUND', correlationId: 'c1' }, 404));
    });

    const session = useSession(pinia);
    session.user = OWNER;

    const wrapper = mount(RequestsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();

    // Two queues, two capabilities, two outcomes. One failing call used to take the other
    // queue with it, leaving a decider with nothing to decide and no reason why.
    expect(wrapper.find('[data-test=cancellation-req-cancel-1]').exists()).toBe(true);
    expect(wrapper.get('[data-test=error]').text()).not.toBe('');
  });

  it('shows the skeleton while the first load is in flight', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.stubGlobal('fetch', (url: string) => {
      if (
        url.includes('/office/cancellation-requests') ||
        url.includes('/office/reschedule-requests')
      ) {
        return held.then(() => json({ items: [] }));
      }

      return Promise.resolve(json({ code: 'NOT_FOUND', correlationId: 'c1' }, 404));
    });

    const session = useSession(pinia);
    session.user = OWNER;

    const wrapper = mount(RequestsPage, { global: { plugins: [pinia, i18n] } });
    await flushPromises();

    // The skeleton, not the empty message: "nothing is waiting for a decision" is a claim
    // about the queues, and nobody has answered yet. `empty` used to include the loading
    // flag, which made `loading && empty` a contradiction and the skeleton dead markup.
    expect(wrapper.findComponent(SfSkeleton).exists()).toBe(true);
    expect(wrapper.find('[data-test=empty]').exists()).toBe(false);

    release();
    await flushPromises();

    expect(wrapper.findComponent(SfSkeleton).exists()).toBe(false);
    expect(wrapper.find('[data-test=empty]').exists()).toBe(true);
  });
});
