import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BookingCheckoutService } from '../../src/booking/booking-checkout.service.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { JOB } from '../../src/messaging/queues/job-contracts.js';
import { PUBLIC_WEB_ORIGIN, createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';

import type { Booking } from '../../src/prisma/client.js';
import type { FakePaymentProvider } from '../../src/providers/payment/fake-payment.provider.js';
import type { SeedContext } from '../factories/index.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

const NOW = new Date('2026-08-10T06:00:00.000Z');

let ctx: SeedContext;
let clock: FixedClock;
let server: () => Server;
let payments: FakePaymentProvider;
let app: INestApplication;

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serviceId: ctx.service30.id,
    employeeId: ctx.employee1.id,
    startsAt: SLOT_FRIDAY_0900.toISOString(),
    customer: {
      email: 'anna@example.com',
      firstName: 'Anna',
      lastName: 'Becker',
      phone: '+4915112345678',
    },
    locale: 'de',
    customerNote: 'Erstbesuch',
    successUrl: `${PUBLIC_WEB_ORIGIN}/booking/success`,
    cancelUrl: `${PUBLIC_WEB_ORIGIN}/booking/canceled`,
    ...overrides,
  };
}

const post = (payload: Record<string, unknown> = body(), key: string | null = randomUUID()) => {
  const req = request(server()).post('/public/bookings');
  return key === null ? req.send(payload) : req.set('Idempotency-Key', key).send(payload);
};

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);
  clock = new FixedClock(NOW);

  const testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock,
  });

  server = testApp.server;
  payments = testApp.payments;
  app = testApp.app;

  return testApp.close;
});

describe('a successful booking', () => {
  it('reserves, opens a session, and returns the checkout url', async () => {
    const response = await post().expect(201);
    const created = response.body as Record<string, string> & {
      price: { amountCents: number; currency: string };
    };

    expect(created.status).toBe('PENDING_PAYMENT');
    expect(created.price).toEqual({ amountCents: ctx.service30.priceCents, currency: 'EUR' });
    expect(created.reference).toMatch(/^SF-/);
    expect(created.employeeId).toBe(ctx.employee1.id);
    expect(created.employeeDisplayName).toBe('Mara Vogt');
    expect(created.checkoutUrl).toContain('cs_fake_');
    expect(created.expiresAt).toBe(new Date(NOW.getTime() + 5 * 60_000).toISOString());
  });

  it('attaches the session id and opens a pending payment', async () => {
    const response = await post().expect(201);
    const created = response.body as { bookingId: string; checkoutUrl: string };

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: created.bookingId } });
    expect(booking.stripeCheckoutSessionId).not.toBeNull();
    expect(created.checkoutUrl).toContain(booking.stripeCheckoutSessionId ?? 'never');

    const payment = await prisma.payment.findFirstOrThrow({
      where: { bookingId: created.bookingId },
    });
    expect(payment.status).toBe('PENDING');
    expect(payment.amountCents).toBe(ctx.service30.priceCents);
    expect(payment.stripeCheckoutSessionId).toBe(booking.stripeCheckoutSessionId);
  });

  it('arms the expiry through the outbox, due when the reservation lapses', async () => {
    const response = await post().expect(201);
    const created = response.body as { bookingId: string };

    // Recorded rather than enqueued, so a committed reservation always has something
    // that will release it.
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: created.bookingId, eventType: JOB.BOOKING_EXPIRY_REQUESTED },
    });

    expect(event.availableAt).toEqual(new Date(NOW.getTime() + 5 * 60_000));
    expect(event.dispatchedAt).toBeNull();
  });

  it('quotes, snapshots and charges the employee price override', async () => {
    // The catalog already shows this price. A booking that snapshotted the list price
    // instead would show one number and take another.
    await prisma.employeeService.update({
      where: {
        employeeId_serviceId: { employeeId: ctx.employee1.id, serviceId: ctx.service30.id },
      },
      data: { priceOverrideCents: 9900 },
    });

    const response = await post().expect(201);
    const created = response.body as {
      bookingId: string;
      price: { amountCents: number; currency: string };
    };

    expect(created.price.amountCents).toBe(9900);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: created.bookingId } });
    expect(booking.priceCentsSnapshot).toBe(9900);

    const payment = await prisma.payment.findFirstOrThrow({
      where: { bookingId: created.bookingId },
    });
    expect(payment.amountCents).toBe(9900);
  });

  it('resolves the employee itself when the client does not name one', async () => {
    const response = await post(body({ employeeId: null })).expect(201);
    const created = response.body as { employeeId: string };

    expect([ctx.employee1.id, ctx.employee2.id]).toContain(created.employeeId);
  });

  it('never opens a transaction around the Stripe call', async () => {
    await post().expect(201);

    // The fake records call order. The session is created once, and the two
    // transactions that bracket it are the reservation and the attachment — neither
    // contains it.
    expect(payments.callOrder()).toEqual(['createCheckoutSession']);
  });
});

describe('idempotent replay', () => {
  it('replays the identical response, checkout url included', async () => {
    const key = randomUUID();

    const first = await post(body(), key).expect(201);
    const second = await post(body(), key).expect(201);

    // Byte-identical, which is what puts a reloading customer back on the session they
    // already started rather than a second one they could also pay into.
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(await prisma.booking.count()).toBe(1);
    expect(await payments.sessions()).toHaveLength(1);
  });

  it('rejects the same key with a different body', async () => {
    const key = randomUUID();

    await post(body(), key).expect(201);
    const reused = await post(
      body({ startsAt: new Date(SLOT_FRIDAY_0900.getTime() + 30 * 60_000).toISOString() }),
      key,
    ).expect(422);

    expect(reused.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await prisma.booking.count()).toBe(1);
  });

  it('requires an Idempotency-Key', async () => {
    const missing = await post(body(), null).expect(400);
    expect(missing.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await prisma.booking.count()).toBe(0);
  });

  it('rejects a key that is not a uuid', async () => {
    await post(body(), 'abc').expect(400);
  });
});

describe('a slot somebody else took', () => {
  it('gives the second customer 409 SLOT_UNAVAILABLE', async () => {
    await post().expect(201);

    const second = await post(
      body({ customer: { ...(body().customer as object), email: 'bea@example.com' } }),
    ).expect(409);

    expect(second.body).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(await prisma.booking.count()).toBe(1);
  });
});

describe('input the server does not trust', () => {
  it('rejects a successUrl outside the configured origin', async () => {
    // An unchecked redirect target is an open redirect with our domain's credibility
    // attached, and Stripe is the one doing the redirecting.
    const response = await post(body({ successUrl: 'https://evil.example.com/x' })).expect(400);

    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await prisma.booking.count()).toBe(0);
  });

  it('rejects a cancelUrl that only looks like ours', async () => {
    await post(body({ cancelUrl: `https://evil.example.com/?next=${PUBLIC_WEB_ORIGIN}` })).expect(
      400,
    );
  });

  it('strips an organizationId from the body', async () => {
    const response = await post(body({ organizationId: 'attacker-org' })).expect(201);
    const created = response.body as { bookingId: string };

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: created.bookingId } });
    expect(booking.organizationId).toBe(ctx.organization.id);
  });

  it('rejects a customer note longer than the cap', async () => {
    await post(body({ customerNote: 'x'.repeat(501) })).expect(400);
  });

  it('rejects a slot inside the notice window', async () => {
    const response = await post(
      body({ startsAt: new Date(NOW.getTime() + 60 * 60_000).toISOString() }),
    ).expect(422);

    expect(response.body).toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
  });
});

describe('when Stripe is unreachable', () => {
  it('returns 502, keeps the reservation, and leaves the key reusable', async () => {
    payments.failNextWith(new Error('ECONNRESET'));

    const response = await post().expect(502);
    expect(response.body).toMatchObject({ code: 'INTERNAL_ERROR' });

    // The reservation committed before the call, so it survives — and expires on its
    // own five minutes later.
    const booking = await prisma.booking.findFirstOrThrow();
    expect(booking.status).toBe('PENDING_PAYMENT');
    expect(booking.stripeCheckoutSessionId).toBeNull();

    // Nothing was stored against the key, so the customer's retry actually retries.
    expect(await prisma.idempotencyKey.count({ where: { state: 'COMPLETED' } })).toBe(0);
    expect(await prisma.payment.count()).toBe(0);
  });

  it('does not leak the provider error to the customer', async () => {
    payments.failNextWith(new Error('ECONNRESET reaching api.stripe.com'));

    const response = await post().expect(502);
    expect(JSON.stringify(response.body)).not.toContain('ECONNRESET');
  });

  it('resumes the same reservation after Checkout fails', async () => {
    // The retry the 502 asks the customer for. Without resume it reserves again and
    // collides with its own held slot, so the honest retry is answered
    // SLOT_UNAVAILABLE — the customer is locked out by their own first attempt.
    const key = randomUUID();
    payments.failNextWith(new Error('ECONNRESET'));

    await post(body(), key).expect(502);
    const held = await prisma.booking.findFirstOrThrow();

    const retried = await post(body(), key).expect(201);

    expect((retried.body as { bookingId: string }).bookingId).toBe(held.id);
    expect(await prisma.booking.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    expect(await payments.sessions()).toHaveLength(1);
  });

  it('arms expiry before Checkout answers', async () => {
    // The reservation commits before the provider is called, so the release has to
    // commit with it. Armed in the attachment, a failed Checkout leaves a held slot
    // with nothing scheduled to let it go.
    payments.failNextWith(new Error('ECONNRESET'));
    await post().expect(502);

    const held = await prisma.booking.findFirstOrThrow();
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: held.id, eventType: JOB.BOOKING_EXPIRY_REQUESTED },
      }),
    ).toBe(1);
  });

  it('resumes when the provider answered but the attachment never committed', async () => {
    const key = randomUUID();

    // A narrow test-only cast: `attach` is private, and widening it for a test would
    // publish a method whose whole contract is "only the Checkout path calls this".
    const checkout = app.get(BookingCheckoutService);
    const attach = vi.spyOn(
      checkout as unknown as { attach(booking: Booking, sessionId: string): Promise<void> },
      'attach',
    );
    attach.mockRejectedValueOnce(new Error('database unavailable after provider response'));

    await post(body(), key).expect(502);
    const firstSession = (await payments.sessions())[0];
    expect(firstSession).toBeDefined();

    const retried = await post(body(), key).expect(201);

    expect((retried.body as { checkoutUrl: string }).checkoutUrl).toBe(
      `https://checkout.fake.local/c/pay/${firstSession?.sessionId ?? 'never'}`,
    );
    expect(await prisma.booking.count()).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
    expect(await payments.sessions()).toHaveLength(1);
  });

  it('reuses the session a lost provider response already created', async () => {
    // Stripe created the session and the socket died before the answer arrived. The
    // provider key makes the retry return that same session rather than a second one
    // the customer could also pay into.
    const key = randomUUID();
    payments.failNextCheckoutAfterCreateWith(new Error('socket closed after response'));

    await post(body(), key).expect(502);
    const retried = await post(body(), key).expect(201);

    expect(await payments.sessions()).toHaveLength(1);
    expect((retried.body as { bookingId: string }).bookingId).toBe(
      (await prisma.booking.findFirstOrThrow()).id,
    );
    expect(await prisma.payment.count()).toBe(1);
  });
});

describe('GET /public/bookings/by-session/:checkoutSessionId', () => {
  it('returns the public projection of the booking', async () => {
    const created = await post().expect(201);
    const bookingId = (created.body as { bookingId: string }).bookingId;
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });

    const response = await request(server())
      .get(`/public/bookings/by-session/${booking.stripeCheckoutSessionId ?? ''}`)
      .expect(200);

    expect(response.body).toMatchObject({
      reference: booking.reference,
      status: 'PENDING_PAYMENT',
      employeeDisplayName: 'Mara Vogt',
      serviceName: ctx.service30.name,
      managementUrlIssued: false,
    });
  });

  it('carries no customer data, since a session id is all it takes to read it', async () => {
    const created = await post().expect(201);
    const bookingId = (created.body as { bookingId: string }).bookingId;
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });

    const response = await request(server())
      .get(`/public/bookings/by-session/${booking.stripeCheckoutSessionId ?? ''}`)
      .expect(200);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('anna');
    expect(serialised).not.toContain('@');
    expect(serialised).not.toContain('Becker');
    expect(serialised).not.toContain('Erstbesuch');
  });

  it('404s an unknown session id', async () => {
    const response = await request(server())
      .get('/public/bookings/by-session/cs_fake_nothing')
      .expect(404);

    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });
});
