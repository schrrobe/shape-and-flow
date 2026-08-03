import { expect, test } from '@playwright/test';

import {
  chooseFirstSlot,
  completeBooking,
  drain,
  emails,
  failNextCheckout,
  login,
  manageUrlFrom,
  resetStack,
  stubCheckout,
} from './fixtures/stack.js';

import type { APIRequestContext, Page } from '@playwright/test';

/**
 * The two journeys the review findings were about, driven through the browser.
 *
 * Both are cases the integration suite pins from the inside and neither could be seen
 * from outside before: a Checkout call that fails after the reservation has committed,
 * and money that has to stay visible across a booking being replaced twice.
 */

const CUSTOMER = { firstName: 'Anna', lastName: 'Becker', email: 'anna@example.com' };

test.beforeEach(async ({ request }) => {
  await resetStack(request);
});

test('a failed Checkout call is retried onto the reservation it already made', async ({
  page,
  request,
}) => {
  await stubCheckout(page);
  await page.goto('/?lang=de');
  await chooseFirstSlot(page, { serviceName: 'Facial Massage' });

  await page.getByTestId('first-name').fill(CUSTOMER.firstName);
  await page.getByTestId('last-name').fill(CUSTOMER.lastName);
  await page.getByTestId('email').fill(CUSTOMER.email);

  // The provider is unreachable for exactly one call. The reservation commits first, so
  // the slot is held by this very customer when the error appears.
  await failNextCheckout(request);
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('error')).toBeVisible();

  // The retry the error invites, with the same key and the same details. Without
  // resume this asks for a slot the customer is already holding and is refused
  // SLOT_UNAVAILABLE — locked out by their own first attempt for five minutes.
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('countdown')).toBeVisible();
  await expect(page.getByTestId('error')).toHaveCount(0);

  const reference = ((await page.getByTestId('reference').textContent()) ?? '').trim();
  expect(reference).toMatch(/^SF-[0-9A-HJKMNP-TV-Z]{6}$/);

  // One booking, not two. The office is where a duplicate would show up as a second
  // row holding a second slot.
  await login(page, 'owner');
  await page.getByTestId('nav-office-bookings').click();
  await page.getByTestId('search').fill(CUSTOMER.email);
  await page.getByTestId('apply').click();

  await expect(page.locator('[data-test^="row-SF-"]')).toHaveCount(1);
  await expect(page.getByTestId(`row-${reference}`)).toBeVisible();
});

test('money survives two reschedules and can still be refunded', async ({ page, request }) => {
  await page.goto('/?lang=de');
  const booked = await completeBooking(page, request, CUSTOMER, {
    serviceName: 'Facial Massage',
    weeksAhead: 3,
  });
  expect(booked.reference).toMatch(/^SF-/);

  await login(page, 'owner');

  // Two moves. Requested by the customer through their own link and approved by the
  // office, which is the only way a replacement booking comes into existence.
  await moveOnce(page, request, 1);
  const second = await moveOnce(page, request, 2);

  // The payment is still on the booking that was paid, two links back. Read from the
  // replacement's own relation it is invisible, and the office is shown an appointment
  // that has been paid for as owing the full price.
  await page.goto(`/office/bookings/${second.bookingId}`);
  await expect(page.getByTestId('paid')).toContainText('45,00');

  // And the money is reachable: a refund issued from the latest booking comes out of
  // the original charge rather than failing for want of a payment.
  await page.getByTestId('action-refund').click();
  await page.getByTestId('refund-amount').fill('10.00');
  await page.getByTestId('refund-reason').selectOption('GOODWILL');
  await page.getByTestId('confirm').click();

  await expect(page.getByTestId('money')).toContainText('10,00');
});

/**
 * One reschedule: the customer asks, the office approves.
 *
 * Through the two APIs rather than the two screens. The customer's picker and the
 * office's request queue are each proven by their own spec; what this journey is about
 * is what happens to the money afterwards, and driving six clicks to get there is six
 * ways for it to fail about something else.
 */
async function moveOnce(
  page: Page,
  request: APIRequestContext,
  weeksOut: number,
): Promise<{ bookingId: string }> {
  const token = (await currentManageToken(request)).split('#').at(-1) ?? '';

  const availability = await page.request.get('/api/manage/availability', {
    headers: { authorization: `Bearer ${token}` },
    params: { from: localDate(7 * (weeksOut + 3)), to: localDate(7 * (weeksOut + 3) + 6) },
  });
  expect(availability.ok(), `availability failed: ${await availability.text()}`).toBe(true);

  const days = (await availability.json()) as {
    days: { slots: { startsAt: string }[] }[];
  };
  const startsAt = days.days.flatMap((day) => day.slots).at(0)?.startsAt;
  expect(startsAt, 'no free slot to move into').toBeDefined();

  const requested = await page.request.post('/api/manage/reschedule-requests', {
    headers: { authorization: `Bearer ${token}` },
    data: { requestedStartsAt: startsAt },
  });
  expect(requested.status(), `reschedule request failed: ${await requested.text()}`).toBe(202);

  const { requestId } = (await requested.json()) as { requestId: string };

  const decided = await page.request.post(`/api/office/reschedule-requests/${requestId}/decide`, {
    headers: { 'x-requested-with': 'XMLHttpRequest' },
    data: { decision: 'APPROVED' },
  });
  expect(decided.ok(), `approval failed: ${await decided.text()}`).toBe(true);

  const { newBookingId } = (await decided.json()) as { newBookingId: string };
  expect(newBookingId).toEqual(expect.any(String));

  await drain(request);

  return { bookingId: newBookingId };
}

/**
 * The management link the customer currently holds.
 *
 * The *latest* one, not the first. A reschedule revokes the old token and the decision
 * email carries its replacement, so a helper that took the earliest message would send
 * the second move off with a link the system has already retired.
 */
async function currentManageToken(request: APIRequestContext): Promise<string> {
  const sent = (await emails(request)).filter(
    (message) => message.to === CUSTOMER.email && message.text.includes('/manage#'),
  );

  const latest = sent.at(-1);
  if (latest === undefined) throw new Error('no email with a management link');

  return manageUrlFrom(latest);
}

/** A local date this many days out, which is what the availability query takes. */
function localDate(daysAhead: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}
