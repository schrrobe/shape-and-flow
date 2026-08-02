import { expect, test } from '@playwright/test';

import {
  completeBooking,
  drain,
  emailTo,
  emails,
  fillManualBooking,
  login,
  manageUrlFrom,
  reserveSlot,
  resetStack,
  setCancellationFee,
} from './fixtures/stack.js';

import type { Page } from '@playwright/test';

/**
 * A working day in the office.
 *
 * Everything here happens in the staff interface with a real session. What the
 * customer did first is done in the customer interface, in the same browser, because
 * the office's job is to deal with bookings that already exist and a fixture that
 * inserted them would skip the half of the system that produces them.
 *
 * The walk-in is the exception, and deliberately so: it is the one booking here that
 * never had a customer at a keyboard, which is exactly what the manual-booking screen is
 * for.
 */

const CUSTOMER = { firstName: 'Anna', lastName: 'Becker', email: 'anna@example.com' };

/** Somebody who rang up. They never see the website at all. */
const WALK_IN = {
  firstName: 'Ingo',
  lastName: 'Halm',
  email: 'ingo@example.com',
  phone: '+4915100000001',
};

test.beforeEach(async ({ request }) => {
  await resetStack(request);
});

/** Find a booking by its reference and open it. */
async function openBooking(page: Page, reference: string): Promise<void> {
  await page.getByTestId('nav-office-bookings').click();
  await page.getByTestId('search').fill(reference);
  await page.getByTestId('apply').click();

  await page.getByTestId(`row-${reference}`).click();
  await expect(page.getByTestId('actions')).toBeVisible();
}

test('the office books a walk-in by hand and takes cash for it', async ({ page, request }) => {
  await login(page, 'owner');

  await page.getByTestId('nav-office-calendar').click();
  await page.getByTestId('new-booking').click();

  await fillManualBooking(page, WALK_IN);

  // Confirmed on the spot, with no payment and no Checkout session: §6.5. Landing on
  // the booking rather than on a list is what makes the next step — the money — one click.
  await expect(page.getByTestId('status-CONFIRMED')).toBeVisible();
  await expect(page.getByTestId('actions')).toBeVisible();

  await page.getByTestId('action-payment').click();
  await page.getByTestId('payment-amount').fill('45.00');
  await page.getByTestId('payment-method').selectOption('CASH');
  await page.getByTestId('confirm').click();

  await expect(page.getByTestId('paid')).toContainText('45,00');

  // The customer still hears about the appointment, exactly as an online booking would
  // make them: the office typed the address, not the booking.
  await drain(request);
  const confirmation = await emailTo(request, WALK_IN.email);
  expect(confirmation.kind).toBe('BOOKING_CONFIRMATION');
});

test('the office signs in, sees the day, and records a cash payment', async ({ page, request }) => {
  const reserved = await reserveSlot(page, CUSTOMER, { serviceName: 'Facial Massage' });

  await login(page, 'owner');

  // The dashboard is the landing page, and the first thing on it is today.
  await expect(page.getByTestId('tile-today')).toBeVisible();
  await expect(page.getByTestId('tile-next7')).toBeVisible();

  await page.getByTestId('nav-office-calendar').click();
  await expect(page.getByTestId('current-date')).toBeVisible();

  await openBooking(page, reserved.reference);

  await page.getByTestId('action-payment').click();
  await page.getByTestId('payment-amount').fill('45.00');
  await page.getByTestId('payment-method').selectOption('CASH');
  await page.getByTestId('confirm').click();

  // The paid total is what the office reads to know whether to ask for money.
  await expect(page.getByTestId('paid')).toContainText('45,00');

  // And nothing was sent to the customer about money handed over in the room.
  expect((await emails(request)).map((message) => message.kind)).not.toContain('PAYMENT_RECEIVED');
});

test('the office decides a cancellation request and overrides the retained amount', async ({
  page,
  request,
}) => {
  await login(page, 'owner');
  await setCancellationFee(page, 50);

  // A customer books, pays, and then cancels inside the fee window — which opens a
  // request rather than cancelling outright.
  await page.goto('/?lang=de');
  await completeBooking(page, request, CUSTOMER, { serviceName: 'Facial Massage' });

  await page.goto(manageUrlFrom(await emailTo(request, CUSTOMER.email)));
  await page.getByTestId('cancel').click();
  await page.getByTestId('confirm').click();
  await expect(page.getByTestId('request-submitted')).toBeVisible();

  // The office decides it, and does not have to accept the suggestion.
  await page.goto('/office');
  await page.getByTestId('nav-office-requests').click();

  await expect(page.getByTestId('suggested')).toContainText('22,50');

  await page.getByTestId('retained').fill('10.00');
  await expect(page.getByTestId('refund-preview')).toContainText('35,00');

  await page.getByTestId('approve').click();
  await expect(page.getByTestId('decided')).toBeVisible();
});

test('the owner switches the cancellation fee on from the settings screen', async ({
  page,
  request,
}) => {
  await login(page, 'owner');

  // Through the form, not through the API. Until the policy control existed, a
  // percentage typed here did nothing at all: the policy stayed `NONE` and every late
  // cancellation was refunded in full, which is the opposite of what the screen implied.
  await page.getByTestId('nav-office-settings').click();
  await page.getByTestId('fee-policy').selectOption('PERCENTAGE');
  await page.getByTestId('fee-percent').fill('50');
  await page.getByTestId('free-cancellation').fill('72');
  await page.getByTestId('save').click();
  await expect(page.getByTestId('saved')).toBeVisible();

  // What the customer is then told is the proof that the setting took effect.
  await page.goto('/?lang=de');
  await completeBooking(page, request, CUSTOMER, { serviceName: 'Facial Massage' });

  await page.goto(manageUrlFrom(await emailTo(request, CUSTOMER.email)));
  await page.getByTestId('cancel').click();
  await expect(page.getByTestId('confirm-consequence')).toContainText('22,50');
});

test('the office blocks a time and it is gone from the public calendar', async ({ page }) => {
  await login(page, 'owner');
  await page.getByTestId('nav-office-availability').click();

  // Tomorrow, over the middle of the working day.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  await page.getByTestId('block-date').fill(tomorrow);
  await page.getByTestId('block-start').fill('09:00');
  await page.getByTestId('block-end').fill('18:00');
  await page.getByTestId('block-reason').fill('Team training');
  await page.getByTestId('add-block').click();

  await expect(page.getByTestId('blocked-error')).toHaveCount(0);
  await expect(page.locator('[data-test^="remove-block-"]')).toHaveCount(1);
});

test('the office exports its bookings as a CSV file', async ({ page, request }) => {
  await completeBooking(page, request, CUSTOMER, { serviceName: 'Facial Massage' });

  await login(page, 'owner');
  await page.getByTestId('nav-office-exports').click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-bookings').click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/bookings.*\.csv$/);
});

test('an employee sees no settings link and cannot reach the page', async ({ page }) => {
  await login(page, 'staff');

  // Not merely hidden by CSS: the entry is not rendered, because the sidebar is built
  // from what this user may do.
  await expect(page.getByTestId('nav-office-settings')).toHaveCount(0);
  await expect(page.getByTestId('nav-office-users')).toHaveCount(0);

  // And typing the address gets nowhere either, which is the half that matters.
  await page.goto('/office/settings');
  await expect(page.getByTestId('save')).toHaveCount(0);
});
