import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { GlobalExceptionFilter } from './common/errors/global-exception.filter.js';
import { LoggingModule } from './common/logging/logger.module.js';
import { ConfigModule } from './config/config.module.js';
import { DomainModule } from './domain/domain.module.js';
import { HealthModule } from './health/health.module.js';
import { InboxModule } from './messaging/inbox/inbox.module.js';
import { OutboxModule } from './messaging/outbox/outbox.module.js';
import { QueuesModule } from './messaging/queues/queues.module.js';
import { OrganizationModule } from './organization/organization.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProvidersModule } from './providers/providers.module.js';

/** The HTTP application. Queue processors live in WorkerModule instead. */
@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    PrismaModule,
    QueuesModule,
    OutboxModule,
    InboxModule,
    DomainModule,
    OrganizationModule,
    ProvidersModule,
    HealthModule,
  ],
  providers: [
    // Registered as a provider rather than with useGlobalFilters so it can take
    // dependencies later without changing how it is wired.
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
