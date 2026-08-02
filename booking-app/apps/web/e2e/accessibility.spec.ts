import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { completeBooking, login, resetStack, stubCheckout } from './fixtures/stack.js';

import type { Page } from '@playwright/test';

/**
 * Every route a person actually lands on, checked by axe, in the state they see it in.
 *
 * Navigating straight to `/booking/slot` would scan a page with no service chosen —
 * a redirect, or an empty shell — and pass while saying nothing about the page a
 * customer meets. So the wizard is walked and each step scanned where it stands.
 *
 * Only serious and critical violations fail. Moderate and minor are worth reading and
 * not worth blocking a deploy on, and a gate that fires on everything gets switched
 * off within a month.
 */

const BLOCKING = new Set(['serious', 'critical']);

async function expectNoViolations(page: Page, where: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    // The rules a browser can meaningfully check on a rendered page. Colour contrast
    // is in scope on purpose: it is the violation this product is most likely to
    // introduce, because the palette is a token file nobody re-checks.
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const blocking = results.violations.filter((violation) => BLOCKING.has(violation.impact ?? ''));

  expect(
    blocking.map(
      (violation) => `${where}: ${violation.id} on ${violation.nodes[0]?.target.join(' ') ?? '?'}`,
    ),
  ).toEqual([]);
}

test.beforeEach(async ({ request }) => {
  await resetStack(request);
});

test('the customer journey has no serious accessibility violation', async ({ page }) => {
  await stubCheckout(page);

  await page.goto('/?lang=de');
  await expectNoViolations(page, '/');

  await page.getByTestId('start-booking').click();
  await expectNoViolations(page, '/booking/service');

  await page.getByTestId('service-card').first().click();
  await expectNoViolations(page, '/booking/employee');

  await page.getByTestId('employee-any').click();
  await expect(page.getByTestId('slot').first()).toBeVisible();
  await expectNoViolations(page, '/booking/slot');

  await page.getByTestId('slot').first().click();
  await expectNoViolations(page, '/booking/details');

  await page.getByTestId('first-name').fill('Anna');
  await page.getByTestId('last-name').fill('Becker');
  await page.getByTestId('email').fill('anna@example.com');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('countdown')).toBeVisible();
  await expectNoViolations(page, '/booking/checkout');

  await page.goto('/manage#not-a-real-token');
  await expectNoViolations(page, '/manage (expired link)');
});

test('the confirmation page has no serious accessibility violation', async ({ page, request }) => {
  await completeBooking(page, request, {
    firstName: 'Anna',
    lastName: 'Becker',
    email: 'anna@example.com',
  });

  await expectNoViolations(page, '/booking/success');
});

test('the office area has no serious accessibility violation', async ({ page }) => {
  await page.goto('/office/login');
  await expectNoViolations(page, '/office/login');

  await login(page, 'owner');
  await expectNoViolations(page, '/office');

  for (const route of ['calendar', 'bookings', 'requests', 'availability', 'exports', 'settings']) {
    await page.getByTestId(`nav-office-${route}`).click();
    await expect(page).toHaveURL(new RegExp(`/office/${route}$`));
    await expectNoViolations(page, `/office/${route}`);
  }
});

test('the booking flow can be completed with the keyboard alone', async ({ page }) => {
  await stubCheckout(page);
  await page.goto('/?lang=de');

  // No clicks anywhere below. Tab until the thing we want has focus, then activate it
  // the way a keyboard user does — which also proves each control is reachable in a
  // sensible order and is a real button rather than a div with a handler.
  await tabToTestId(page, 'start-booking');
  await page.keyboard.press('Enter');

  await tabToTestId(page, 'service-card');
  await page.keyboard.press('Enter');

  await tabToTestId(page, 'employee-any');
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('slot').first()).toBeVisible();
  await tabToTestId(page, 'slot');
  await page.keyboard.press('Enter');

  await tabToTestId(page, 'first-name');
  await page.keyboard.type('Anna');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Becker');
  await tabToTestId(page, 'email');
  await page.keyboard.type('anna@example.com');

  await tabToTestId(page, 'submit');
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('countdown')).toBeVisible();
});

/**
 * Tab forwards until the named control has focus.
 *
 * Bounded, because "press Tab until something happens" is otherwise a test that hangs
 * for the full timeout when a control is unreachable — and unreachable is exactly the
 * failure this is looking for, so it should be reported as one.
 */
async function tabToTestId(page: Page, testId: string, maxPresses = 40): Promise<void> {
  for (let press = 0; press < maxPresses; press += 1) {
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-test'));
    if (focused === testId) return;
    await page.keyboard.press('Tab');
  }

  throw new Error(`"${testId}" was not reachable within ${String(maxPresses)} tab presses.`);
}
