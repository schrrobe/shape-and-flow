import { Module } from '@nestjs/common';

import { BookingModule } from './booking/booking.module.js';
import { AuditRetentionService } from './common/audit/audit-retention.service.js';
import { LoggingModule } from './common/logging/logger.module.js';
import { ConfigModule } from './config/config.module.js';
import { DomainModule } from './domain/domain.module.js';
import { IdempotencyModule } from './messaging/idempotency/idempotency.module.js';
import { InboxModule } from './messaging/inbox/inbox.module.js';
import { OutboxModule } from './messaging/outbox/outbox.module.js';
import { QueuesModule } from './messaging/queues/queues.module.js';
import { SchedulerService } from './messaging/queues/scheduler.service.js';
import { WorkerRegistrarService } from './messaging/queues/worker-registrar.service.js';
import { NotificationModule } from './notification/notification.module.js';
import { OrganizationModule } from './organization/organization.module.js';
import { PaymentModule } from './payment/payment.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProvidersModule } from './providers/providers.module.js';

/**
 * The worker process's container.
 *
 * Deliberately not `AppModule` with the workers switched on. The difference is the point:
 * this module imports no controller module, so the process has no routes, no guards and no
 * rate limiter, and cannot be reached over the network at all. The API process is the mirror
 * image — it imports no registrar, so it cannot pick up a job even if one is waiting.
 *
 * That split is what makes the two safe to scale independently. A traffic spike adds API
 * replicas without adding competition for the same jobs; a backlog adds worker replicas
 * without adding processes that accept requests.
 *
 * `ManagementTokenModule` is absent from this list and still available: it is `@Global`, and
 * the reminder service mints tokens through it.
 */
@Module({
  imports: [
    ConfigModule,
    LoggingModule,
    PrismaModule,
    QueuesModule,
    OrganizationModule,
    DomainModule,
    ProvidersModule,
    OutboxModule,
    InboxModule,
    IdempotencyModule,
    BookingModule,
    PaymentModule,
    NotificationModule,
  ],
  providers: [WorkerRegistrarService, SchedulerService, AuditRetentionService],
})
export class WorkerModule {}
