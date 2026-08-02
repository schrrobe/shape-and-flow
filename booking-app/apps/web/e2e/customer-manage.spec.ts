import { expect, test } from '@playwright/test';

import {
  completeBooking,
  emailTo,
  login,
  manageUrlFrom,
  resetStack,
  setCancellationFee,
} from './fixtures/stack.js';

/**
 * Self-service, reached the way a customer reaches it: by following the link in their
 * confirmation email.
 *
 * The token is never handed to the test by the API. It is read out of the message the
 * system actually sent, which is the only place it exists — the success page
 * deliberately withholds it, because a session id is not a credential and the token
 * is.
 */

const CUSTOMER = { firstName: 'Anna', lastName: 'Becker', email: 'anna@example.com' };

test.beforeEach(async ({ request }) => {
  await resetStack(request);
});

/** Book, confirm, and follow the management link out of the confirmation. */
async function bookAndOpenManage(
  page: Parameters<typeof completeBooking>[0],
  request: Parameters<typeof completeBooking>[1],
  weeksAhead: number,
): Promise<void> {
  // German explicitly. The locale otherwise follows the browser, which in this runner
  // is English — and the amounts this spec asserts on are formatted per locale, so a
  // German customer's "45,00 €" would arrive as "€45.00" and the test would be about
  // the wrong thing.
  await page.goto('/?lang=de');

  await completeBooking(page, request, CUSTOMER, { serviceName: 'Facial Massage', weeksAhead });

  await page.goto(manageUrlFrom(await emailTo(request, CUSTOMER.email)));
  await expect(page.getByTestId('reference')).toBeVisible();
}

test('cancelling outside the window states the refund and takes effect at once', async ({
  page,
  request,
}) => {
  // Three weeks out, comfortably beyond the 72-hour free window.
  await bookAndOpenManage(page, request, 3);

  await expect(page.getByTestId('policy-consequence')).toContainText('45,00');

  await page.getByTestId('cancel').click();
  // Stated again inside the dialog: somebody about to give up money should not have to
  // press anything to find out how much.
  await expect(page.getByTestId('confirm-consequence')).toContainText('45,00');

  await page.getByTestId('confirm').click();

  await expect(page.getByTestId('cancel-outcome')).toContainText('45,00');
  // No approval needed outside the window, so no request was opened.
  await expect(page.getByTestId('request-submitted')).toHaveCount(0);
});

test('cancelling inside the window opens a request for the amount it quoted', async ({
  page,
  request,
}) => {
  // The office turns the fee on first, and the customer meets it afterwards.
  await login(page, 'owner');
  await setCancellationFee(page, 50);
  await page.goto('/');

  await bookAndOpenManage(page, request, 0);

  // Half of 45,00. The number the customer is shown before confirming is the number
  // the office will later be asked to approve.
  await expect(page.getByTestId('policy-consequence')).toContainText('22,50');

  await page.getByTestId('cancel').click();
  await expect(page.getByTestId('confirm-consequence')).toContainText('22,50');
  await page.getByTestId('confirm').click();

  await expect(page.getByTestId('request-submitted')).toBeVisible();
  await expect(page.getByTestId('cancel-outcome')).toHaveCount(0);
});

test('an invalid management token shows a friendly page, not an error', async ({ page }) => {
  await page.goto('/manage#definitely-not-a-token');

  await expect(page.getByTestId('link-expired')).toBeVisible();
  // And nothing about the appointment leaks to somebody holding a wrong token.
  await expect(page.getByTestId('reference')).toHaveCount(0);
});
