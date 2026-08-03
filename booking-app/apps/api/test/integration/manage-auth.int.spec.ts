import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { FixedClock } from '../../src/domain/time/clock.js';
import { ManageModule } from '../../src/manage/manage.module.js';
import {
  MANAGEMENT_TOKEN_GRACE_DAYS,
  ManagementTokenService,
  constantTimeEquals,
  hashManagementToken,
} from '../../src/manage/management-token.service.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, makeBooking, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';

import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

const NOW = new Date('2026-08-10T06:00:00.000Z');

let ctx: SeedContext;
let clock: FixedClock;
let testApp: BookingTestApp;
let server: () => Server;
let tokens: ManagementTokenService;
let bookingId: string;
let reference: string;

/** A confirmed, paid booking — the state a management link is issued for. */
async function confirmedBooking(overrides: Parameters<typeof makeBooking>[1] = {}): Promise<{
  id: string;
  reference: string;
}> {
  const booking = await prisma.booking.create({
    data: {
      ...makeBooking(ctx, { status: 'CONFIRMED', expiresAt: null, ...overrides }),
      confirmedAt: NOW,
    },
  });

  await prisma.payment.create({
    data: {
      organizationId: ctx.organization.id,
      bookingId: booking.id,
      stripeCheckoutSessionId: `cs_test_${booking.id}`,
      amountCents: booking.priceCentsSnapshot,
      currency: booking.currency,
      status: 'SUCCEEDED',
      paidAt: NOW,
    },
  });

  return { id: booking.id, reference: booking.reference };
}

/** Issue a token the way production does — inside a transaction. */
async function issueFor(id: string, endsAt = new Date(SLOT_FRIDAY_0900.getTime() + 30 * 60_000)) {
  return await prisma.$transaction((tx) => tokens.issue(tx, id, ctx.organization.id, endsAt));
}

const get = (path: string, token?: string) => {
  const req = request(server()).get(path);
  return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
};

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);
  clock = new FixedClock(NOW);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock,
    extraImports: [ManageModule],
  });

  server = testApp.server;
  tokens = testApp.app.get(ManagementTokenService);

  const booking = await confirmedBooking();
  bookingId = booking.id;
  reference = booking.reference;

  // A closure that reads `testApp` when it runs, not `testApp.close` captured now. Tests that
  // rebuild the app reassign `testApp`, and the bound method would close the instance that was
  // already discarded — leaking the live one's connections for the rest of the run.
  return async () => {
    await testApp.close();
  };
});

describe('what the database stores', () => {
  it('stores only a hash, never the token', async () => {
    const { token } = await issueFor(bookingId);

    const rows = await prisma.managementToken.findMany({ where: { bookingId } });

    expect(rows[0]?.tokenHash).toBe(hashManagementToken(token));
    // A dump, a backup, or a support engineer reading rows cannot reconstruct the link.
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('expires two weeks after the appointment, not two weeks after issue', async () => {
    const endsAt = new Date('2026-08-14T07:30:00.000Z');
    await issueFor(bookingId, endsAt);

    const row = await prisma.managementToken.findFirstOrThrow({ where: { bookingId } });

    // Tied to the appointment, so a booking made a year out does not carry a
    // year-long credential.
    expect(row.expiresAt).toEqual(
      new Date(endsAt.getTime() + MANAGEMENT_TOKEN_GRACE_DAYS * 86_400_000),
    );
  });

  it('rolls the token back with the transaction that issued it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tokens.issue(tx, bookingId, ctx.organization.id, SLOT_FRIDAY_0900);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    // Otherwise a live credential would exist for a booking that does not.
    expect(await prisma.managementToken.count()).toBe(0);
  });
});

describe('GET /manage/booking', () => {
  it('authenticates and returns that booking', async () => {
    const { token } = await issueFor(bookingId);

    const response = await get('/manage/booking', token).expect(200);
    const body = response.body as { reference: string; status: string; displayStatus: string };

    expect(body.reference).toBe(reference);
    expect(body.status).toBe('CONFIRMED');
    expect(body.displayStatus).toBe('CONFIRMED');
  });

  it('exposes no internal identifier', async () => {
    const { token } = await issueFor(bookingId);

    const response = await get('/manage/booking', token).expect(200);
    const serialised = JSON.stringify(response.body);

    // A management link ends up in a mailbox and in browser history, so what it can
    // reveal has to be worth revealing to whoever finds it.
    for (const forbidden of [
      'organizationId',
      'customerId',
      'employeeId',
      'internalNote',
      'stripe',
      'bookingId',
      ctx.organization.id,
      ctx.customer.id,
      ctx.employee1.id,
    ]) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  it('reports what was paid and what came back', async () => {
    const { token } = await issueFor(bookingId);

    const response = await get('/manage/booking', token).expect(200);
    const body = response.body as {
      price: { amountCents: number };
      paid: { amountCents: number };
      refunded: { amountCents: number };
    };

    expect(body.price.amountCents).toBe(ctx.service30.priceCents);
    expect(body.paid.amountCents).toBe(ctx.service30.priceCents);
    expect(body.refunded.amountCents).toBe(0);
  });

  it('states the cancellation consequence before the customer acts', async () => {
    const { token } = await issueFor(bookingId);

    const response = await get('/manage/booking', token).expect(200);
    const body = response.body as {
      cancellationPolicy: {
        feePolicy: string;
        freeUntil: string;
        feeApplies: boolean;
        suggestedRetained: { amountCents: number };
        cancellable: boolean;
      };
    };

    // Seeded policy is NONE, and the appointment is days away.
    expect(body.cancellationPolicy.feePolicy).toBe('NONE');
    expect(body.cancellationPolicy.freeUntil).toBeTypeOf('string');
    expect(body.cancellationPolicy.feeApplies).toBe(false);
    expect(body.cancellationPolicy.suggestedRetained.amountCents).toBe(0);
    expect(body.cancellationPolicy.cancellable).toBe(true);
  });

  it('says a fee applies once inside the free window', async () => {
    await prisma.organizationSettings.updateMany({
      data: { cancellationFeePolicy: 'PERCENTAGE', cancellationFeePercent: 50 },
    });

    // Rebuild the app so it reads the updated settings, which are cached at bootstrap.
    await testApp.close();
    testApp = await createBookingTestApp({
      organization: await loadOrganization(ctx.organization.id),
      clock,
      extraImports: [ManageModule],
    });
    server = testApp.server;
    tokens = testApp.app.get(ManagementTokenService);

    const { token } = await issueFor(bookingId);

    // The appointment is 2026-08-14; move to a day before it, inside 72 hours.
    clock.set(new Date('2026-08-13T06:00:00.000Z'));

    const response = await get('/manage/booking', token).expect(200);
    const body = response.body as {
      cancellationPolicy: { feeApplies: boolean; suggestedRetained: { amountCents: number } };
    };

    expect(body.cancellationPolicy.feeApplies).toBe(true);
    expect(body.cancellationPolicy.suggestedRetained.amountCents).toBe(
      ctx.service30.priceCents / 2,
    );
  });

  it('shows CANCELLATION_REQUESTED while a request is open', async () => {
    await prisma.cancellationRequest.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId,
        suggestedRetainedAmountCents: 0,
      },
    });

    const { token } = await issueFor(bookingId);
    const response = await get('/manage/booking', token).expect(200);
    const body = response.body as { status: string; displayStatus: string };

    // The row is still CONFIRMED — the slot is still held — but telling the customer
    // "confirmed" while they wait for an answer would be misleading.
    expect(body.status).toBe('CONFIRMED');
    expect(body.displayStatus).toBe('CANCELLATION_REQUESTED');
  });

  it('records lastUsedAt without changing the hash', async () => {
    const { token } = await issueFor(bookingId);
    const before = await prisma.managementToken.findFirstOrThrow({ where: { bookingId } });

    await get('/manage/booking', token).expect(200);

    // `resolve` calls `touch` without awaiting it, so the write lands some time after the
    // response. Polled rather than slept: a fixed 100 ms passes locally and races on a loaded
    // CI runner, which is the kind of flake that gets a test deleted rather than fixed.
    await expect
      .poll(async () => {
        const row = await prisma.managementToken.findFirstOrThrow({ where: { bookingId } });
        return row.lastUsedAt;
      })
      .not.toBeNull();

    const after = await prisma.managementToken.findFirstOrThrow({ where: { bookingId } });
    expect(after.tokenHash).toBe(before.tokenHash);
  });
});

describe('tokens that must not work', () => {
  it('rejects a missing Authorization header', async () => {
    const response = await get('/manage/booking').expect(401);
    expect(response.body).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a token that is not a token', async () => {
    await get('/manage/booking', 'not-a-real-token').expect(401);
  });

  it('rejects a revoked token', async () => {
    const { token } = await issueFor(bookingId);
    await prisma.managementToken.updateMany({ where: { bookingId }, data: { revokedAt: NOW } });

    await get('/manage/booking', token).expect(401);
  });

  it('rejects an expired token', async () => {
    const { token } = await issueFor(bookingId);
    await prisma.managementToken.updateMany({
      where: { bookingId },
      data: { expiresAt: new Date(NOW.getTime() - 1000) },
    });

    await get('/manage/booking', token).expect(401);
  });

  it('gives every failure the same message, so none of them is a hint', async () => {
    const { token } = await issueFor(bookingId);
    await prisma.managementToken.updateMany({ where: { bookingId }, data: { revokedAt: NOW } });

    const revoked = await get('/manage/booking', token).expect(401);
    const garbage = await get('/manage/booking', 'garbage').expect(401);

    expect((revoked.body as { message: string }).message).toBe(
      (garbage.body as { message: string }).message,
    );
  });

  it('does not echo the presented token back', async () => {
    const response = await get('/manage/booking', 'secret-guess').expect(401);
    expect(JSON.stringify(response.body)).not.toContain('secret-guess');
  });

  it('cannot be aimed at another booking, because no route takes an id', async () => {
    const other = await confirmedBooking({
      employeeId: ctx.employee2.id,
      startsAt: new Date(SLOT_FRIDAY_0900.getTime() + 60 * 60_000),
    });
    const { token } = await issueFor(bookingId);

    // There is simply no such route: the token is the selector.
    await get(`/manage/booking/${other.id}`, token).expect(404);
  });

  it('does not open a booking the token was not issued for', async () => {
    const other = await confirmedBooking({
      employeeId: ctx.employee2.id,
      startsAt: new Date(SLOT_FRIDAY_0900.getTime() + 60 * 60_000),
    });
    const { token } = await issueFor(other.id);

    const response = await get('/manage/booking', token).expect(200);
    expect((response.body as { reference: string }).reference).toBe(other.reference);
    expect((response.body as { reference: string }).reference).not.toBe(reference);
  });
});

describe('GET /manage/availability', () => {
  it('offers slots for the booking own service', async () => {
    const { token } = await issueFor(bookingId);

    const response = await request(server())
      .get('/manage/availability')
      .query({ from: '2026-08-21', to: '2026-08-21' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = response.body as { serviceId: string; days: { slots: unknown[] }[] };
    expect(body.serviceId).toBe(ctx.service30.id);
    expect(body.days[0]?.slots.length).toBeGreaterThan(0);
  });

  it('takes no serviceId, so a reschedule cannot change what was bought', async () => {
    const { token } = await issueFor(bookingId);

    const response = await request(server())
      .get('/manage/availability')
      .query({ from: '2026-08-21', to: '2026-08-21', serviceId: ctx.service60.id })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // The parameter is stripped, and the booking's own service answers.
    expect((response.body as { serviceId: string }).serviceId).toBe(ctx.service30.id);
  });

  it('requires a token', async () => {
    await request(server())
      .get('/manage/availability')
      .query({ from: '2026-08-21', to: '2026-08-21' })
      .expect(401);
  });
});

describe('constantTimeEquals', () => {
  it('accepts identical strings and rejects everything else', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    // Length is checked first, because timingSafeEqual throws on a mismatch rather
    // than returning false.
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });
});
