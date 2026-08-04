import { expect, test } from '@playwright/test';

import {
  chooseFirstSlot,
  completeBooking,
  deliverWebhook,
  emailTo,
  emails,
  markSessionPaid,
  manageUrlFrom,
  reserveSlot,
  resetStack,
  selectDateWithSlots,
  slotsOn,
  stubCheckout,
} from './fixtures/stack.js';

/**
 * The journey the business exists for: somebody books an appointment and pays for it.
 *
 * Every step happens in the browser. The only calls that go around it are the ones a
 * browser cannot make — marking the fake session paid, signing the webhook Stripe
 * would send, and reading the mailbox — which is exactly what the test-support router
 * is for.
 */

test.beforeEach(async ({ request }) => {
  await resetStack(request);
});

test('a German customer books, pays, and is told their reference', async ({ page, request }) => {
  await page.goto('/?lang=de');
  await stubCheckout(page);

  const slot = await chooseFirstSlot(page, { serviceName: 'Facial Massage' });

  await page.getByTestId('first-name').fill('Anna');
  await page.getByTestId('last-name').fill('Becker');
  await page.getByTestId('email').fill('anna@example.com');
  await page.getByTestId('phone').fill('+4915112345678');

  // The note field says what happens to a health detail before anything is typed into it.
  await expect(page.getByTestId('note')).toBeVisible();
  await expect(page.getByTestId('summary-price')).toContainText('45,00');
  await expect(page.getByTestId('summary-employee')).not.toBeEmpty();

  await page.getByTestId('submit').click();

  // Five minutes, counting down, before the customer leaves for the payment page.
  await expect(page.getByTestId('countdown')).toContainText(/0[45]:\d\d/);

  const checkoutUrl = await page.getByTestId('checkout-link').getAttribute('href');
  const sessionId = (checkoutUrl ?? '').split('/').at(-1) ?? '';
  expect(sessionId).toMatch(/^cs_fake_/);

  await markSessionPaid(request, sessionId);
  await deliverWebhook(request, 'checkout.session.completed', sessionId);

  await page.goto(`/booking/success?session_id=${sessionId}`);

  await expect(page.getByTestId('reference')).toHaveText(/^SF-[0-9A-HJKMNP-TV-Z]{6}$/);
  await expect(page.getByTestId('confirmed-slot')).toContainText(slot.label);
  await expect(page.getByTestId('whatsapp-link')).toHaveAttribute('href', /^https:\/\/wa\.me\/\d+/);

  // The confirmation carries the management link, which is the only place it exists:
  // the success page deliberately does not show it, because a session id is not a
  // credential and the token is.
  expect(manageUrlFrom(await emailTo(request, 'anna@example.com'))).toContain('/manage#');
});

test('a reserved slot disappears for the next visitor while the first is still paying', async ({
  page,
  browser,
}) => {
  // A week out, and not because the test needs the distance: the earliest bookable day
  // is the one the minimum-notice window is eating into, so by mid-afternoon it can be
  // down to its last two or three slots — and this test's second assertion is that the
  // reserved day still has *others*. A whole working day cannot run out that way, so the
  // test now fails for the reason it is about rather than for the time it was run at.
  const reserved = await reserveSlot(
    page,
    { firstName: 'Anna', lastName: 'Becker', email: 'anna@example.com' },
    { weeksAhead: 1 },
  );

  // A second visitor, with their own session and their own draft.
  const second = await browser.newPage();
  try {
    await second.goto('/booking/service');
    await second.getByTestId('service-card').filter({ hasText: 'Facial Massage' }).first().click();
    const any = second.getByTestId('employee-any');
    if ((await any.count()) > 0) await any.click();
    else await second.getByTestId('employee-card').first().click();

    // The same date the first visitor booked, found the same way: the earliest day, at
    // or after that day, that still has something free.
    await selectDateWithSlots(second, reserved.date);
    await expect(second.getByTestId('slot').first()).toBeVisible();
    // The held slot is gone even though nobody has paid: PENDING_PAYMENT blocks.
    await expect(slotsOn(second, reserved.date).filter({ hasText: reserved.label })).toHaveCount(0);
    // And the rest of that day is still on offer, so this is not an empty page.
    await expect(slotsOn(second, reserved.date).first()).toBeVisible();
  } finally {
    await second.close();
  }
});

test('an English visitor gets English copy and an English email', async ({ page, request }) => {
  await page.goto('/?lang=en');
  await page.getByTestId('locale-en').click();

  await completeBooking(page, request, {
    firstName: 'Jane',
    lastName: 'Fisher',
    email: 'jane@example.com',
  });

  const [confirmation] = await emails(request);
  expect(confirmation?.locale).toBe('en');
  expect(confirmation?.subject).toMatch(/booking|appointment/i);
});

test('a double-clicked submit creates one booking, not two', async ({ page, request }) => {
  await stubCheckout(page);
  await chooseFirstSlot(page);

  await page.getByTestId('first-name').fill('Tom');
  await page.getByTestId('last-name').fill('Klein');
  await page.getByTestId('email').fill('tom@example.com');

  // Not two clicks with a wait between them — a real double-click, which is what an
  // impatient customer does and what the idempotency key exists for.
  await page.getByTestId('submit').dblclick();

  await expect(page.getByTestId('countdown')).toBeVisible();

  const reference = await page.getByTestId('reference').textContent();
  const checkoutUrl = await page.getByTestId('checkout-link').getAttribute('href');
  const sessionId = (checkoutUrl ?? '').split('/').at(-1) ?? '';

  await markSessionPaid(request, sessionId);
  await deliverWebhook(request, 'checkout.session.completed', sessionId);

  // One booking, so one confirmation. Two would mean two held slots and two charges.
  const sent = await emails(request);
  expect(sent.filter((message) => message.to === 'tom@example.com')).toHaveLength(1);
  expect(reference).toBeTruthy();
});
