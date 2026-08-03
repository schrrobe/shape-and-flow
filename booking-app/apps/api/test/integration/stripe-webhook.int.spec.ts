import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { StripeEventProcessor } from '../../src/booking/processors/stripe-event.processor.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { hashManagementToken } from '../../src/manage/management-token.service.js';
import { JOB } from '../../src/messaging/queues/job-contracts.js';
import { Prisma } from '../../src/prisma/client.js';
import { WebhooksModule } from '../../src/webhooks/webhooks.module.js';
import { PUBLIC_WEB_ORIGIN, createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';

import type { FakePaymentProvider } from '../../src/providers/payment/fake-payment.provider.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

const NOW = new Date('2026-08-10T06:00:00.000Z');

let ctx: SeedContext;
let clock: FixedClock;
let testApp: BookingTestApp;
let server: () => Server;
let payments: FakePaymentProvider;
let processor: StripeEventProcessor;

/** A booking with a live Checkout session, created the way production creates one. */
async function bookedSlot(): Promise<{ bookingId: string; sessionId: string }> {
  const response = await request(server())
    .post('/public/bookings')
    .set('Idempotency-Key', randomUUID())
    .send({
      serviceId: ctx.service30.id,
      employeeId: ctx.employee1.id,
      startsAt: SLOT_FRIDAY_0900.toISOString(),
      customer: { email: 'anna@example.com', firstName: 'Anna', lastName: 'Becker' },
      locale: 'de',
      successUrl: `${PUBLIC_WEB_ORIGIN}/booking/success`,
      cancelUrl: `${PUBLIC_WEB_ORIGIN}/booking/canceled`,
    })
    .expect(201);

  const created = response.body as { bookingId: string };
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: created.bookingId } });

  return { bookingId: booking.id, sessionId: booking.stripeCheckoutSessionId ?? '' };
}

/** A Stripe event body, as bytes, so the signature is over what is actually sent. */
function rawEvent(
  type: string,
  object: Record<string, unknown>,
  id = 'evt_1',
): { raw: Buffer; id: string } {
  const body = JSON.stringify({
    id,
    type,
    api_version: '2026-07-29.dahlia',
    data: { object },
  });

  return { raw: Buffer.from(body, 'utf8'), id };
}

/**
 * Send the body as a string, not a Buffer.
 *
 * Superagent re-serialises a Buffer for a JSON content type — it arrives as
 * `{"type":"Buffer","data":[...]}` — so the bytes signed would not be the bytes sent,
 * and the signature check would fail for the right reason on the wrong input.
 */
const postWebhook = (raw: Buffer, signature?: string) => {
  const req = request(server()).post('/webhooks/stripe').set('content-type', 'application/json');

  return (signature === undefined ? req : req.set('stripe-signature', signature)).send(
    raw.toString('utf8'),
  );
};

/** Store an event directly, for tests that drive the processor rather than the route. */
async function seedEvent(type: string, object: Record<string, unknown>, id: string): Promise<void> {
  await prisma.stripeWebhookEvent.create({
    data: {
      stripeEventId: id,
      type,
      payload: { id, type, data: { object } } as Prisma.InputJsonValue,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);
  clock = new FixedClock(NOW);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock,
    extraImports: [WebhooksModule],
  });

  server = testApp.server;
  payments = testApp.payments;
  processor = testApp.app.get(StripeEventProcessor);

  return testApp.close;
});

describe('POST /webhooks/stripe', () => {
  it('rejects a bad signature with 400 and stores nothing', async () => {
    const { raw } = rawEvent('checkout.session.completed', { id: 'cs_fake_x' });

    await postWebhook(raw, 'nope').expect(400);

    // An unverified body is not evidence of anything, and storing it would let anyone
    // fill the inbox.
    expect(await prisma.stripeWebhookEvent.count()).toBe(0);
  });

  it('rejects a missing signature', async () => {
    const { raw } = rawEvent('checkout.session.completed', { id: 'cs_fake_x' });
    await postWebhook(raw).expect(400);
  });

  it('stores the event and returns 200 without processing it', async () => {
    const { sessionId } = await bookedSlot();
    const { raw } = rawEvent('checkout.session.completed', {
      id: sessionId,
      payment_status: 'paid',
    });

    await postWebhook(raw, payments.signatureFor(raw)).expect(200);

    // Stored and unprocessed: the response is fast because the work happens in a worker.
    expect(await prisma.stripeWebhookEvent.count({ where: { processedAt: null } })).toBe(1);
    expect((await prisma.booking.findFirstOrThrow()).status).toBe('PENDING_PAYMENT');
  });

  it('returns 200 and stores nothing extra for a duplicate delivery', async () => {
    const { sessionId } = await bookedSlot();
    const { raw } = rawEvent('checkout.session.completed', {
      id: sessionId,
      payment_status: 'paid',
    });

    await postWebhook(raw, payments.signatureFor(raw)).expect(200);
    await postWebhook(raw, payments.signatureFor(raw)).expect(200);

    expect(await prisma.stripeWebhookEvent.count()).toBe(1);
  });

  it('is not throttled, since the signature is the gate', async () => {
    // A rate limit here would let anyone delay real payment events by flooding the
    // endpoint.
    const { sessionId } = await bookedSlot();

    for (let index = 0; index < 5; index += 1) {
      const { raw } = rawEvent(
        'checkout.session.completed',
        { id: sessionId, payment_status: 'paid' },
        `evt_flood_${String(index)}`,
      );
      await postWebhook(raw, payments.signatureFor(raw)).expect(200);
    }

    expect(await prisma.stripeWebhookEvent.count()).toBe(5);
  });
});

describe('confirming a paid booking', () => {
  let bookingId: string;
  let sessionId: string;

  beforeEach(async () => {
    ({ bookingId, sessionId } = await bookedSlot());
  });

  it('confirms, records the payment, issues one token and queues the notification', async () => {
    await seedEvent(
      'checkout.session.completed',
      {
        id: sessionId,
        payment_status: 'paid',
        amount_total: ctx.service30.priceCents,
        payment_intent: 'pi_1',
        latest_charge: 'ch_1',
      },
      'evt_paid',
    );

    await processor.handle({ stripeEventId: 'evt_paid' });

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('CONFIRMED');
    expect(booking.confirmedAt).toEqual(NOW);
    // Cleared, because the CHECK constraint allows expiresAt only while pending.
    expect(booking.expiresAt).toBeNull();

    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(payment).toMatchObject({
      status: 'SUCCEEDED',
      amountCents: ctx.service30.priceCents,
      stripePaymentIntentId: 'pi_1',
      stripeChargeId: 'ch_1',
    });

    expect(await prisma.managementToken.count({ where: { bookingId } })).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: bookingId, eventType: JOB.BOOKING_CONFIRMED },
      }),
    ).toBe(1);
  });

  it('puts the plaintext token in the outbox payload and only its hash in the table', async () => {
    await seedEvent(
      'checkout.session.completed',
      { id: sessionId, payment_status: 'paid', amount_total: ctx.service30.priceCents },
      'evt_paid',
    );

    await processor.handle({ stripeEventId: 'evt_paid' });

    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: bookingId, eventType: JOB.BOOKING_CONFIRMED },
    });
    const token = (event.payload as { managementToken: string }).managementToken;
    const stored = await prisma.managementToken.findFirstOrThrow({ where: { bookingId } });

    // The email can contain the link; a database read cannot reconstruct it.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.tokenHash).toBe(hashManagementToken(token));
    expect(stored.tokenHash).not.toBe(token);
  });

  it('marks the inbox row processed', async () => {
    await seedEvent(
      'checkout.session.completed',
      { id: sessionId, payment_status: 'paid', amount_total: ctx.service30.priceCents },
      'evt_paid',
    );

    await processor.handle({ stripeEventId: 'evt_paid' });

    const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: 'evt_paid' },
    });
    expect(row.processedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
  });

  it('is idempotent: processing twice changes nothing the second time', async () => {
    await seedEvent(
      'checkout.session.completed',
      { id: sessionId, payment_status: 'paid', amount_total: ctx.service30.priceCents },
      'evt_paid',
    );

    await processor.handle({ stripeEventId: 'evt_paid' });
    // Reset processedAt so the second run reaches confirmation rather than short-
    // circuiting on the cheap guard — the guarantee under test is in confirmPaid.
    await prisma.stripeWebhookEvent.updateMany({ data: { processedAt: null } });
    await processor.handle({ stripeEventId: 'evt_paid' });

    expect(await prisma.payment.count({ where: { bookingId } })).toBe(1);
    expect(await prisma.managementToken.count({ where: { bookingId } })).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: bookingId, eventType: JOB.BOOKING_CONFIRMED },
      }),
    ).toBe(1);
    expect(
      await prisma.bookingStatusHistory.count({ where: { bookingId, toStatus: 'CONFIRMED' } }),
    ).toBe(1);
  });

  it('confirms a booking the expiry saga has already moved to EXPIRING', async () => {
    // The race the two-phase saga exists to make safe: the customer paid while we were
    // asking Stripe to kill the session.
    await prisma.booking.update({ where: { id: bookingId }, data: { status: 'EXPIRING' } });

    await seedEvent(
      'checkout.session.completed',
      { id: sessionId, payment_status: 'paid', amount_total: ctx.service30.priceCents },
      'evt_paid',
    );

    await processor.handle({ stripeEventId: 'evt_paid' });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(
      'CONFIRMED',
    );
  });

  it('does not confirm when payment_status is unpaid', async () => {
    await seedEvent(
      'checkout.session.completed',
      { id: sessionId, payment_status: 'unpaid' },
      'evt_unpaid',
    );

    await processor.handle({ stripeEventId: 'evt_unpaid' });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(
      'PENDING_PAYMENT',
    );
    expect(await prisma.managementToken.count()).toBe(0);
  });

  it('confirms anyway when the amount differs, because the customer has paid', async () => {
    await seedEvent(
      'checkout.session.completed',
      { id: sessionId, payment_status: 'paid', amount_total: ctx.service30.priceCents - 100 },
      'evt_mismatch',
    );

    await processor.handle({ stripeEventId: 'evt_mismatch' });

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId } });

    // Refusing would leave them charged and unbooked, which is strictly worse. The
    // amount actually received is what gets stored.
    expect(booking.status).toBe('CONFIRMED');
    expect(payment.amountCents).toBe(ctx.service30.priceCents - 100);
  });

  it('derives the organization from the booking, never from event metadata', async () => {
    await seedEvent(
      'checkout.session.completed',
      {
        id: sessionId,
        payment_status: 'paid',
        amount_total: ctx.service30.priceCents,
        metadata: { organizationId: 'attacker-org' },
      },
      'evt_meta',
    );

    await processor.handle({ stripeEventId: 'evt_meta' });

    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    const token = await prisma.managementToken.findFirstOrThrow({ where: { bookingId } });

    expect(payment.organizationId).toBe(ctx.organization.id);
    expect(token.organizationId).toBe(ctx.organization.id);
  });

  it('falls back to client_reference_id when no row names the session', async () => {
    // The session was created but the process died before the id reached the database.
    await prisma.booking.update({
      where: { id: bookingId },
      data: { stripeCheckoutSessionId: null },
    });

    await seedEvent(
      'checkout.session.completed',
      {
        id: sessionId,
        client_reference_id: bookingId,
        payment_status: 'paid',
        amount_total: ctx.service30.priceCents,
      },
      'evt_orphan',
    );

    await processor.handle({ stripeEventId: 'evt_orphan' });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(
      'CONFIRMED',
    );
  });
});

describe('failed payments', () => {
  let bookingId: string;
  let sessionId: string;

  beforeEach(async () => {
    ({ bookingId, sessionId } = await bookedSlot());
  });

  it('marks PAYMENT_FAILED when the session expires while still pending', async () => {
    await seedEvent('checkout.session.expired', { id: sessionId }, 'evt_expired');

    await processor.handle({ stripeEventId: 'evt_expired' });

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('PAYMENT_FAILED');
    expect(booking.expiresAt).toBeNull();
  });

  it('records the failure reason, resolving the booking through the payment intent', async () => {
    // `payment_intent.payment_failed` carries a PaymentIntent, so `object.id` is a `pi_…` and
    // no booking is keyed on it. The intent id on the payment row is the handle that resolves.
    await prisma.payment.updateMany({
      where: { bookingId },
      data: { stripePaymentIntentId: 'pi_declined_1' },
    });

    await seedEvent(
      'payment_intent.payment_failed',
      { id: 'pi_declined_1', last_payment_error: { code: 'card_declined', message: 'Declined' } },
      'evt_declined',
    );

    await processor.handle({ stripeEventId: 'evt_declined' });

    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(payment).toMatchObject({
      status: 'FAILED',
      failureCode: 'card_declined',
      failureMessage: 'Declined',
    });
  });

  it('falls back to client_reference_id when no payment names the intent', async () => {
    // The intent failed before any payment row recorded its id. Stripe was given the booking
    // id as `client_reference_id` at session creation, which is the remaining handle.
    await seedEvent(
      'payment_intent.payment_failed',
      {
        id: 'pi_declined_2',
        client_reference_id: bookingId,
        last_payment_error: { code: 'card_declined', message: 'Declined' },
      },
      'evt_declined_2',
    );

    await processor.handle({ stripeEventId: 'evt_declined_2' });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(
      'PAYMENT_FAILED',
    );
  });

  it('leaves a confirmed booking alone when a late failure arrives', async () => {
    await seedEvent(
      'checkout.session.completed',
      { id: sessionId, payment_status: 'paid', amount_total: ctx.service30.priceCents },
      'evt_paid',
    );
    await processor.handle({ stripeEventId: 'evt_paid' });

    await seedEvent('checkout.session.expired', { id: sessionId }, 'evt_late');
    await processor.handle({ stripeEventId: 'evt_late' });

    // Stripe reporting an earlier attempt must not undo a confirmed booking.
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(
      'CONFIRMED',
    );
  });
});

describe('events nothing handles', () => {
  it('stores, marks processed and never retries', async () => {
    await seedEvent('customer.created', { id: 'cus_1' }, 'evt_unknown');

    await processor.handle({ stripeEventId: 'evt_unknown' });

    const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: 'evt_unknown' },
    });

    // Left unprocessed it would be re-enqueued by the reconciler every two minutes
    // forever.
    expect(row.processedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
  });
});

describe('when processing fails', () => {
  it('records the error, leaves the row unprocessed, and rethrows so BullMQ retries', async () => {
    // A paid session matching no booking is money taken for nothing: it must reach a
    // human rather than be swallowed.
    await seedEvent(
      'checkout.session.completed',
      { id: 'cs_fake_ghost', payment_status: 'paid', amount_total: 4500 },
      'evt_ghost',
    );

    await expect(processor.handle({ stripeEventId: 'evt_ghost' })).rejects.toThrow(
      /matches no booking/,
    );

    const row = await prisma.stripeWebhookEvent.findUniqueOrThrow({
      where: { stripeEventId: 'evt_ghost' },
    });
    expect(row.processedAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('matches no booking');
  });

  it('ignores an event that is no longer in the inbox', async () => {
    // Pruned by retention, or the job outlived its row. Throwing would retry forever.
    await expect(processor.handle({ stripeEventId: 'evt_vanished' })).resolves.toBeUndefined();
  });
});
