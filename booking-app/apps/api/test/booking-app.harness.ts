import { Global, Module } from '@nestjs/common';
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
import { OrganizationContextService } from '../src/organization/organization-context.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { EMAIL_PROVIDER } from '../src/providers/email/email-provider.js';
import { FakeEmailProvider } from '../src/providers/email/fake-email.provider.js';
import { FakePaymentProvider } from '../src/providers/payment/fake-payment.provider.js';
import { PAYMENT_PROVIDER } from '../src/providers/payment/payment-provider.js';
import { FakeSmsProvider } from '../src/providers/sms/fake-sms.provider.js';
import { SMS_PROVIDER } from '../src/providers/sms/sms-provider.js';
import { PublicModule } from '../src/public/public.module.js';

import { prisma } from './database.harness.js';

import type { AppConfig } from '../src/config/env.schema.js';
import type { OrganizationWithSettings } from '../src/organization/organization-context.service.js';
import type { INestApplication } from '@nestjs/common';
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

let currentOrganization: OrganizationWithSettings | null = null;
let currentClock: FixedClock | null = null;

function organizationStub(): Partial<OrganizationContextService> {
  const read = (): OrganizationWithSettings => {
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
  PAYMENT_PROVIDER: 'fake',
  EMAIL_PROVIDER: 'fake',
  SMS_PROVIDER: 'fake',
  RESEND_WEBHOOK_SECRET: 'test-resend-secret',
  TWILIO_AUTH_TOKEN: 'test-twilio-token',
} as unknown as AppConfig;

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
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
    { provide: QUEUE_REGISTRY, useFactory: () => recordingQueueRegistry() },
    EnqueueService,
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
  ],
})
// A Nest module is a declaration carrier with an empty body by design.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class BookingTestHarnessModule {}

/** Every job the harness's queues were asked to add, in order. */
export const enqueued: { name: string; data: unknown; options: unknown }[] = [];

/**
 * A queue registry that records rather than connects.
 *
 * Deliberately not a real BullMQ queue: what these tests assert is which jobs the
 * webhook decides to enqueue, and standing up Redis to observe that would make a slow
 * suite prove something the queue suite already proves against a real server.
 */
function recordingQueueRegistry(): Record<string, unknown> {
  const queue = {
    add: (name: string, data: unknown, options: unknown) => {
      enqueued.push({ name, data, options });
      return Promise.resolve({ id: 'recorded' });
    },
    name: 'recording',
  };

  return Object.fromEntries(QUEUES.map((queueName) => [queueName, queue]));
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
}): Promise<BookingTestApp> {
  currentOrganization = options.organization;
  currentClock = options.clock;
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
