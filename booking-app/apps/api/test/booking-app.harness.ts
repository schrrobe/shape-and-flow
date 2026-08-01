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
import { OutboxRecorder } from '../src/messaging/outbox/outbox.recorder.js';
import { OrganizationContextService } from '../src/organization/organization-context.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FakePaymentProvider } from '../src/providers/payment/fake-payment.provider.js';
import { PAYMENT_PROVIDER } from '../src/providers/payment/payment-provider.js';
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
    OutboxRecorder,
    IdempotencyService,
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
    OutboxRecorder,
    IdempotencyService,
  ],
})
// A Nest module is a declaration carrier with an empty body by design.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class BookingTestHarnessModule {}

export interface BookingTestApp {
  app: INestApplication;
  server: () => Server;
  payments: FakePaymentProvider;
  close: () => Promise<void>;
}

export async function createBookingTestApp(options: {
  organization: OrganizationWithSettings;
  clock: FixedClock;
  extraImports?: NonNullable<Parameters<typeof Test.createTestingModule>[0]['imports']>;
}): Promise<BookingTestApp> {
  currentOrganization = options.organization;
  currentClock = options.clock;

  const moduleRef = await Test.createTestingModule({
    imports: [
      BookingTestHarnessModule,
      PublicModule,
      BookingModule,
      ...(options.extraImports ?? []),
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    server: () => app.getHttpServer() as Server,
    payments: app.get(FakePaymentProvider),
    close: async () => {
      await app.close();
    },
  };
}
