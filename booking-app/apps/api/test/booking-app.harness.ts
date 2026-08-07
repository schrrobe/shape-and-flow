import { Global, Module, Scope } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { BookingModule } from '../src/booking/booking.module.js';
import { GlobalExceptionFilter } from '../src/common/errors/global-exception.filter.js';
import { AuthGuard } from '../src/common/guards/auth.guard.js';
import { ENV } from '../src/config/env.schema.js';
import { CLOCK, FixedClock } from '../src/domain/time/clock.js';
import { IdempotencyInterceptor } from '../src/messaging/idempotency/idempotency.interceptor.js';
import { IdempotencyService } from '../src/messaging/idempotency/idempotency.service.js';
import { InboxRecorder } from '../src/messaging/inbox/inbox.recorder.js';
import { OutboxRecorder } from '../src/messaging/outbox/outbox.recorder.js';
import { EnqueueService, QUEUE_REGISTRY } from '../src/messaging/queues/enqueue.service.js';
import { QUEUES } from '../src/messaging/queues/job-contracts.js';
import { REDIS } from '../src/messaging/queues/redis.provider.js';
import { OrganizationContextService } from '../src/organization/organization-context.service.js';
import { currentTenant } from '../src/organization/tenant-context.store.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { EMAIL_PROVIDER } from '../src/providers/email/email-provider.js';
import { FakeEmailProvider } from '../src/providers/email/fake-email.provider.js';
import { FakePaymentProvider } from '../src/providers/payment/fake-payment.provider.js';
import { PAYMENT_PROVIDER } from '../src/providers/payment/payment-provider.js';
import { FakeSmsProvider } from '../src/providers/sms/fake-sms.provider.js';
import { SMS_PROVIDER } from '../src/providers/sms/sms-provider.js';
import { PublicModule } from '../src/public/public.module.js';
import { webhookBodyParser } from '../src/webhooks/raw-body.js';

import { prisma } from './database.harness.js';
import { countingPrisma, loadOrganization } from './public-app.harness.js';

import type { AppConfig } from '../src/config/env.schema.js';
import type { QueueRegistry } from '../src/messaging/queues/enqueue.service.js';
import type { OrganizationWithSettings } from '../src/organization/organization-context.service.js';
import type { INestApplication } from '@nestjs/common';
import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import type { Server } from 'node:http';

/**
 * A Nest application for the booking path, with real everything except three seams.
 *
 * The organization context is a stub, the clock is fixed, and the payment provider is
 * the in-memory fake — the same three substitutions the availability harness makes,
 * plus the fake, which is what lets a test drive Stripe's answers (paid, expired,
 * unreachable) without a network.
 *
 * The idempotency interceptor *is* real and globally bound, because on this endpoint it
 * is not incidental: it is what returns the Checkout URL to a customer who reloads.
 */

export const PUBLIC_WEB_ORIGIN = 'http://localhost:5173';
export const PUBLIC_API_ORIGIN = 'http://localhost:3000';

/**
 * The signing secrets the webhook tests have to sign with.
 *
 * Exported rather than repeated as literals in each suite: a mismatch between the two shows
 * up as a signature rejection, which reads like a broken verifier rather than a stale
 * constant.
 *
 * The Resend secret is base64 behind a `whsec_` prefix because that is the shape Svix
 * actually sends, and the verifier decodes it — a plain string would test a code path
 * production never takes.
 */
export const RESEND_WEBHOOK_SECRET = 'whsec_dGVzdC1yZXNlbmQtc2VjcmV0';
export const TWILIO_AUTH_TOKEN = 'test-twilio-token';

let currentOrganization: OrganizationWithSettings | null = null;
let currentClock: FixedClock | null = null;

function organizationStub(): Partial<OrganizationContextService> {
  const read = (): OrganizationWithSettings => {
    // Mirrors the real OrganizationContextService.get(): a suite that wires
    // TenantResolutionMiddleware and opens a runWithTenant() scope (public routes
    // resolved by ?organizer=<slug>) gets that organization; everything else falls
    // back to the snapshot set by createBookingTestApp.
    const scoped = currentTenant();
    if (scoped) return scoped;

    if (currentOrganization === null) {
      throw new Error('Organization not set. Call createBookingTestApp from a beforeEach.');
    }
    return currentOrganization;
  };

  return {
    get: read,
    getOrganizationId: () => read().id,
    getSettings: () => read().settings,
    getTimezone: () => read().timezone,
    /**
     * The one method the stub implements for real.
     *
     * `PATCH /office/settings` calls it, and the reason it exists in production — the
     * cached policy must not survive the row that produced it — is exactly what the
     * settings test asserts. A stub that answered `undefined` here would make that
     * assertion pass against a service that never refreshed anything.
     */
    refresh: async () => {
      currentOrganization = await loadOrganization(read().id);
    },
    // Worker paths pass the organization the job names and expect a mismatch to be rejected,
    // so the stub enforces that rather than waving it through: a test that queued a job for
    // the wrong tenant should fail here, not somewhere downstream.
    require: (organizationId: string) => {
      const organization = read();

      if (organization.id !== organizationId) {
        throw new Error(
          `Job for organization ${organizationId} ran with ${organization.id} in context.`,
        );
      }

      return organization;
    },
    // These two bypass ALS and the bootstrap snapshot in production, going straight to
    // Prisma for an explicit organization id. The stub mirrors that by querying the same
    // real test database rather than reading `currentOrganization` — a suite proving
    // `/manage/*` returns a *different* organization's own settings needs this to actually
    // hit that organization's row, not whichever one this harness instance bootstrapped.
    getSettingsFor: async (organizationId: string) => {
      const organization = await prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        include: { settings: true },
      });
      if (!organization.settings) {
        throw new Error(`Organization "${organizationId}" has no settings row.`);
      }
      return organization.settings;
    },
    getTimezoneFor: async (organizationId: string) => {
      const organization = await prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { timezone: true },
      });
      return organization.timezone;
    },
  };
}

/**
 * Only the variables the booking path reads.
 *
 * Cast for the same reason test/test-config.module.ts casts: this is a partial standing
 * in for the full AppConfig, and a module reaching for something not listed gets
 * `undefined` and fails loudly, which is the signal to add it.
 */
const testConfig = {
  NODE_ENV: 'test',
  PUBLIC_WEB_ORIGIN,
  PUBLIC_API_ORIGIN,
  PAYMENT_PROVIDER: 'fake',
  EMAIL_PROVIDER: 'fake',
  SMS_PROVIDER: 'fake',
  RESEND_WEBHOOK_SECRET,
  TWILIO_AUTH_TOKEN,
  SESSION_COOKIE_NAME: 'sf_office_session',
  // Short enough that a suite can wait one out if it ever needs to, long enough that
  // no test races the idle expiry by accident.
  SESSION_IDLE_TTL_MINUTES: 60,
  SESSION_ABSOLUTE_TTL_MINUTES: 10_080,
} as unknown as AppConfig;

@Global()
@Module({
  providers: [
    { provide: PrismaService, useFactory: () => (countingEnabled ? countingPrisma : prisma) },
    { provide: CLOCK, useFactory: () => currentClock ?? new FixedClock(new Date()) },
    { provide: OrganizationContextService, useFactory: organizationStub },
    { provide: ENV, useValue: testConfig },
    FakePaymentProvider,
    { provide: PAYMENT_PROVIDER, useExisting: FakePaymentProvider },
    FakeEmailProvider,
    { provide: EMAIL_PROVIDER, useExisting: FakeEmailProvider },
    FakeSmsProvider,
    { provide: SMS_PROVIDER, useExisting: FakeSmsProvider },
    OutboxRecorder,
    InboxRecorder,
    IdempotencyService,
    // Queues that record instead of connecting. The webhook path enqueues, and these
    // tests are about what it stores and decides -- not about Redis, which the queue
    // and outbox suites already cover against a real server.
    {
      provide: QUEUE_REGISTRY,
      // Real BullMQ queues when a suite hands some in. Reminders are delayed jobs whose
      // ids and delays live in Redis, and a recording fake would prove nothing about
      // either -- including whether BullMQ accepts the id at all, which is exactly where
      // the last job-id bug was. Passed in rather than imported here, so importing this
      // harness never opens a Redis connection a suite did not ask for.
      useFactory: () => currentQueues ?? recordingQueueRegistry(),
    },
    EnqueueService,
    // Only a suite that asked for it gets a connection: importing this harness must
    // never open one on its own. Anything needing REDIS without it fails at injection,
    // which is the signal to pass `redis` from redis.harness.ts.
    {
      provide: REDIS,
      scope: Scope.TRANSIENT,
      useFactory: () => {
        if (currentRedis === undefined) {
          throw new Error('Pass `redis` from redis.harness.ts when a suite injects REDIS.');
        }
        return currentRedis;
      },
    },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [
    PrismaService,
    CLOCK,
    OrganizationContextService,
    ENV,
    PAYMENT_PROVIDER,
    FakePaymentProvider,
    EMAIL_PROVIDER,
    FakeEmailProvider,
    SMS_PROVIDER,
    FakeSmsProvider,
    OutboxRecorder,
    InboxRecorder,
    IdempotencyService,
    EnqueueService,
    QUEUE_REGISTRY,
    REDIS,
  ],
})
// A Nest module is a declaration carrier with an empty body by design.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class BookingTestHarnessModule {}

/** Set per app, by `createBookingTestApp({ queues })`. */
let currentQueues: QueueRegistry | undefined;

/** Set per app, by `createBookingTestApp({ redis })`. */
let currentRedis: Redis | undefined;

/** Set per app, by `createBookingTestApp({ countQueries })`. */
let countingEnabled = false;

/** Every job the harness's queues were asked to add, in order. */
export const enqueued: { queue: string; name: string; data: unknown; options: unknown }[] = [];

/**
 * A queue registry that records rather than connects.
 *
 * Deliberately not a real BullMQ queue: what these tests assert is which jobs the
 * webhook decides to enqueue, and standing up Redis to observe that would make a slow
 * suite prove something the queue suite already proves against a real server.
 */
function recordingQueueRegistry(): Record<string, unknown> {
  // One recorder per queue, each carrying its own name. A single shared object records the
  // job name but not the queue it went to, so a job enqueued onto the wrong queue would look
  // identical to a correct one.
  return Object.fromEntries(
    QUEUES.map((queueName) => [
      queueName,
      {
        add: (name: string, data: unknown, options: unknown) => {
          enqueued.push({ queue: queueName, name, data, options });
          return Promise.resolve({ id: 'recorded' });
        },
        name: queueName,
      },
    ]),
  );
}

export interface BookingTestApp {
  app: INestApplication;
  server: () => Server;
  payments: FakePaymentProvider;
  email: FakeEmailProvider;
  sms: FakeSmsProvider;
  close: () => Promise<void>;
}

export async function createBookingTestApp(options: {
  organization: OrganizationWithSettings;
  clock: FixedClock;
  extraImports?: NonNullable<Parameters<typeof Test.createTestingModule>[0]['imports']>;
  /** Real BullMQ queues — pass `queues` from `redis.harness.ts` — instead of the fake. */
  queues?: QueueRegistry;
  /** A real connection, for anything that stores state in Redis rather than queueing. */
  redis?: Redis;
  /**
   * Mount everything under a prefix, the way `main.ts` mounts `api`.
   *
   * Off by default so existing suites keep their short paths. The auth suite sets it,
   * because the session cookie is scoped to `Path=/api` and a supertest agent's cookie
   * jar honours that path — without the prefix the jar would silently withhold the
   * cookie, and every authenticated assertion would pass or fail for the wrong reason.
   */
  globalPrefix?: string;
  /**
   * Express handlers to mount before the application initialises.
   *
   * The correlation middleware is registered with `app.use()` in production rather than
   * as Nest middleware, so a suite that asserts on correlation ids has to mount it the
   * same way or it would be proving something about a different wiring.
   */
  middleware?: RequestHandler[];
  /**
   * Count Prisma operations, so a suite can assert an N+1 has not appeared.
   *
   * Off by default: the counting client is a `$extends` proxy, and every suite paying
   * for it to observe something only one suite asserts is the wrong trade. Read the
   * total through `queryCounter` from `public-app.harness.ts`.
   */
  countQueries?: boolean;
}): Promise<BookingTestApp> {
  currentOrganization = options.organization;
  currentClock = options.clock;
  currentQueues = options.queues;
  currentRedis = options.redis;
  countingEnabled = options.countQueries ?? false;
  enqueued.length = 0;

  const moduleRef = await Test.createTestingModule({
    imports: [
      BookingTestHarnessModule,
      PublicModule,
      BookingModule,
      ...(options.extraImports ?? []),
    ],
  }).compile();

  // `rawBody: true` for the same reason production sets it: the webhook verifies a
  // signature over the bytes as sent.
  const app = moduleRef.createNestApplication({ rawBody: true });
  for (const handler of options.middleware ?? []) app.use(handler);
  if (options.globalPrefix !== undefined) app.setGlobalPrefix(options.globalPrefix);
  app.use(
    `${options.globalPrefix === undefined ? '' : `/${options.globalPrefix}`}/webhooks`,
    webhookBodyParser,
  );
  await app.init();

  return {
    app,
    server: () => app.getHttpServer() as Server,
    payments: app.get(FakePaymentProvider),
    email: app.get(FakeEmailProvider),
    sms: app.get(FakeSmsProvider),
    close: async () => {
      await app.close();
    },
  };
}
