import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';

import { Controller, Get, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
// Named, not default: pino-http ships CJS types with no `exports` map, so under
// NodeNext a default import resolves to the module namespace and is not callable —
// the same shape as the ioredis import elsewhere in this codebase.
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module.js';
import { SessionStore } from '../../src/auth/session.store.js';
import { correlationMiddleware } from '../../src/common/correlation/correlation.middleware.js';
import { buildLoggerParams } from '../../src/common/logging/logger.module.js';
import { InFlightRequests } from '../../src/common/shutdown/inflight.js';
import { ShutdownService } from '../../src/common/shutdown/shutdown.service.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { HealthController } from '../../src/health/health.controller.js';
import { HealthModule } from '../../src/health/health.module.js';
import { MigrationIndicator } from '../../src/health/migration.indicator.js';
import { QueueHealthIndicator } from '../../src/health/queue.indicator.js';
import { QUEUES } from '../../src/messaging/queues/job-contracts.js';
import { REDIS } from '../../src/messaging/queues/redis.provider.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { PUBLIC_WEB_ORIGIN, createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { queues, redis, resetQueues } from '../redis.harness.js';

import type { AppConfig } from '../../src/config/env.schema.js';
import type { OperationsSnapshot } from '../../src/health/operations.service.js';
import type { OfficeUserRole } from '../../src/prisma/client.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo, Server } from 'node:net';
import type { Options as PinoHttpOptions } from 'pino-http';

/**
 * Health, request logging, correlation and the graceful stop.
 *
 * Three shapes of application appear here, each the smallest that can prove its
 * point: the readiness controller with its dependencies deliberately broken, the
 * full booking application for `/detail` and the request log, and a two-route
 * application listening on a real port for the shutdown.
 */

const NOW = new Date('2026-08-10T06:00:00.000Z');
const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;

let ctx: SeedContext;

/**
 * A Redis pointing at a port nothing listens on.
 *
 * `retryStrategy: () => null` matters: without it ioredis reconnects for the length
 * of the test timeout and the check never resolves — the probe would hang rather
 * than report a failure, which is the failure mode this indicator exists to prevent.
 */
function unreachableRedis(): Redis {
  return new Redis('redis://127.0.0.1:1', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 250,
    retryStrategy: () => null,
  });
}

/** A Prisma that answers every query with a connection failure. */
function unreachablePrisma(): PrismaService {
  const fail = (): Promise<never> => Promise.reject(new Error('connection refused'));
  return { $queryRaw: fail, $queryRawUnsafe: fail } as unknown as PrismaService;
}

/**
 * Just the readiness controller and its three indicators.
 *
 * Built here rather than through the booking harness because the point of these
 * cases is a dependency that does not work, and the harness exists to provide ones
 * that do.
 */
async function createReadinessApp(
  overrides: { prisma?: PrismaService; redis?: Redis } = {},
): Promise<INestApplication> {
  @Module({
    imports: [TerminusModule],
    controllers: [HealthController],
    providers: [
      { provide: PrismaService, useValue: overrides.prisma ?? prisma },
      { provide: REDIS, useValue: overrides.redis ?? redis },
      MigrationIndicator,
      QueueHealthIndicator,
    ],
  })
  // A Nest module is a declaration carrier with an empty body by design.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class ReadinessTestModule {}

  const moduleRef = await Test.createTestingModule({ imports: [ReadinessTestModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();

  return app;
}

/** Nest types `getHttpServer()` as `any`; supertest wants the server it returns. */
function serverOf(app: INestApplication): Server {
  return app.getHttpServer() as Server;
}

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);
});

describe('GET /api/health/live', () => {
  it('answers 200 while every dependency is unreachable', async () => {
    // A supervisor uses this to decide whether to restart. A database blip must not
    // become a restart loop, so this route touches nothing.
    const app = await createReadinessApp({
      prisma: unreachablePrisma(),
      redis: unreachableRedis(),
    });

    try {
      const response = await request(serverOf(app)).get('/api/health/live').expect(200);
      expect(response.body).toEqual({ status: 'ok' });
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/health/ready', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app.close();
  });

  it('reports every dependency up against a working database and Redis', async () => {
    app = await createReadinessApp();

    const response = await request(serverOf(app)).get('/api/health/ready').expect(200);
    const body = response.body as { status: string; details: Record<string, { status: string }> };

    expect(body.status).toBe('ok');
    expect(body.details.database?.status).toBe('up');
    expect(body.details.redis?.status).toBe('up');
    expect(body.details.migrations?.status).toBe('up');
  });

  it('names Redis, and only Redis, when Redis is unreachable', async () => {
    const broken = unreachableRedis();
    app = await createReadinessApp({ redis: broken });

    try {
      const response = await request(serverOf(app)).get('/api/health/ready').expect(503);
      const body = response.body as { details: Record<string, { status: string }> };

      expect(body.details.redis?.status).toBe('down');
      // The point of naming indicators: an operator learns which dependency to look at.
      expect(body.details.database?.status).toBe('up');
      expect(body.details.migrations?.status).toBe('up');
    } finally {
      broken.disconnect();
    }
  });

  it('names the database when the database is unreachable', async () => {
    app = await createReadinessApp({ prisma: unreachablePrisma() });

    const response = await request(serverOf(app)).get('/api/health/ready').expect(503);
    const body = response.body as { details: Record<string, { status: string }> };

    expect(body.details.database?.status).toBe('down');
    expect(body.details.redis?.status).toBe('up');
  });

  it('refuses traffic when a shipped migration is not applied', async () => {
    app = await createReadinessApp();

    // Marked rolled back rather than deleted: the row goes back exactly as it was,
    // and a suite that leaves `_prisma_migrations` short would break the drift gate
    // for every run afterwards.
    await prisma.$executeRawUnsafe(
      `UPDATE _prisma_migrations SET rolled_back_at = now() WHERE migration_name LIKE '%calendar_constraints'`,
    );

    try {
      const response = await request(serverOf(app)).get('/api/health/ready').expect(503);
      const body = response.body as {
        details: Record<string, { status: string; pending?: string[] }>;
      };

      expect(body.details.migrations?.status).toBe('down');
      expect(body.details.migrations?.pending).toEqual([
        expect.stringContaining('calendar_constraints'),
      ]);
      // A schema problem is not a connection problem, and the response says which.
      expect(body.details.database?.status).toBe('up');
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE _prisma_migrations SET rolled_back_at = NULL WHERE migration_name LIKE '%calendar_constraints'`,
      );
    }
  });
});

describe('GET /api/health/detail', () => {
  let testApp: BookingTestApp;
  let sessions: SessionStore;
  let userCounter = 0;

  async function signedInAs(role: OfficeUserRole): Promise<string> {
    userCounter += 1;

    const user = await prisma.officeUser.create({
      data: {
        organizationId: ctx.organization.id,
        email: `${role.toLowerCase()}-${String(userCounter)}@shape-and-flow.example`,
        passwordHash: 'placeholder-not-a-credential',
        firstName: 'Test',
        lastName: role,
        role,
        canIssueRefunds: true,
      },
      select: { id: true },
    });

    const sid = await sessions.create({
      id: user.id,
      organizationId: ctx.organization.id,
      role,
      canIssueRefunds: true,
      employeeId: null,
    });

    return `sf_office_session=${sid}`;
  }

  const detail = (cookie?: string) => {
    const call = request(testApp.server())
      .get('/api/health/detail')
      .set(...CSRF);
    return cookie === undefined ? call : call.set('Cookie', cookie);
  };

  beforeEach(async () => {
    const keys = await redis.keys('session:*');
    if (keys.length > 0) await redis.del(...keys);
    // Real queues, so the depths this endpoint reports are the ones BullMQ holds —
    // and emptied first, so "zero waiting" is a fact rather than a coincidence.
    await resetQueues();

    testApp = await createBookingTestApp({
      organization: await loadOrganization(ctx.organization.id),
      clock: new FixedClock(NOW),
      extraImports: [AuthModule, HealthModule],
      queues,
      redis,
      globalPrefix: 'api',
    });

    sessions = testApp.app.get(SessionStore);

    return testApp.close;
  });

  it('is closed to anyone without a session', async () => {
    await detail().expect(401);
  });

  it('is closed to an employee', async () => {
    // Queue depths and stuck-row counts describe the business's machinery, not the
    // work of the person on the treatment table.
    await detail(await signedInAs('EMPLOYEE')).expect(403);
  });

  it('is open to an owner and to an admin', async () => {
    await detail(await signedInAs('OWNER')).expect(200);
    await detail(await signedInAs('ADMIN')).expect(200);
  });

  it('reports every operational counter', async () => {
    const response = await detail(await signedInAs('OWNER')).expect(200);
    const body = response.body as OperationsSnapshot;

    // Concrete values rather than "a number": on a database that was just reset and
    // queues that were just obliterated, every one of these is knowable, and a test
    // that only asserts the type would pass against a service returning nonsense.
    expect(body.queues).toEqual(
      Object.fromEntries(
        QUEUES.map((name) => [name, { waiting: 0, active: 0, delayed: 0, failed: 0 }]),
      ),
    );
    expect(body.failedJobs).toBe(0);
    expect(body.stuckOutboxRows).toBe(0);
    expect(body.unprocessedWebhooks).toBe(0);
    expect(body.pendingNotifications).toBe(0);
    // Null, not zero: zero would read as "one just entered the state".
    expect(body.oldestExpiringBookingAgeSeconds).toBeNull();
  });

  it('surfaces a genuinely stuck outbox row', async () => {
    // Ten minutes past the five-minute stall window, and undispatched.
    await prisma.outboxEvent.create({
      data: {
        organizationId: ctx.organization.id,
        aggregateType: 'Booking',
        aggregateId: 'booking-that-went-nowhere',
        eventType: 'booking.confirmed',
        payload: { bookingId: 'booking-that-went-nowhere' },
        createdAt: new Date(NOW.getTime() - 10 * 60_000),
        availableAt: new Date(NOW.getTime() - 10 * 60_000),
      },
    });

    const response = await detail(await signedInAs('OWNER')).expect(200);

    expect((response.body as { stuckOutboxRows: number }).stuckOutboxRows).toBe(1);
  });
});

describe('the request log', () => {
  let testApp: BookingTestApp;
  let lines: string[];

  function bookingBody(): Record<string, unknown> {
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
      successUrl: `${PUBLIC_WEB_ORIGIN}/booking/success`,
      cancelUrl: `${PUBLIC_WEB_ORIGIN}/booking/canceled`,
    };
  }

  beforeEach(async () => {
    lines = [];

    // The production configuration, over a stream this test can read. Its own
    // logger rather than nestjs-pino's wrapper, which offers no seam for one.
    const config = { NODE_ENV: 'test', LOG_LEVEL: 'info', LOG_SAMPLE_RATE: 1 } as AppConfig;
    // nestjs-pino types `pinoHttp` as a union that also allows a bare stream or a
    // tuple; the factory only ever produces the options branch.
    const options = buildLoggerParams(config).pinoHttp as PinoHttpOptions;
    const logger = pinoHttp(options, { write: (line: string) => lines.push(line) });

    testApp = await createBookingTestApp({
      organization: await loadOrganization(ctx.organization.id),
      clock: new FixedClock(NOW),
      extraImports: [HealthModule],
      queues,
      redis,
      globalPrefix: 'api',
      // Correlation first, for the same reason main.ts mounts it first: the logger
      // reads the id from the scope it opens.
      middleware: [correlationMiddleware, logger],
    });

    return testApp.close;
  });

  /** The one line pino writes when a response finishes. */
  function requestLine(): Record<string, unknown> {
    const written = lines.filter((line) => line.includes('"responseTimeMs"'));
    expect(written).toHaveLength(1);
    return JSON.parse(written[0] ?? '{}') as Record<string, unknown>;
  }

  it('writes one line per request, with the fields an incident is searched by', async () => {
    await request(testApp.server())
      .post('/api/public/bookings')
      .set('Idempotency-Key', randomUUID())
      .send(bookingBody())
      .expect(201);

    expect(requestLine()).toMatchObject({
      method: 'POST',
      url: '/api/public/bookings',
      statusCode: 201,
      level: 30,
    });
    expect(requestLine().responseTimeMs).toBeTypeOf('number');
    expect(requestLine().correlationId).toBeTypeOf('string');
  });

  it('keeps personal data out of the line', async () => {
    await request(testApp.server())
      .post('/api/public/bookings')
      .set('Idempotency-Key', randomUUID())
      .send(bookingBody())
      .expect(201);

    expect(JSON.stringify(requestLine())).not.toContain('anna@example.com');
    expect(JSON.stringify(requestLine())).not.toContain('+4915112345678');
  });

  it('carries no headers, in either direction', async () => {
    const key = randomUUID();

    await request(testApp.server())
      .post('/api/public/bookings')
      .set('Idempotency-Key', key)
      .send(bookingBody())
      .expect(201);

    const line = requestLine();

    // Not a preference: the default response serializer emits `Set-Cookie`, which on
    // the office login route is a live session. And an Idempotency-Key in a log is a
    // Checkout session anyone reading it can resume.
    expect(line.res).toEqual({ statusCode: 201 });
    expect(line.req).toMatchObject({ method: 'POST', url: '/api/public/bookings' });
    expect(JSON.stringify(line)).not.toContain(key);
  });

  it('raises the level of a rejected request to warn', async () => {
    await request(testApp.server())
      .post('/api/public/bookings')
      .set('Idempotency-Key', randomUUID())
      .send({ serviceId: 'nonsense' })
      .expect(400);

    // 40 is pino's `warn`. A search for `level >= 50` finds incidents and nothing else.
    expect(requestLine().level).toBe(40);
  });

  it('does not log health probes', async () => {
    await request(testApp.server()).get('/api/health/live').expect(200);

    expect(lines.filter((line) => line.includes('"responseTimeMs"'))).toEqual([]);
  });
});

describe('the correlation id', () => {
  let testApp: BookingTestApp;

  beforeEach(async () => {
    testApp = await createBookingTestApp({
      organization: await loadOrganization(ctx.organization.id),
      clock: new FixedClock(NOW),
      globalPrefix: 'api',
      middleware: [correlationMiddleware],
    });

    return testApp.close;
  });

  it('travels from the request into the outbox row the request wrote', async () => {
    const response = await request(testApp.server())
      .post('/api/public/bookings')
      .set('X-Request-Id', 'test-corr-1')
      .set('Idempotency-Key', randomUUID())
      .send({
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
        successUrl: `${PUBLIC_WEB_ORIGIN}/booking/success`,
        cancelUrl: `${PUBLIC_WEB_ORIGIN}/booking/canceled`,
      })
      .expect(201);

    expect(response.headers['x-request-id']).toBe('test-corr-1');

    const { bookingId } = response.body as { bookingId: string };
    const outbox = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: bookingId } });

    // The worker opens its scope from this field, so a log line three hops later
    // still carries the id the customer's request had.
    expect((outbox.payload as { correlationId?: string }).correlationId).toBe('test-corr-1');
  });
});

describe('SIGTERM', () => {
  /** A request that finishes only when the test says so. */
  let release: () => void;
  let arrived: Promise<void>;

  @Controller('slow')
  class SlowController {
    @Get()
    async get(): Promise<{ done: true }> {
      announceArrival();
      await gate;
      return { done: true };
    }
  }

  let gate: Promise<void>;
  let announceArrival: () => void;

  async function createListeningApp(): Promise<{ app: INestApplication; port: number }> {
    const moduleRef = await Test.createTestingModule({
      controllers: [SlowController],
      providers: [InFlightRequests, ShutdownService],
    }).compile();

    const app = moduleRef.createNestApplication();
    app.use(app.get(InFlightRequests).middleware);
    app.enableShutdownHooks();
    await app.listen(0);

    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;

    return { app, port };
  }

  /** True when a fresh TCP connection is refused. */
  async function connectionRefused(port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: '127.0.0.1' })
        .on('connect', () => {
          socket.destroy();
          resolve(false);
        })
        .on('error', () => {
          resolve(true);
        });
    });
  }

  beforeEach(() => {
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    arrived = new Promise<void>((resolve) => {
      announceArrival = resolve;
    });
  });

  it('finishes an in-flight request and refuses new connections', async () => {
    const { app, port } = await createListeningApp();

    const inFlight = request(`http://127.0.0.1:${String(port)}`).get('/slow');
    const response = inFlight.then((result) => result);
    await arrived;

    // Not awaited: the shutdown is waiting for the request below, which is the
    // behaviour under test.
    const closing = app.close();

    expect(await connectionRefused(port)).toBe(true);

    release();
    expect((await response).status).toBe(200);
    await closing;
  });
});
