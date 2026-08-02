import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';

import { AuthModule } from './auth/auth.module.js';
import { BookingModule } from './booking/booking.module.js';
import { AuditModule } from './common/audit/audit.module.js';
import { GlobalExceptionFilter } from './common/errors/global-exception.filter.js';
import { AuthGuard } from './common/guards/auth.guard.js';
import { LoggingModule } from './common/logging/logger.module.js';
import { InFlightRequests } from './common/shutdown/inflight.js';
import { ShutdownService } from './common/shutdown/shutdown.service.js';
import { ThrottlingModule } from './common/throttling/throttling.module.js';
import { ConfigModule } from './config/config.module.js';
import { DomainModule } from './domain/domain.module.js';
import { HealthModule } from './health/health.module.js';
import { ManageModule } from './manage/manage.module.js';
import { IdempotencyModule } from './messaging/idempotency/idempotency.module.js';
import { InboxModule } from './messaging/inbox/inbox.module.js';
import { OutboxModule } from './messaging/outbox/outbox.module.js';
import { QueuesModule } from './messaging/queues/queues.module.js';
import { NotificationModule } from './notification/notification.module.js';
import { OfficeModule } from './office/office.module.js';
import { OrganizationModule } from './organization/organization.module.js';
import { PaymentModule } from './payment/payment.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { PublicModule } from './public/public.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';

/** The HTTP application. Queue processors live in WorkerModule instead. */
@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    PrismaModule,
    QueuesModule,
    ThrottlingModule,
    OutboxModule,
    InboxModule,
    IdempotencyModule,
    DomainModule,
    OrganizationModule,
    ProvidersModule,
    HealthModule,
    AuditModule,
    AuthModule,
    PublicModule,
    BookingModule,
    ManageModule,
    OfficeModule,
    PaymentModule,
    NotificationModule,
    WebhooksModule,
  ],
  providers: [
    // Registered as a provider rather than with useGlobalFilters so it can take
    // dependencies later without changing how it is wired.
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    // The graceful stop. Its middleware is mounted in main.ts, because the counter
    // has to see a request before any guard can reject it.
    InFlightRequests,
    ShutdownService,
    // Order matters: guards run in registration order, so the cheap in-memory
    // authorisation check happens before the one that talks to Redis.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
