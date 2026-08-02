import { expect, test } from '@playwright/test';

import {
  expireReservationNow,
  markSessionPaid,
  openSlotPicker,
  reserveSlot,
  resetStack,
  runExpiryJob,
  slotsOn,
} from './fixtures/stack.js';

/**
 * The two-phase expiry saga, seen from the calendar.
 *
 * This is the part of the product that is hardest to get right and easiest to believe
 * is right: a slot must stay blocked while nobody yet knows whether the customer paid,
 * and must be released the moment Stripe says nobody did. Both phases run where they
 * run in production — phase one in the API, phase two in the worker — so this is also
 * the test that would have caught the fake payment provider keeping its sessions in
 * one process.
 */

test.beforeEach(async ({ request }) => {
  await resetStack(request);
});

test('an abandoned checkout blocks the slot, and the expiry job gives it back', async ({
  page,
  request,
}) => {
  const reserved = await reserveSlot(page, {
    firstName: 'Anna',
    lastName: 'Becker',
    email: 'anna@example.com',
  });

  // Held while the deadline is still in the future, though nobody has paid.
  await openSlotPicker(page, { serviceName: 'Facial Massage' });
  await expect(slotsOn(page, reserved.date).filter({ hasText: reserved.label })).toHaveCount(0);

  // The deadline passes and the two phases run: the API claims the expiry, the worker
  // asks the provider and releases.
  //
  // Deliberately not asserted in between. The intermediate EXPIRING state — blocked,
  // because nobody yet knows whether the customer paid — is real and is what
  // expiry-saga.int.spec.ts pins under a controlled clock. It cannot be observed from
  // outside: `SWEEP_EXPIRED_RESERVATIONS` runs every sixty seconds and drives the whole
  // saga to its end on its own, so whether a browser catches the middle is luck. A test
  // written on that luck passes for a week and then blames the calendar.
  await expireReservationNow(request, reserved.sessionId);
  await runExpiryJob(request, reserved.sessionId);

  await openSlotPicker(page, { serviceName: 'Facial Massage' });
  await expect(slotsOn(page, reserved.date).filter({ hasText: reserved.label })).toHaveCount(1);
});

test('paying just after the deadline keeps the appointment instead of losing it', async ({
  page,
  request,
}) => {
  const reserved = await reserveSlot(page, {
    firstName: 'Anna',
    lastName: 'Becker',
    email: 'anna@example.com',
  });

  // The order that costs a customer their appointment if the saga is naive: the
  // deadline passes, and only then does the payment land.
  await expireReservationNow(request, reserved.sessionId);
  await markSessionPaid(request, reserved.sessionId);

  await runExpiryJob(request, reserved.sessionId);

  await page.goto(`/booking/success?session_id=${reserved.sessionId}`);

  // Confirmed by the expiry job itself, not by a webhook: the job asked, was told the
  // session was already complete, and confirmed instead of releasing.
  await expect(page.getByTestId('confirmed')).toBeVisible();
  await expect(page.getByTestId('reference')).toHaveText(/^SF-[0-9A-HJKMNP-TV-Z]{6}$/);
});
