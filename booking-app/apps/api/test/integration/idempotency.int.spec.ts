import { Body, Controller, Global, HttpCode, Module, Post, Put } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { GlobalExceptionFilter } from '../../src/common/errors/global-exception.filter.js';
import { CLOCK, FixedClock } from '../../src/domain/time/clock.js';
import { IdempotencyInterceptor } from '../../src/messaging/idempotency/idempotency.interceptor.js';
import {
  IDEMPOTENCY_LEASE_MS,
  IDEMPOTENCY_STATE,
  IDEMPOTENCY_TTL_MS,
  IdempotencyService,
} from '../../src/messaging/idempotency/idempotency.service.js';
import { Idempotent } from '../../src/messaging/idempotency/idempotent.decorator.js';
import { canonicalRequestHash } from '../../src/messaging/idempotency/request-hash.js';
import { OrganizationContextService } from '../../src/organization/organization-context.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { seedOrganization } from '../factories/index.js';

import type { SeedContext } from '../factories/index.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

const db = prisma as unknown as PrismaService;

const KEY = '3f7c1e5a-9b2d-4c8e-a1f0-6d5b4c3a2e10';
const OTHER_KEY = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';

let ctx: SeedContext;
let clock: FixedClock;
let service: IdempotencyService;

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);

  // Anchored to the real clock: `createdAt` is written by Prisma from this process.
  clock = new FixedClock(new Date());
  service = new IdempotencyService(db, clock);
});

describe('begin', () => {
  it('reports NEW for an unknown key, and leases it', async () => {
    expect(await service.begin(KEY, 'booking.create', 'h1')).toEqual({ outcome: 'NEW' });

    const row = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key: KEY } });
    expect(row.state).toBe(IDEMPOTENCY_STATE.IN_PROGRESS);
    expect(row.statusCode).toBeNull();
    expect(row.responseSnapshot).toBeNull();
    expect(row.expiresAt).toEqual(new Date(clock.now().getTime() + IDEMPOTENCY_LEASE_MS));
  });

  it('replays the stored response for the same key and hash', async () => {
    await service.begin(KEY, 'booking.create', 'h1');
    await service.complete(KEY, 201, { checkoutUrl: 'https://checkout.example/x' });

    expect(await service.begin(KEY, 'booking.create', 'h1')).toEqual({
      outcome: 'REPLAY',
      statusCode: 201,
      body: { checkoutUrl: 'https://checkout.example/x' },
    });
  });

  it('reports MISMATCH for the same key with a different hash', async () => {
    await service.begin(KEY, 'booking.create', 'h1');
    await service.complete(KEY, 201, {});

    expect(await service.begin(KEY, 'booking.create', 'h2')).toEqual({ outcome: 'MISMATCH' });
  });

  it('reports MISMATCH for the same key in a different scope', async () => {
    // A key minted for a booking must never replay a refund.
    await service.begin(KEY, 'booking.create', 'h1');
    await service.complete(KEY, 201, {});

    expect(await service.begin(KEY, 'refund.create', 'h1')).toEqual({ outcome: 'MISMATCH' });
  });

  it('reports MISMATCH before the attempt has completed, too', async () => {
    await service.begin(KEY, 'booking.create', 'h1');

    expect(await service.begin(KEY, 'booking.create', 'h2')).toEqual({ outcome: 'MISMATCH' });
  });

  it('reports IN_PROGRESS while the first attempt has not completed', async () => {
    await service.begin(KEY, 'booking.create', 'h1');

    expect(await service.begin(KEY, 'booking.create', 'h1')).toEqual({ outcome: 'IN_PROGRESS' });
  });

  it('serialises two simultaneous begins on the same key', async () => {
    // Why the insert is attempted rather than checked for first: both of these would
    // find nothing on a read and both proceed.
    const [a, b] = await Promise.all([
      service.begin(KEY, 'booking.create', 'h1'),
      service.begin(KEY, 'booking.create', 'h1'),
    ]);

    expect([a.outcome, b.outcome].sort()).toEqual(['IN_PROGRESS', 'NEW']);
    expect(await prisma.idempotencyKey.count()).toBe(1);
  });

  it('keeps distinct keys independent', async () => {
    await service.begin(KEY, 'booking.create', 'h1');

    expect(await service.begin(OTHER_KEY, 'booking.create', 'h1')).toEqual({ outcome: 'NEW' });
  });
});

describe('an attempt that never finished', () => {
  it('is taken over once its lease has expired', async () => {
    await service.begin(KEY, 'booking.create', 'h1');

    // Nothing called abandon: the process holding the key was killed.
    clock.set(new Date(clock.now().getTime() + IDEMPOTENCY_LEASE_MS + 1000));

    expect(await service.begin(KEY, 'booking.create', 'h1')).toEqual({ outcome: 'NEW' });

    const row = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key: KEY } });
    expect(row.expiresAt).toEqual(new Date(clock.now().getTime() + IDEMPOTENCY_LEASE_MS));
  });

  it('is taken over by exactly one of several waiting retries', async () => {
    await service.begin(KEY, 'booking.create', 'h1');
    clock.set(new Date(clock.now().getTime() + IDEMPOTENCY_LEASE_MS + 1000));

    const results = await Promise.all([
      service.begin(KEY, 'booking.create', 'h1'),
      service.begin(KEY, 'booking.create', 'h1'),
      service.begin(KEY, 'booking.create', 'h1'),
    ]);

    expect(results.filter((r) => r.outcome === 'NEW')).toHaveLength(1);
  });

  it('is still refused for a different request, expired lease or not', async () => {
    await service.begin(KEY, 'booking.create', 'h1');
    clock.set(new Date(clock.now().getTime() + IDEMPOTENCY_LEASE_MS + 1000));

    expect(await service.begin(KEY, 'booking.create', 'different')).toEqual({
      outcome: 'MISMATCH',
    });
  });
});

describe('complete', () => {
  it('extends the expiry to the replay window', async () => {
    await service.begin(KEY, 'booking.create', 'h1');
    await service.complete(KEY, 201, { ok: true });

    const row = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key: KEY } });
    expect(row.state).toBe(IDEMPOTENCY_STATE.COMPLETED);
    expect(row.expiresAt).toEqual(new Date(clock.now().getTime() + IDEMPOTENCY_TTL_MS));
  });

  it('stores the organization and booking a key belongs to', async () => {
    await service.begin(KEY, 'booking.create', 'h1');
    await service.complete(
      KEY,
      201,
      { ok: true },
      {
        organizationId: ctx.organization.id,
        bookingId: 'clx-booking-1',
      },
    );

    const row = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key: KEY } });
    expect(row.organizationId).toBe(ctx.organization.id);
    expect(row.bookingId).toBe('clx-booking-1');
  });

  it('does not overwrite a response already recorded', async () => {
    await service.begin(KEY, 'booking.create', 'h1');
    await service.complete(KEY, 201, { attempt: 'first' });
    await service.complete(KEY, 500, { attempt: 'second' });

    const row = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key: KEY } });
    expect(row.responseSnapshot).toEqual({ attempt: 'first' });
    expect(row.statusCode).toBe(201);
  });

  it('stores a null body without failing', async () => {
    await service.begin(KEY, 'booking.create', 'h1');
    await service.complete(KEY, 204, null);

    expect(await service.begin(KEY, 'booking.create', 'h1')).toEqual({
      outcome: 'REPLAY',
      statusCode: 204,
      body: null,
    });
  });
});

describe('abandon', () => {
  it('lets a key be reused, so a failed attempt is retryable', async () => {
    await service.begin(KEY, 'booking.create', 'h1');
    await service.abandon(KEY);

    expect(await prisma.idempotencyKey.count()).toBe(0);
    expect(await service.begin(KEY, 'booking.create', 'h1')).toEqual({ outcome: 'NEW' });
  });

  it('will not delete a completed key', async () => {
    // Otherwise a late failure on a retried request would destroy the stored
    // response of the attempt that succeeded.
    await service.begin(KEY, 'booking.create', 'h1');
    await service.complete(KEY, 201, { ok: true });
    await service.abandon(KEY);

    expect(await prisma.idempotencyKey.count()).toBe(1);
  });
});

describe('sweep', () => {
  it('deletes expired keys', async () => {
    await service.begin(KEY, 'booking.create', 'h1');
    await prisma.idempotencyKey.updateMany({
      where: { key: KEY },
      data: { expiresAt: new Date(clock.now().getTime() - 1000) },
    });

    expect(await service.sweep()).toBe(1);
    expect(await prisma.idempotencyKey.count({ where: { key: KEY } })).toBe(0);
  });

  it('leaves a key that has not expired', async () => {
    await service.begin(KEY, 'booking.create', 'h1');
    await service.complete(KEY, 201, {});

    expect(await service.sweep()).toBe(0);
    expect(await prisma.idempotencyKey.count()).toBe(1);
  });
});

/* ── the interceptor, over real HTTP ─────────────────────────────────────────── */

/** Counts handler invocations, so a replay can be told from a re-run. */
class Runs {
  count = 0;
}

@Controller('probe')
class ProbeController {
  constructor(private readonly runs: Runs) {}

  @Post('bookings')
  @Idempotent('booking.create')
  create(@Body() body: { fail?: boolean; slot?: string }): { bookingId: string; run: number } {
    this.runs.count += 1;
    if (body.fail === true) throw new Error('handler exploded');
    return { bookingId: `booking-${String(this.runs.count)}`, run: this.runs.count };
  }

  @Put('refunds')
  @HttpCode(200)
  @Idempotent('refund.create')
  refund(): { ok: true } {
    this.runs.count += 1;
    return { ok: true };
  }

  @Post('open')
  unprotected(): { ok: true } {
    this.runs.count += 1;
    return { ok: true };
  }
}

@Global()
@Module({
  providers: [
    Runs,
    // The very clock the outer beforeEach built, so a test moving it moves the
    // service's notion of now too.
    { provide: CLOCK, useFactory: () => clock },
    { provide: PrismaService, useValue: db },
    IdempotencyService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    {
      // Only getOrganizationId is reached, and booting the real context service
      // would mean booting the whole config and organization stack for a route that
      // exists to exercise one interceptor.
      provide: OrganizationContextService,
      useValue: { getOrganizationId: () => ctx.organization.id },
    },
  ],
  controllers: [ProbeController],
  exports: [Runs, IdempotencyService],
})
// A Nest module is a declaration carrier with an empty body by design. The shared
// config exempts `*.module.ts`; this one lives in a spec because it closes over the
// test's clock and organization.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class ProbeModule {}

describe('the interceptor', () => {
  let app: INestApplication;
  let runs: Runs;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    runs = app.get(Runs);

    return async () => {
      await app.close();
    };
  });

  /** `getHttpServer()` is typed `any`; narrowed once here rather than at each call. */
  const server = (): Server => app.getHttpServer() as Server;

  const post = (key: string | null, body: object = { slot: 'a' }) => {
    const req = request(server()).post('/probe/bookings');
    return key === null ? req.send(body) : req.set('Idempotency-Key', key).send(body);
  };

  it('runs the handler once and replays the response for a retry', async () => {
    const first = await post(KEY);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ bookingId: 'booking-1', run: 1 });

    const second = await post(KEY);
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ bookingId: 'booking-1', run: 1 });
    expect(second.headers['idempotent-replay']).toBe('true');

    // The proof it was replayed rather than re-run.
    expect(runs.count).toBe(1);
  });

  it('does not mark the first response as a replay', async () => {
    const first = await post(KEY);
    expect(first.headers['idempotent-replay']).toBeUndefined();
  });

  it('records the booking id from the response body', async () => {
    await post(KEY);

    const row = await prisma.idempotencyKey.findUniqueOrThrow({ where: { key: KEY } });
    expect(row.bookingId).toBe('booking-1');
    expect(row.organizationId).toBe(ctx.organization.id);
    expect(row.statusCode).toBe(201);
  });

  it('returns 422 IDEMPOTENCY_KEY_REUSED for the same key with a different body', async () => {
    await post(KEY, { slot: 'a' });

    const reused = await post(KEY, { slot: 'b' });
    expect(reused.status).toBe(422);
    expect(reused.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(runs.count).toBe(1);
  });

  it('ignores key order in the body, so a re-serialised retry still replays', async () => {
    await post(KEY, { slot: 'a', extra: 1 });

    const reordered = await post(KEY, { extra: 1, slot: 'a' });
    expect(reordered.status).toBe(201);
    expect(runs.count).toBe(1);
  });

  it('returns 409 IDEMPOTENT_REQUEST_IN_PROGRESS while an attempt is running', async () => {
    await service.begin(KEY, 'booking.create', canonicalRequestHash({ slot: 'a' }));

    const blocked = await post(KEY);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: 'IDEMPOTENT_REQUEST_IN_PROGRESS' });
    expect(runs.count).toBe(0);
  });

  it('returns 400 for a missing key', async () => {
    const missing = await post(null);
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(runs.count).toBe(0);
  });

  it('returns 400 for a key that is not a UUID', async () => {
    const bad = await post('not-a-uuid');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('does not echo the key back in the error, since it is a credential', async () => {
    const bad = await post('not-a-uuid');
    expect(JSON.stringify(bad.body)).not.toContain('not-a-uuid');
  });

  it('stores nothing when the handler fails, so the retry actually retries', async () => {
    const failed = await post(KEY, { fail: true });
    expect(failed.status).toBe(500);
    expect(await prisma.idempotencyKey.count()).toBe(0);

    // The same key now works: the failed attempt left it free.
    const retried = await post(KEY, { fail: false, slot: 'a' });
    expect(retried.status).toBe(201);
    expect(runs.count).toBe(2);
  });

  it('honours an explicit @HttpCode when replaying', async () => {
    // The status is read from the route, because Nest has not applied it to the
    // response by the time the interceptor runs.
    const first = await request(server())
      .put('/probe/refunds')
      .set('Idempotency-Key', KEY)
      .send({});
    expect(first.status).toBe(200);

    const replayed = await request(server())
      .put('/probe/refunds')
      .set('Idempotency-Key', KEY)
      .send({});
    expect(replayed.status).toBe(200);
    expect(replayed.headers['idempotent-replay']).toBe('true');
    expect(runs.count).toBe(1);
  });

  it('leaves an undecorated route alone, key or no key', async () => {
    const open = await request(server()).post('/probe/open').send({});
    expect(open.status).toBe(201);
    expect(await prisma.idempotencyKey.count()).toBe(0);
  });
});
