import { randomUUID } from 'node:crypto';

import {
  officeBookingDetailSchema,
  officeBookingListResponseSchema,
} from '@shape-and-flow/booking-contracts';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module.js';
import { SessionStore } from '../../src/auth/session.store.js';
import { AuditModule } from '../../src/common/audit/audit.module.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { OfficeModule } from '../../src/office/office.module.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { makeBooking, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { queues, redis } from '../redis.harness.js';

import type { BookingStatus, OfficeUserRole } from '../../src/prisma/client.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/**
 * The office's write surface over bookings and money.
 *
 * The clock is fixed to 20:00Z — 22:00 in Berlin — for the reason the other office
 * suites fix it there: anything reasoning about a day in UTC lands on the wrong side of
 * a boundary, and a round hour would let it pass.
 *
 * `NEXT_MONDAY` is the seeded rota's next working day after `NOW`, and everything that
 * needs a bookable slot uses it. Booking into "tomorrow" would be a Saturday, which the
 * seeded Mon–Fri week does not cover — and the failure would look like a bug in the
 * office path rather than in the fixture.
 */

const NOW = new Date('2026-08-14T20:00:00.000Z');
const NEXT_MONDAY = '2026-08-17';
const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;

let ctx: SeedContext;
let testApp: BookingTestApp;
let server: () => Server;
let sessions: SessionStore;
let userCounter = 0;

interface Agent {
  cookie: string;
  officeUserId: string;
  get: (path: string) => request.Test;
  post: (path: string) => request.Test;
  patch: (path: string) => request.Test;
}

/**
 * A signed-in office user.
 *
 * The cookie is carried by hand rather than through `request.agent()`: an agent keeps a
 * keep-alive socket open past `app.close()`, and the stray connection then blocks the
 * next file's TRUNCATE. That cost hours once already.
 */
async function signedInAs(
  role: OfficeUserRole,
  options: { employeeId?: string | null; canIssueRefunds?: boolean } = {},
): Promise<Agent> {
  userCounter += 1;
  const employeeId = options.employeeId ?? null;
  const canIssueRefunds = options.canIssueRefunds ?? true;

  const user = await prisma.officeUser.create({
    data: {
      organizationId: ctx.organization.id,
      email: `${role.toLowerCase()}-${String(userCounter)}@shape-and-flow.example`,
      passwordHash: 'placeholder-not-a-credential',
      firstName: 'Test',
      lastName: role,
      role,
      canIssueRefunds,
      ...(employeeId === null ? {} : { employeeId }),
    },
    select: { id: true },
  });

  const sid = await sessions.create({
    id: user.id,
    organizationId: ctx.organization.id,
    role,
    canIssueRefunds,
    employeeId,
  });

  const cookie = `sf_office_session=${sid}`;
  const call = (method: 'get' | 'post' | 'patch', path: string) =>
    request(server())
      [method](path)
      .set('Cookie', cookie)
      .set(...CSRF);

  return {
    cookie,
    officeUserId: user.id,
    get: (path) => call('get', path),
    post: (path) => call('post', path),
    patch: (path) => call('patch', path),
  };
}

/** Berlin wall clock on a local date, as an instant. August is UTC+2. */
function berlin(date: string, hourMinute: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = hourMinute.split(':').map(Number);

  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, (hour ?? 0) - 2, minute ?? 0));
}

function manualBookingBody(overrides: Record<string, unknown> = {}) {
  return {
    serviceId: ctx.service30.id,
    employeeId: ctx.employee1.id,
    startsAt: berlin(NEXT_MONDAY, '10:00').toISOString(),
    customer: {
      email: 'telefon@example.com',
      firstName: 'Jonas',
      lastName: 'Keller',
      phone: '+4915199999999',
    },
    ...overrides,
  };
}

async function bookingAt(
  startsAt: Date,
  overrides: { status?: BookingStatus; employeeId?: string; serviceId?: string } = {},
): Promise<{ id: string; reference: string; startsAt: Date; endsAt: Date }> {
  const status = overrides.status ?? 'CONFIRMED';

  return await prisma.booking.create({
    data: {
      ...makeBooking(ctx, {
        status,
        startsAt,
        expiresAt: status === 'PENDING_PAYMENT' || status === 'EXPIRING' ? startsAt : null,
        ...(overrides.employeeId === undefined ? {} : { employeeId: overrides.employeeId }),
        ...(overrides.serviceId === undefined ? {} : { serviceId: overrides.serviceId }),
      }),
      ...(status === 'CONFIRMED' ? { confirmedAt: NOW } : {}),
    },
    select: { id: true, reference: true, startsAt: true, endsAt: true },
  });
}

/** A succeeded card payment, so a refund has something to come out of. */
async function paidWithCard(bookingId: string, amountCents: number): Promise<void> {
  await prisma.payment.create({
    data: {
      organizationId: ctx.organization.id,
      bookingId,
      stripeCheckoutSessionId: `cs_test_${bookingId}`,
      stripePaymentIntentId: `pi_test_${bookingId}`,
      amountCents,
      currency: 'EUR',
      status: 'SUCCEEDED',
      paidAt: NOW,
    },
  });
}

async function clearSessions(): Promise<void> {
  const keys = await redis.keys('session:*');
  if (keys.length > 0) await redis.del(...keys);
}

beforeEach(async () => {
  await resetDatabase();
  await clearSessions();

  ctx = await seedOrganization(prisma);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock: new FixedClock(NOW),
    extraImports: [AuthModule, AuditModule, OfficeModule],
    redis,
    queues,
    globalPrefix: 'api',
  });

  server = testApp.server;
  sessions = testApp.app.get(SessionStore);

  return testApp.close;
});

/* ── manual booking ───────────────────────────────────────────────────────────── */

describe('POST /api/office/bookings', () => {
  it('creates a CONFIRMED booking with no payment and no checkout session', async () => {
    const owner = await signedInAs('OWNER');

    const response = await owner
      .post('/api/office/bookings')
      .set('Idempotency-Key', randomUUID())
      .send(manualBookingBody())
      .expect(201);

    const { bookingId } = response.body as { bookingId: string };
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });

    expect(booking).toMatchObject({
      status: 'CONFIRMED',
      origin: 'OFFICE',
      stripeCheckoutSessionId: null,
      expiresAt: null,
    });
    expect(booking.createdByOfficeUserId).toBe(owner.officeUserId);
    expect(booking.confirmedAt).not.toBeNull();

    // No money was taken: the customer is standing at the desk, not on a payment page.
    expect(await prisma.payment.count({ where: { bookingId } })).toBe(0);
    expect(await testApp.payments.sessions()).toHaveLength(0);
  });

  it('obeys the same collision rules as an online booking', async () => {
    const owner = await signedInAs('OWNER');

    await owner
      .post('/api/office/bookings')
      .set('Idempotency-Key', randomUUID())
      .send(manualBookingBody())
      .expect(201);

    // The same slot, the same employee — refused by the same advisory lock and the same
    // exclusion constraint the public path meets, because it is the same code.
    const clash = await owner
      .post('/api/office/bookings')
      .set('Idempotency-Key', randomUUID())
      .send(manualBookingBody())
      .expect(409);

    expect((clash.body as { code: string }).code).toBe('SLOT_UNAVAILABLE');
  });

  it('may ignore the minimum-notice window, which the public route may not', async () => {
    const owner = await signedInAs('OWNER');
    // Monday 09:00 is 59 hours away, so widen the notice window first. The office is
    // allowed to take a booking somebody just phoned about even though a customer is not.
    await owner.patch('/api/office/settings').send({ minimumNoticeHours: 72 }).expect(200);
    const soon = berlin(NEXT_MONDAY, '09:00');

    await owner
      .post('/api/office/bookings')
      .set('Idempotency-Key', randomUUID())
      .send(manualBookingBody({ startsAt: soon.toISOString() }))
      .expect(201);
  });

  it('still refuses a slot outside the rota', async () => {
    const owner = await signedInAs('OWNER');

    // 20:00 on a Monday, after the 18:00 shift ends. Ignoring notice is the one rule the
    // office path relaxes; the working week is not one of them.
    const response = await owner
      .post('/api/office/bookings')
      .set('Idempotency-Key', randomUUID())
      .send(manualBookingBody({ startsAt: berlin(NEXT_MONDAY, '20:00').toISOString() }))
      .expect(409);

    expect((response.body as { code: string }).code).toBe('SLOT_UNAVAILABLE');
  });

  it('replays under the same idempotency key', async () => {
    const owner = await signedInAs('OWNER');
    const key = randomUUID();

    const first = await owner
      .post('/api/office/bookings')
      .set('Idempotency-Key', key)
      .send(manualBookingBody())
      .expect(201);
    const second = await owner
      .post('/api/office/bookings')
      .set('Idempotency-Key', key)
      .send(manualBookingBody())
      .expect(201);

    expect(second.body).toEqual(first.body);
    expect(await prisma.booking.count()).toBe(1);
  });

  it('queues a confirmation, because the booking is confirmed on creation', async () => {
    const owner = await signedInAs('OWNER');

    const response = await owner
      .post('/api/office/bookings')
      .set('Idempotency-Key', randomUUID())
      .send(manualBookingBody())
      .expect(201);

    const { bookingId } = response.body as { bookingId: string };

    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: bookingId, eventType: 'booking.confirmed' },
      }),
    ).toBe(1);

    // And a management token, so the customer's email can carry a link to their own
    // appointment — the same thing the webhook path mints on confirmation.
    expect(await prisma.managementToken.count({ where: { bookingId } })).toBe(1);
  });

  it('attaches to an existing customer by id', async () => {
    const owner = await signedInAs('OWNER');

    const response = await owner
      .post('/api/office/bookings')
      .set('Idempotency-Key', randomUUID())
      .send(manualBookingBody({ customer: { customerId: ctx.customer.id } }))
      .expect(201);

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: (response.body as { bookingId: string }).bookingId },
    });

    expect(booking.customerId).toBe(ctx.customer.id);
    expect(await prisma.customer.count()).toBe(1);
  });

  it('is closed to an EMPLOYEE', async () => {
    const employee = await signedInAs('EMPLOYEE', { employeeId: ctx.employee1.id });

    await employee
      .post('/api/office/bookings')
      .set('Idempotency-Key', randomUUID())
      .send(manualBookingBody())
      .expect(403);
  });
});

/* ── manual payments ──────────────────────────────────────────────────────────── */

describe('manual payments', () => {
  it('records amount, method, actor and timestamp', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    await owner
      .post(`/api/office/bookings/${booking.id}/manual-payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 4500, method: 'CASH', note: 'bar bezahlt' })
      .expect(201);

    expect(
      await prisma.manualPayment.findFirstOrThrow({ where: { bookingId: booking.id } }),
    ).toMatchObject({
      amountCents: 4500,
      method: 'CASH',
      recordedByOfficeUserId: owner.officeUserId,
      note: 'bar bezahlt',
    });
  });

  it('does not double-count under a replayed key', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    const key = randomUUID();
    const body = { amountCents: 4500, method: 'CASH' as const };

    await owner
      .post(`/api/office/bookings/${booking.id}/manual-payments`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    await owner
      .post(`/api/office/bookings/${booking.id}/manual-payments`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    // A retry at a busy desk must not record the same fifty euros twice — and the second
    // one would be indistinguishable from a genuine second payment.
    expect(await prisma.manualPayment.count({ where: { bookingId: booking.id } })).toBe(1);
  });

  it('accepts a negative correction only with a note', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    await owner
      .post(`/api/office/bookings/${booking.id}/manual-payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: -4500, method: 'CASH' })
      .expect(400);

    await owner
      .post(`/api/office/bookings/${booking.id}/manual-payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: -4500, method: 'CASH', note: 'Fehlbuchung korrigiert' })
      .expect(201);
  });

  it('refuses a payment of zero', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    await owner
      .post(`/api/office/bookings/${booking.id}/manual-payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 0, method: 'CASH', note: 'nichts' })
      .expect(400);
  });

  it('requires an Idempotency-Key', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    // A mutation that moves money has no safe behaviour when retried without one.
    await owner
      .post(`/api/office/bookings/${booking.id}/manual-payments`)
      .send({ amountCents: 4500, method: 'CASH' })
      .expect(400);
  });

  it('shows up in the booking as paid, and leaves an audit row', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    await owner
      .post(`/api/office/bookings/${booking.id}/manual-payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 2000, method: 'CARD' })
      .expect(201);

    const detail = await owner.get(`/api/office/bookings/${booking.id}`).expect(200);
    const body = officeBookingDetailSchema.parse(detail.body);

    // Part-paid, which is exactly the case a boolean flag could not express.
    expect(body.paid.amountCents).toBe(2000);
    expect(body.price.amountCents).toBe(ctx.service30.priceCents);

    expect(
      await prisma.auditLog.count({ where: { action: 'MANUAL_PAYMENT_RECORDED' } }),
    ).toBeGreaterThan(0);
  });
});

/* ── refunds and status changes ───────────────────────────────────────────────── */

describe('refunds', () => {
  it('is refused to an admin without the capability', async () => {
    const admin = await signedInAs('ADMIN', { canIssueRefunds: false });
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    await paidWithCard(booking.id, ctx.service30.priceCents);

    const response = await admin
      .post(`/api/office/bookings/${booking.id}/refunds`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 1000, reason: 'GOODWILL' })
      .expect(403);

    expect((response.body as { code: string }).code).toBe('FORBIDDEN_ROLE');
  });

  it('is allowed to an admin who has it, and appears in the history', async () => {
    const admin = await signedInAs('ADMIN', { canIssueRefunds: true });
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    await paidWithCard(booking.id, ctx.service30.priceCents);

    await admin
      .post(`/api/office/bookings/${booking.id}/refunds`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 1000, reason: 'GOODWILL' })
      .expect(201);

    const history = await admin.get(`/api/office/bookings/${booking.id}/refunds`).expect(200);
    const body = history.body as {
      items: { amountCents?: number; amount: { amountCents: number } }[];
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.amount.amountCents).toBe(1000);
  });
});

describe('cancel, complete and no-show', () => {
  it('lets an admin without the capability cancel without a refund', async () => {
    const admin = await signedInAs('ADMIN', { canIssueRefunds: false });
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    // Cancelling is scheduling; refunding is finance. Conflating them would mean an
    // admin who may not move money also may not free a slot.
    await admin
      .post(`/api/office/bookings/${booking.id}/cancel`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Mitarbeiterin krank' })
      .expect(201);

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('CANCELED_BY_BUSINESS');
  });

  it('refuses a cancellation carrying a refund without the capability', async () => {
    const admin = await signedInAs('ADMIN', { canIssueRefunds: false });
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    await paidWithCard(booking.id, ctx.service30.priceCents);

    await admin
      .post(`/api/office/bookings/${booking.id}/cancel`)
      .set('Idempotency-Key', randomUUID())
      .send({ reason: 'Mitarbeiterin krank', refund: { amountCents: 4500 } })
      .expect(403);

    // Refused before anything happened, not half-way through.
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.status).toBe('CONFIRMED');
  });

  it('replays a refunding cancellation without creating a second money move', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    await paidWithCard(booking.id, ctx.service30.priceCents);
    const key = randomUUID();
    const body = { reason: 'Mitarbeiterin krank', refund: { amountCents: 4500 } };

    const first = await owner
      .post(`/api/office/bookings/${booking.id}/cancel`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const second = await owner
      .post(`/api/office/bookings/${booking.id}/cancel`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(second.body).toEqual(first.body);
    expect(await prisma.refund.count({ where: { bookingId: booking.id } })).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateType: 'Refund', eventType: 'refund.requested' },
      }),
    ).toBe(1);
  });

  it('completes a past appointment and refuses a future one', async () => {
    const owner = await signedInAs('OWNER');
    const past = await bookingAt(new Date(NOW.getTime() - 3 * 3_600_000));
    const future = await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    await owner.post(`/api/office/bookings/${past.id}/complete`).expect(201);
    await owner.post(`/api/office/bookings/${future.id}/complete`).expect(422);

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: past.id } })).status).toBe(
      'COMPLETED',
    );
  });

  it('scopes an EMPLOYEE to their own bookings with 404, not 403', async () => {
    const employee = await signedInAs('EMPLOYEE', { employeeId: ctx.employee1.id });
    const other = await bookingAt(new Date(NOW.getTime() - 3 * 3_600_000), {
      employeeId: ctx.employee2.id,
    });

    // 404 rather than 403, so the refusal does not confirm the id exists.
    const response = await employee.post(`/api/office/bookings/${other.id}/complete`).expect(404);

    expect((response.body as { code: string }).code).toBe('NOT_FOUND');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      'CONFIRMED',
    );
  });
});

/* ── listing ──────────────────────────────────────────────────────────────────── */

describe('listing, filtering, pagination', () => {
  it('returns the published shape', async () => {
    const owner = await signedInAs('OWNER');
    await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    const response = await owner.get('/api/office/bookings').expect(200);
    officeBookingListResponseSchema.parse(response.body);
  });

  it('filters by status, employee and date range, and sorts deterministically', async () => {
    const owner = await signedInAs('OWNER');
    await bookingAt(berlin(NEXT_MONDAY, '10:00'), { employeeId: ctx.employee1.id });
    await bookingAt(berlin(NEXT_MONDAY, '11:00'), { employeeId: ctx.employee2.id });
    await bookingAt(berlin(NEXT_MONDAY, '14:00'), {
      employeeId: ctx.employee1.id,
      status: 'EXPIRED',
    });

    const response = await owner
      .get('/api/office/bookings')
      .query({
        status: 'CONFIRMED',
        employeeId: ctx.employee1.id,
        from: '2026-08-01',
        to: '2026-08-31',
        sort: 'startsAt:asc',
      })
      .expect(200);

    const items = (response.body as { items: { startsAt: string; employeeId: string }[] }).items;
    const times = items.map((booking) => booking.startsAt);

    expect(items).toHaveLength(1);
    expect(times).toEqual([...times].sort());
    for (const booking of items) expect(booking.employeeId).toBe(ctx.employee1.id);
  });

  it('paginates by a stable cursor with no duplicates or gaps', async () => {
    const owner = await signedInAs('OWNER');
    await seedBookings(55);

    const seen: string[] = [];
    let cursor: string | undefined;

    do {
      const response = await owner
        .get('/api/office/bookings')
        .query({ limit: 10, ...(cursor === undefined ? {} : { cursor }) })
        .expect(200);

      const page = response.body as { items: { id: string }[]; nextCursor: string | null };
      seen.push(...page.items.map((booking) => booking.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(55);
  });

  it('does not lose rows that tie on the sort column', async () => {
    const owner = await signedInAs('OWNER');
    // Three bookings for three employees at the same instant would tie; two is enough,
    // and the seed only has two employees. A cursor without the id tie-break drops the
    // second one silently.
    const at = berlin(NEXT_MONDAY, '10:00');
    await bookingAt(at, { employeeId: ctx.employee1.id });
    await bookingAt(at, { employeeId: ctx.employee2.id });

    const first = await owner
      .get('/api/office/bookings')
      .query({ limit: 1, sort: 'startsAt:asc' })
      .expect(200);
    const page1 = first.body as { items: { id: string }[]; nextCursor: string | null };

    const second = await owner
      .get('/api/office/bookings')
      .query({ limit: 1, sort: 'startsAt:asc', cursor: page1.nextCursor ?? '' })
      .expect(200);
    const page2 = second.body as { items: { id: string }[] };

    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
  });

  it('rejects a limit above 100, an unknown sort key and a malformed cursor', async () => {
    const owner = await signedInAs('OWNER');

    await owner.get('/api/office/bookings').query({ limit: 500 }).expect(400);
    await owner.get('/api/office/bookings').query({ sort: 'priceCentsSnapshot:desc' }).expect(400);
    // A hand-edited cursor is a client error, not the 500 a bare JSON.parse would give.
    await owner.get('/api/office/bookings').query({ cursor: 'not-a-cursor' }).expect(400);
  });

  it('searches by reference, customer last name and email', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    for (const q of [booking.reference, 'Becker', 'anna@example.com']) {
      const response = await owner.get('/api/office/bookings').query({ q }).expect(200);
      const ids = (response.body as { items: { id: string }[] }).items.map((row) => row.id);

      expect(ids, q).toContain(booking.id);
    }
  });

  it('keeps the booking search filter on later cursor pages', async () => {
    const owner = await signedInAs('OWNER');
    const otherCustomer = await prisma.customer.create({
      data: {
        organizationId: ctx.organization.id,
        email: 'other@example.com',
        emailNormalized: 'other@example.com',
        firstName: 'Other',
        lastName: 'Person',
        locale: 'de',
      },
    });

    const matchingFirst = await bookingAt(berlin(NEXT_MONDAY, '09:00'));
    await prisma.booking.create({
      data: makeBooking(ctx, {
        status: 'CONFIRMED',
        startsAt: berlin(NEXT_MONDAY, '10:00'),
        customerId: otherCustomer.id,
        expiresAt: null,
      }),
    });
    const matchingSecond = await bookingAt(berlin(NEXT_MONDAY, '11:00'));

    const first = await owner
      .get('/api/office/bookings')
      .query({ q: 'Becker', limit: 1, sort: 'startsAt:asc' })
      .expect(200);
    const page1 = first.body as { items: { id: string }[]; nextCursor: string | null };

    const second = await owner
      .get('/api/office/bookings')
      .query({ q: 'Becker', limit: 1, sort: 'startsAt:asc', cursor: page1.nextCursor ?? '' })
      .expect(200);
    const page2 = second.body as { items: { id: string }[] };

    expect(page1.items.map((row) => row.id)).toEqual([matchingFirst.id]);
    expect(page2.items.map((row) => row.id)).toEqual([matchingSecond.id]);
  });

  it('shows an EMPLOYEE only their own bookings', async () => {
    const employee = await signedInAs('EMPLOYEE', { employeeId: ctx.employee1.id });
    await bookingAt(berlin(NEXT_MONDAY, '10:00'), { employeeId: ctx.employee1.id });
    await bookingAt(berlin(NEXT_MONDAY, '11:00'), { employeeId: ctx.employee2.id });

    const response = await employee.get('/api/office/bookings').expect(200);
    const items = (response.body as { items: { employeeId: string }[] }).items;

    expect(items).toHaveLength(1);
    expect(items[0]?.employeeId).toBe(ctx.employee1.id);
  });
});

/* ── customers ────────────────────────────────────────────────────────────────── */

describe('customers', () => {
  it('lists, searches and shows a profile with history', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    await paidWithCard(booking.id, 4500);

    const list = await owner.get('/api/office/customers').query({ q: 'Becker' }).expect(200);
    expect((list.body as { items: { id: string }[] }).items[0]?.id).toBe(ctx.customer.id);

    const detail = await owner.get(`/api/office/customers/${ctx.customer.id}`).expect(200);
    const body = detail.body as {
      bookings: { id: string }[];
      lifetimeValue: { amountCents: number };
    };

    expect(body.bookings.map((row) => row.id)).toContain(booking.id);
    expect(body.lifetimeValue.amountCents).toBe(4500);
  });

  it('keeps the customer search filter on later cursor pages', async () => {
    const owner = await signedInAs('OWNER');
    const base = NOW.getTime();

    await prisma.customer.createMany({
      data: [
        {
          organizationId: ctx.organization.id,
          email: 'match-new@example.com',
          emailNormalized: 'match-new@example.com',
          firstName: 'Match',
          lastName: 'Newest',
          locale: 'de',
          createdAt: new Date(base + 3_000),
        },
        {
          organizationId: ctx.organization.id,
          email: 'other-middle@example.com',
          emailNormalized: 'other-middle@example.com',
          firstName: 'Other',
          lastName: 'Middle',
          locale: 'de',
          createdAt: new Date(base + 2_000),
        },
        {
          organizationId: ctx.organization.id,
          email: 'match-old@example.com',
          emailNormalized: 'match-old@example.com',
          firstName: 'Match',
          lastName: 'Oldest',
          locale: 'de',
          createdAt: new Date(base + 1_000),
        },
      ],
    });

    const first = await owner
      .get('/api/office/customers')
      .query({ q: 'match', limit: 1 })
      .expect(200);
    const page1 = first.body as { items: { email: string }[]; nextCursor: string | null };
    const second = await owner
      .get('/api/office/customers')
      .query({ q: 'match', limit: 1, cursor: page1.nextCursor ?? '' })
      .expect(200);
    const page2 = second.body as { items: { email: string }[] };

    expect(page1.items[0]?.email).toBe('match-new@example.com');
    expect(page2.items[0]?.email).toBe('match-old@example.com');
  });

  it('pseudonymises on erase, keeping the bookings', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    const response = await owner.post(`/api/office/customers/${ctx.customer.id}/erase`).expect(201);

    expect((response.body as { bookingsRetained: number }).bookingsRetained).toBe(1);

    const erased = await prisma.customer.findUniqueOrThrow({ where: { id: ctx.customer.id } });
    expect(erased.lastName).toBe('Customer');
    expect(erased.email).not.toContain('example.com');
    expect(erased.phone).toBeNull();
    expect(erased.archivedAt).not.toBeNull();

    // The booking survives: it is the business's record of what it sold and owes tax on.
    const kept = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(kept.customerId).toBe(ctx.customer.id);

    // And the one audit row that outlives its subject.
    expect(await prisma.auditLog.count({ where: { action: 'CUSTOMER_ERASED' } })).toBe(1);
  });

  it('refuses to erase while a refund is unsettled', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    await paidWithCard(booking.id, 4500);

    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
    await prisma.refund.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        paymentId: payment.id,
        amountCents: 1000,
        currency: 'EUR',
        status: 'PENDING',
        reason: 'GOODWILL',
        idempotencyKey: randomUUID(),
      },
    });

    // A pending refund has a destination. Erasing the person it is going to is not a
    // thing to do while the money is still moving.
    await owner.post(`/api/office/customers/${ctx.customer.id}/erase`).expect(409);
  });

  it('keeps erase to an OWNER', async () => {
    const admin = await signedInAs('ADMIN');

    await admin.post(`/api/office/customers/${ctx.customer.id}/erase`).expect(403);
  });
});

/* ── audit log ────────────────────────────────────────────────────────────────── */

describe('GET /api/office/audit-log', () => {
  it('is filterable and OWNER-only', async () => {
    const owner = await signedInAs('OWNER');
    const admin = await signedInAs('ADMIN');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    await owner
      .post(`/api/office/bookings/${booking.id}/manual-payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 4500, method: 'CASH' })
      .expect(201);

    const response = await owner
      .get('/api/office/audit-log')
      .query({ action: 'MANUAL_PAYMENT_RECORDED' })
      .expect(200);

    const items = (response.body as { items: { action: string; officeUserName: string | null }[] })
      .items;

    expect(items.length).toBeGreaterThan(0);
    for (const entry of items) expect(entry.action).toBe('MANUAL_PAYMENT_RECORDED');
    expect(items[0]?.officeUserName).toBe('Test OWNER');

    await admin.get('/api/office/audit-log').expect(403);
  });
});

/* ── CSV export ───────────────────────────────────────────────────────────────── */

describe('the audit trail', () => {
  it('writes exactly one row per booking status change', async () => {
    // The service writes its row inside the transaction that changes the booking, and the
    // interceptor wrote a second one afterwards. Two rows for one action means an auditor
    // reading a count sees twice the activity, and the two disagree about the summary.
    const owner = await signedInAs('OWNER');

    for (const [path, action] of [
      ['cancel', 'BOOKING_CANCELED'],
      ['complete', 'BOOKING_MARKED_COMPLETED'],
      ['no-show', 'BOOKING_MARKED_NO_SHOW'],
    ] as const) {
      const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
      // Completing and no-showing need the appointment to be over.
      await prisma.booking.update({
        where: { id: booking.id },
        data: { startsAt: berlin('2026-08-13', '10:00'), endsAt: berlin('2026-08-13', '10:30') },
      });

      const request = owner.post(`/api/office/bookings/${booking.id}/${path}`);
      if (path === 'cancel') request.set('Idempotency-Key', randomUUID());

      await request.send(path === 'cancel' ? { reason: 'Krankheit' } : {}).expect(201);

      expect(await prisma.auditLog.count({ where: { action, entityId: booking.id } }), action).toBe(
        1,
      );
    }
  });

  it('names the created booking, not the path, on a manual booking', async () => {
    // There is no `:id` in the path and the response field is `bookingId`, not `id`, so
    // the interceptor fell through to the placeholder and wrote a row pointing at "-".
    const owner = await signedInAs('OWNER');

    const created = await owner
      .post('/api/office/bookings')
      .set('Idempotency-Key', randomUUID())
      .send(manualBookingBody())
      .expect(201);

    expect(
      await prisma.auditLog.findFirstOrThrow({ where: { action: 'BOOKING_CREATED_MANUALLY' } }),
    ).toMatchObject({ entityId: (created.body as { bookingId: string }).bookingId });
  });

  it('names the refund, not the booking, on a refund', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    await paidWithCard(booking.id, 4500);

    const refunded = await owner
      .post(`/api/office/bookings/${booking.id}/refunds`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 1000, reason: 'GOODWILL' })
      .expect(201);

    expect(
      await prisma.auditLog.findFirstOrThrow({ where: { action: 'REFUND_ISSUED' } }),
    ).toMatchObject({
      entityId: (refunded.body as { refundId: string }).refundId,
      entityType: 'Refund',
    });
  });
});

describe('deciding a cancellation request without the refund capability', () => {
  /** A pending request whose frozen suggestion decides whether money will move. */
  async function openCancellationRequest(suggestedRetainedAmountCents: number): Promise<string> {
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    await paidWithCard(booking.id, 4500);

    const request = await prisma.cancellationRequest.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        suggestedRetainedAmountCents,
      },
      select: { id: true },
    });

    return request.id;
  }

  it('allows full retention even when the body omits the amount', async () => {
    // Keeping everything moves no money, so it needs no refund capability. Treating an
    // omitted amount as zero made the most common approval — accept the suggestion —
    // look like a full refund and refused it.
    const admin = await signedInAs('ADMIN', { canIssueRefunds: false });
    const requestId = await openCancellationRequest(4500);

    await admin
      .post(`/api/office/cancellation-requests/${requestId}/decide`)
      .send({ decision: 'APPROVED' })
      .expect(201);

    expect(await prisma.refund.count()).toBe(0);
  });

  it('refuses when the suggestion leaves money to refund', async () => {
    const admin = await signedInAs('ADMIN', { canIssueRefunds: false });
    const requestId = await openCancellationRequest(1000);

    await admin
      .post(`/api/office/cancellation-requests/${requestId}/decide`)
      .send({ decision: 'APPROVED' })
      .expect(403);

    expect(await prisma.refund.count()).toBe(0);
    expect(
      (await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: requestId } })).decision,
    ).toBe('PENDING');
  });
});

describe('a booking that has been rescheduled twice', () => {
  /** A replacement in a chain: rescheduled from one booking, financially rooted at another. */
  async function replacementOf(
    previousId: string,
    rootId: string,
    startsAt: Date,
    status: BookingStatus,
  ): Promise<{ id: string }> {
    return await prisma.booking.create({
      data: {
        ...makeBooking(ctx, { status, startsAt, expiresAt: null }),
        ...(status === 'CONFIRMED' ? { confirmedAt: NOW } : {}),
        rescheduledFromBookingId: previousId,
        financialRootBookingId: rootId,
      },
      select: { id: true },
    });
  }

  it('shows the office the payment that is still on the original booking', async () => {
    const owner = await signedInAs('OWNER');

    const original = await bookingAt(berlin(NEXT_MONDAY, '10:00'), {
      status: 'CANCELED_BY_BUSINESS',
    });
    await paidWithCard(original.id, ctx.service30.priceCents);

    const first = await replacementOf(
      original.id,
      original.id,
      berlin(NEXT_MONDAY, '12:00'),
      'CANCELED_BY_BUSINESS',
    );
    const second = await replacementOf(
      first.id,
      original.id,
      berlin(NEXT_MONDAY, '14:00'),
      'CONFIRMED',
    );

    const detail = officeBookingDetailSchema.parse(
      (await owner.get(`/api/office/bookings/${second.id}`).expect(200)).body,
    );

    expect(detail.payments).toHaveLength(1);
    expect(detail.payments[0]?.status).toBe('SUCCEEDED');
    expect(detail.paid.amountCents).toBe(ctx.service30.priceCents);
  });

  it('counts a manual payment recorded on an earlier link exactly once', async () => {
    const owner = await signedInAs('OWNER');

    const original = await bookingAt(berlin(NEXT_MONDAY, '10:00'), {
      status: 'CANCELED_BY_BUSINESS',
    });
    const first = await replacementOf(
      original.id,
      original.id,
      berlin(NEXT_MONDAY, '12:00'),
      'CANCELED_BY_BUSINESS',
    );

    await owner
      .post(`/api/office/bookings/${first.id}/manual-payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 4500, method: 'CASH' })
      .expect(201);

    const second = await replacementOf(
      first.id,
      original.id,
      berlin(NEXT_MONDAY, '14:00'),
      'CONFIRMED',
    );

    const detail = officeBookingDetailSchema.parse(
      (await owner.get(`/api/office/bookings/${second.id}`).expect(200)).body,
    );

    expect(detail.manualPayments).toHaveLength(1);
    expect(detail.paid.amountCents).toBe(4500);

    const csv = await owner
      .get('/api/office/exports/bookings.csv')
      .query({ from: '2026-08-01', to: '2026-08-31' })
      .expect(200);

    const latestLine = csv.text
      .split('\r\n')
      .find((line) => line.includes(';CONFIRMED;') && line.includes('45,00'));
    expect(latestLine).toBeDefined();
  });
});

describe('CSV export', () => {
  it('streams semicolon-delimited utf-8 with a BOM', async () => {
    const owner = await signedInAs('OWNER');
    await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    const response = await owner
      .get('/api/office/exports/bookings.csv')
      .query({ from: '2026-08-01', to: '2026-08-31' })
      .expect(200);

    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');
    // The BOM is what makes Excel read the file as UTF-8 rather than the system code page.
    expect(response.text.charCodeAt(0)).toBe(0xfeff);
    expect(response.text.split('\r\n')[0]).toContain(';');
  });

  it('neutralises a formula-injection attempt in a customer name', async () => {
    const owner = await signedInAs('OWNER');
    await prisma.customer.update({
      where: { id: ctx.customer.id },
      data: { lastName: '=cmd|calc' },
    });
    await bookingAt(berlin(NEXT_MONDAY, '10:00'));

    const response = await owner
      .get('/api/office/exports/bookings.csv')
      .query({ from: '2026-08-01', to: '2026-08-31' })
      .expect(200);

    // A surname is not a place a spreadsheet should execute anything.
    expect(response.text).toContain("'=cmd|calc");
    expect(response.text).not.toMatch(/;=cmd/);
  });

  it('excludes the customer note unless explicitly requested', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    await prisma.booking.update({
      where: { id: booking.id },
      data: { customerNote: 'Erstbesuch' },
    });

    const without = await owner
      .get('/api/office/exports/bookings.csv')
      .query({ from: '2026-08-01', to: '2026-08-31' })
      .expect(200);
    expect(without.text).not.toContain('Erstbesuch');

    const withNotes = await owner
      .get('/api/office/exports/bookings.csv')
      .query({ from: '2026-08-01', to: '2026-08-31', includeCustomerNote: 'true' })
      .expect(200);
    expect(withNotes.text).toContain('Erstbesuch');
  });

  it('exports payments, manual payments and refunds as one ledger', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    await paidWithCard(booking.id, 4500);
    await owner
      .post(`/api/office/bookings/${booking.id}/manual-payments`)
      .set('Idempotency-Key', randomUUID())
      .send({ amountCents: 500, method: 'CASH' })
      .expect(201);

    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
    await prisma.refund.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        paymentId: payment.id,
        amountCents: 1000,
        currency: 'EUR',
        status: 'SUCCEEDED',
        reason: 'GOODWILL',
        idempotencyKey: randomUUID(),
        requestedAt: NOW,
        settledAt: NOW,
      },
    });

    const response = await owner
      .get('/api/office/exports/payments.csv')
      .query({ from: '2026-08-01', to: '2026-08-31' })
      .expect(200);

    expect(response.text.split('\r\n')[0]).toContain('kind');
    for (const kind of ['STRIPE', 'MANUAL', 'REFUND']) {
      expect(response.text, kind).toContain(kind);
    }
    // Refunds are negative, because that is the direction the money went.
    expect(response.text).toContain('-10,00');
  });

  it('files a refund under the month it settled in', async () => {
    // The ledger dates each refund at its settlement. Selecting them by request date
    // instead put a refund requested in August and settled in September into August's
    // file — carrying a September date — and left it out of September's altogether, so
    // neither month reconciled against Stripe.
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    await paidWithCard(booking.id, 4500);

    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
    await prisma.refund.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        paymentId: payment.id,
        amountCents: 1000,
        currency: 'EUR',
        status: 'SUCCEEDED',
        reason: 'GOODWILL',
        idempotencyKey: randomUUID(),
        requestedAt: new Date('2026-08-31T20:00:00.000Z'),
        settledAt: new Date('2026-09-01T06:00:00.000Z'),
      },
    });

    const august = await owner
      .get('/api/office/exports/payments.csv')
      .query({ from: '2026-08-01', to: '2026-08-31' })
      .expect(200);
    expect(august.text).not.toContain('REFUND');

    const september = await owner
      .get('/api/office/exports/payments.csv')
      .query({ from: '2026-09-01', to: '2026-09-30' })
      .expect(200);
    expect(september.text).toContain('REFUND');
    expect(september.text).toContain('-10,00');
  });

  it('keeps an unsettled refund at the date it was requested', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '10:00'));
    await paidWithCard(booking.id, 4500);

    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
    await prisma.refund.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        paymentId: payment.id,
        amountCents: 1000,
        currency: 'EUR',
        status: 'PENDING',
        reason: 'GOODWILL',
        idempotencyKey: randomUUID(),
        requestedAt: new Date('2026-08-20T09:00:00.000Z'),
        settledAt: null,
      },
    });

    const august = await owner
      .get('/api/office/exports/payments.csv')
      .query({ from: '2026-08-01', to: '2026-08-31' })
      .expect(200);

    expect(august.text).toContain('REFUND');
  });

  it('is closed to an EMPLOYEE', async () => {
    const employee = await signedInAs('EMPLOYEE', { employeeId: ctx.employee1.id });

    await employee
      .get('/api/office/exports/bookings.csv')
      .query({ from: '2026-08-01', to: '2026-08-31' })
      .expect(403);
  });
});

/* ── helpers ──────────────────────────────────────────────────────────────────── */

/**
 * Enough rows to page over.
 *
 * An hour apart, not half an hour: the seeded service is 30 minutes plus five of
 * cleanup, so a 35-minute block at half-hour steps overlaps its neighbour and the
 * exclusion constraint refuses it — correctly.
 */
async function seedBookings(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await prisma.booking.create({
      data: makeBooking(ctx, {
        status: 'CONFIRMED',
        startsAt: new Date(NOW.getTime() + index * 3_600_000),
        expiresAt: null,
      }),
    });
  }
}
