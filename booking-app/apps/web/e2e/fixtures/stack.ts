import { expect } from '@playwright/test';

import type { APIRequestContext, Page } from '@playwright/test';

/**
 * What the suite is allowed to do outside the browser.
 *
 * Everything a customer or a member of staff can do, the tests do through the pages —
 * that is the point of an end-to-end suite, and a helper that posted to the API to
 * "save time" would be testing the API twice and the interface never. What lives here
 * is only the part with no interface: the database's starting state, Stripe's opinion
 * of a session, Stripe's signature, and the mailbox.
 *
 * Waiting is the other thing. Nothing here sleeps; every wait polls something the
 * system actually reports, because a `waitForTimeout` is a test that passes on a fast
 * machine and fails on a loaded one, and the difference tells you nothing.
 */

/** Where the fake payment provider sends a customer instead of Stripe. */
const FAKE_CHECKOUT_HOST = 'https://checkout.fake.local';

/** Matches the seed and what playwright.config.ts hands the reset. */
const OWNER = { email: 'owner@shape-and-flow.example', password: 'e2e-owner-password' };
const STAFF = { email: 'mara@shape-and-flow.example', password: 'e2e-staff-password' };

export interface OutboxMessage {
  id: string;
  kind: string;
  channel: 'EMAIL' | 'SMS';
  locale: 'de' | 'en';
  to: string;
  status: string;
  subject: string;
  text: string;
  createdAt: string;
}

interface PendingWork {
  queued: number;
  failed: number;
  unprocessedOutbox: number;
  unprocessedWebhooks: number;
  pendingNotifications: number;
  idle: boolean;
}

// ── the four privileged operations ──────────────────────────────────────────

/** Truncate, reseed, clear the queues. Every spec starts from this. */
export async function resetStack(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/test-support/reset', {
    data: { ownerPassword: OWNER.password, staffPassword: STAFF.password },
  });

  // Asserted rather than assumed: a failed reset makes the *next* assertion fail, in a
  // test that has nothing to do with it.
  expect(response.ok(), `reset failed: ${await response.text()}`).toBe(true);
}

/**
 * Make the next Checkout call fail, once.
 *
 * The one provider failure a browser cannot provoke, and the one the retry path exists
 * for: the reservation commits and the provider call does not, so the customer is asked
 * to try again while their own hold is still on the slot.
 */
export async function failNextCheckout(request: APIRequestContext): Promise<void> {
  const response = await request.post('/api/test-support/checkout/fail-next');
  expect(response.ok(), `arming the failure failed: ${await response.text()}`).toBe(true);
}

/** Mark the Checkout session paid, as completing Stripe's form would. */
export async function markSessionPaid(
  request: APIRequestContext,
  sessionId: string,
): Promise<void> {
  const response = await request.post(`/api/test-support/checkout/${sessionId}/pay`);
  expect(response.ok(), `pay failed: ${await response.text()}`).toBe(true);
}

/**
 * Send a signed Stripe event to the real webhook route, and wait for it to be handled.
 *
 * Two steps on purpose. The signature comes from test-support, because it needs a
 * secret; the delivery goes to `/api/webhooks/stripe` like any other, so the signature
 * check, the inbox deduplication and the enqueue are the production ones. The bytes
 * from the first call are posted verbatim — re-serialising them would change the bytes
 * the signature covers.
 */
export async function deliverWebhook(
  request: APIRequestContext,
  type: string,
  sessionId: string,
): Promise<void> {
  const signed = await request.post('/api/test-support/stripe-event', {
    data: { type, sessionId },
  });
  expect(signed.ok(), `signing failed: ${await signed.text()}`).toBe(true);

  const { body, signature } = (await signed.json()) as { body: string; signature: string };

  const delivered = await request.post('/api/webhooks/stripe', {
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    data: body,
  });
  expect(delivered.status(), `webhook rejected: ${await delivered.text()}`).toBe(200);

  await drain(request);
}

/** Every message the system decided to send, rendered from its frozen payload. */
async function outbox(request: APIRequestContext): Promise<OutboxMessage[]> {
  const response = await request.get('/api/test-support/outbox');
  expect(response.ok()).toBe(true);
  return (await response.json()) as OutboxMessage[];
}

export async function emails(request: APIRequestContext): Promise<OutboxMessage[]> {
  return (await outbox(request)).filter((message) => message.channel === 'EMAIL');
}

/**
 * The one email sent to this address, or a failure that says so.
 *
 * A `find(...)!` reads as "there is obviously one", and when there is not, the test
 * fails several lines later on something unrelated — a regex that found no match, or a
 * navigation to `undefined`. Naming the expectation puts the failure where the cause is.
 */
export async function emailTo(
  request: APIRequestContext,
  recipient: string,
): Promise<OutboxMessage> {
  const sent = await emails(request);
  const message = sent.find((candidate) => candidate.to === recipient);

  if (message === undefined) {
    throw new Error(
      `No email to ${recipient}. Sent: ${sent.map((each) => `${each.to} (${each.kind})`).join(', ') || 'nothing'}.`,
    );
  }

  return message;
}

// ── the reservation clock ───────────────────────────────────────────────────

/** Phase one: the deadline passes. The slot stays blocked. */
export async function expireReservationNow(
  request: APIRequestContext,
  sessionId: string,
): Promise<void> {
  const response = await request.post(`/api/test-support/reservations/${sessionId}/expire-now`);
  expect(response.ok(), `expire-now failed: ${await response.text()}`).toBe(true);
}

/** Phase two, in the worker: ask the provider, then release or confirm. */
export async function runExpiryJob(request: APIRequestContext, sessionId: string): Promise<void> {
  const response = await request.post(`/api/test-support/reservations/${sessionId}/run-expiry`);
  expect(response.ok(), `run-expiry failed: ${await response.text()}`).toBe(true);
  await drain(request);
}

// ── waiting ─────────────────────────────────────────────────────────────────

/**
 * Wait until the worker has nothing left to do.
 *
 * Twice in a row, deliberately. A single idle reading catches the gap between the
 * outbox relay dispatching a row and the job it produced reaching the queue, and the
 * test then asserts on an email that is two hundred milliseconds from existing.
 *
 * A failed job ends the wait immediately rather than at the timeout: the run is not
 * going to become idle, and "job X failed" is a better report than "still busy".
 */
export async function drain(request: APIRequestContext, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveIdle = 0;
  let last: PendingWork | null = null;

  while (Date.now() < deadline) {
    const response = await request.get('/api/test-support/pending');
    last = (await response.json()) as PendingWork;

    expect(last.failed, `a job failed while draining: ${JSON.stringify(last)}`).toBe(0);

    consecutiveIdle = last.idle ? consecutiveIdle + 1 : 0;
    if (consecutiveIdle === 2) return;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `the worker did not catch up within ${String(timeoutMs)}ms: ${JSON.stringify(last)}`,
  );
}

// ── the browser's side ──────────────────────────────────────────────────────

/**
 * Keep the browser off the payment provider, and record that it tried to go.
 *
 * The hand-off page redirects two seconds after it appears, and the fake provider's URL
 * points at a host that does not resolve — so without this the browser lands on a DNS
 * error and the trace is about networking rather than about booking.
 *
 * Answered with `204 No Content`, which is the one response that leaves the document
 * alone: a browser treats it as "nothing to navigate to" and stays put. The two
 * alternatives both destroy the page the tests are reading — a stub body replaces it,
 * and an abort commits Chromium's network-error page — and everything the hand-off
 * page shows, the countdown and the reference and the Checkout link, would then be
 * gone two seconds after it rendered. That is a race that passes on a quiet machine.
 *
 * The recorded URLs still prove the customer was sent to the provider.
 */
export async function stubCheckout(page: Page): Promise<{ redirects: string[] }> {
  const redirects: string[] = [];

  await page.route(`${FAKE_CHECKOUT_HOST}/**`, async (route) => {
    redirects.push(route.request().url());
    await route.fulfill({ status: 204 });
  });

  return { redirects };
}

/** The session id the fake put in its Checkout URL. */
function sessionIdFrom(checkoutUrl: string): string {
  const id = checkoutUrl.split('/').at(-1);
  if (id?.startsWith('cs_') !== true) {
    throw new Error(`No checkout session id in ${checkoutUrl}.`);
  }
  return id;
}

/** The management link out of a confirmation email, as the customer would follow it. */
export function manageUrlFrom(message: OutboxMessage): string {
  const match = /https?:\/\/\S*\/manage#\S+/.exec(message.text);
  if (match === null) {
    throw new Error(`No /manage# link in the ${message.kind} message:\n${message.text}`);
  }
  // Trailing punctuation from a sentence would become part of the token.
  return match[0].replace(/[.,)]+$/, '');
}

// ── driving the booking flow ────────────────────────────────────────────────

export interface ChosenSlot {
  /** As shown on the slot button, e.g. "09:00". */
  label: string;
  /** The day it belongs to, `YYYY-MM-DD`. */
  date: string;
}

export interface BookedSlot extends ChosenSlot {
  sessionId: string;
  reference: string;
}

/**
 * One day's slots.
 *
 * Scoped by day because the picker shows a week at a time and "09:00" is on every
 * working day in it: an unscoped `hasText: '09:00'` matches five buttons, and the
 * assertion that a reserved slot has disappeared passes or fails for the wrong reason.
 */
export function slotsOn(page: Page, date: string) {
  return page.locator(`[data-test="day"][data-date="${date}"]`).getByTestId('slot');
}

/**
 * Service, employee, slot — up to the details form, without filling it.
 *
 * Returns the label of the slot it took, because "the slot I booked is gone for the
 * next visitor" is the assertion several specs are built on and comparing labels is
 * how a browser can see it.
 */
export interface SlotPickerOptions {
  serviceName?: string;
  skipEmployeeChoice?: boolean;
  /** Click "next week" this many times before reading the slots. */
  weeksAhead?: number;
}

/**
 * Walk the wizard to the slot step, without taking a slot.
 *
 * Re-driven from the start rather than reloaded. The draft — which service, which
 * employee — lives in a store in memory, deliberately, because a Checkout URL is not
 * meant to be bookmarkable; so `page.reload()` on the slot step leaves the page asking
 * for the availability of no service at all, and a test that then finds no slots has
 * discovered nothing.
 */
export async function openSlotPicker(page: Page, options: SlotPickerOptions = {}): Promise<void> {
  await page.goto('/booking/service');

  const service =
    options.serviceName === undefined
      ? page.getByTestId('service-card').first()
      : page.getByTestId('service-card').filter({ hasText: options.serviceName }).first();

  await service.click();

  // "Anyone" only appears when more than one person offers the service.
  const any = page.getByTestId('employee-any');
  if (options.skipEmployeeChoice === true || (await any.count()) === 0) {
    await page.getByTestId('employee-card').first().click();
  } else {
    await any.click();
  }

  await expect(page.getByTestId('slot').first()).toBeVisible();

  // Further out than the default free-cancellation window, when a test needs it.
  for (let week = 0; week < (options.weeksAhead ?? 0); week += 1) {
    await page.getByTestId('next-week').click();
    await expect(page.getByTestId('slot').first()).toBeVisible();
  }
}

export async function chooseFirstSlot(
  page: Page,
  options: SlotPickerOptions = {},
): Promise<ChosenSlot> {
  await openSlotPicker(page, options);

  const slot = page.getByTestId('slot').first();
  await expect(slot).toBeVisible();

  const label = ((await slot.textContent()) ?? '').trim();
  const date =
    (await slot.locator('xpath=ancestor::section[@data-test="day"]').getAttribute('data-date')) ??
    '';

  await slot.click();

  return { label, date };
}

/** The details form and the submit, landing on the checkout hand-off page. */
async function fillDetailsAndSubmit(
  page: Page,
  customer: { firstName: string; lastName: string; email: string; phone?: string },
): Promise<void> {
  await page.getByTestId('first-name').fill(customer.firstName);
  await page.getByTestId('last-name').fill(customer.lastName);
  await page.getByTestId('email').fill(customer.email);
  if (customer.phone !== undefined) await page.getByTestId('phone').fill(customer.phone);

  await page.getByTestId('submit').click();
  await expect(page.getByTestId('countdown')).toBeVisible();
}

/** Everything up to "the customer is on the payment page", with the ids to continue. */
export async function reserveSlot(
  page: Page,
  customer: { firstName: string; lastName: string; email: string; phone?: string },
  options: SlotPickerOptions = {},
): Promise<BookedSlot> {
  await stubCheckout(page);

  const slot = await chooseFirstSlot(page, options);
  await fillDetailsAndSubmit(page, customer);

  const checkoutUrl = await page.getByTestId('checkout-link').getAttribute('href');
  const reference = ((await page.getByTestId('reference').textContent()) ?? '').trim();

  return { ...slot, sessionId: sessionIdFrom(checkoutUrl ?? ''), reference };
}

/** Reserve, pay, deliver the webhook, and land on the confirmation page. */
export async function completeBooking(
  page: Page,
  request: APIRequestContext,
  customer: { firstName: string; lastName: string; email: string; phone?: string },
  options: SlotPickerOptions = {},
): Promise<BookedSlot> {
  const booked = await reserveSlot(page, customer, options);

  await markSessionPaid(request, booked.sessionId);
  await deliverWebhook(request, 'checkout.session.completed', booked.sessionId);

  await page.goto(`/booking/success?session_id=${booked.sessionId}`);
  await expect(page.getByTestId('confirmed')).toBeVisible();

  return booked;
}

// ── the office ──────────────────────────────────────────────────────────────

/**
 * Switch the cancellation fee on, as an owner would.
 *
 * Through the office API with the session the browser is holding, rather than through
 * the settings screen, because in most specs the fee is a *precondition* and not the
 * thing under test — a form filled in on the way to the real scenario is three clicks
 * that can only fail for reasons the test is not about.
 *
 * The screen itself is proven once, in `office-journey.spec.ts`: the policy control it
 * needed was missing until then, and this helper existed to work around that gap.
 */
export async function setCancellationFee(
  page: Page,
  percent: number,
  freeCancellationHours = 72,
): Promise<void> {
  const response = await page.request.patch('/api/office/settings', {
    headers: { 'x-requested-with': 'XMLHttpRequest' },
    data: {
      cancellationFeePolicy: percent === 0 ? 'NONE' : 'PERCENTAGE',
      cancellationFeePercent: percent,
      freeCancellationHours,
    },
  });

  expect(response.ok(), `settings update failed: ${await response.text()}`).toBe(true);
}

/**
 * Fill in the manual-booking screen and book it, from wherever the form was opened.
 *
 * The day is *found* rather than computed: the form is asked for the first day that has
 * anything free, walking forward from the one it opened on. The seeded week is
 * Monday–Friday with two public holidays in it, and a test that hard-coded "tomorrow"
 * would fail on a Saturday for reasons that have nothing to do with what it checks.
 */
export async function fillManualBooking(
  page: Page,
  customer: { firstName: string; lastName: string; email: string; phone?: string },
  options: { serviceName?: string } = {},
): Promise<void> {
  // Chosen by the text an operator reads, not by an id a fixture would have to know.
  // `selectOption({ label })` matches the whole label, and the label here carries the
  // duration and the price as well as the name.
  const option = page
    .getByTestId('service')
    .locator('option', { hasText: options.serviceName ?? 'Facial Massage' })
    .first();

  await page.getByTestId('service').selectOption(String(await option.getAttribute('value')));

  const day = page.getByTestId('date');

  for (let attempt = 0; attempt < 8; attempt += 1) {
    // The slot list is loaded per day; either it has buttons or it says it has none.
    await expect(page.getByTestId('slot').first().or(page.getByTestId('no-slots'))).toBeVisible();

    if ((await page.getByTestId('slot').count()) > 0) break;

    const next = new Date(`${await day.inputValue()}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    await day.fill(next.toISOString().slice(0, 10));
  }

  await expect(page.getByTestId('slot').first()).toBeVisible();
  await page.getByTestId('slot').first().click();

  // One free person is chosen for the operator, several are offered — either way the
  // select holds a real employee before the booking is sent.
  const employee = page.getByTestId('employee');
  if ((await employee.inputValue()) === '') {
    await employee.selectOption({ index: 1 });
  }

  await page.getByTestId('first-name').fill(customer.firstName);
  await page.getByTestId('last-name').fill(customer.lastName);
  await page.getByTestId('email').fill(customer.email);
  if (customer.phone !== undefined) await page.getByTestId('phone').fill(customer.phone);

  await page.getByTestId('create').click();
}

export async function login(page: Page, who: 'owner' | 'staff' = 'owner'): Promise<void> {
  const user = who === 'owner' ? OWNER : STAFF;

  await page.goto('/office/login');
  await page.getByTestId('email').fill(user.email);
  await page.getByTestId('password').fill(user.password);
  await page.getByTestId('sign-in').click();

  // Waiting on the signed-in chrome, not on the URL. `/office/login` matches almost
  // any pattern for "somewhere under /office", so a URL assertion is satisfied by the
  // page the sign-in was supposed to leave — and the failure then surfaces several
  // steps later as an unexplained 401.
  await expect(page.getByTestId('current-user')).toBeVisible();
}
