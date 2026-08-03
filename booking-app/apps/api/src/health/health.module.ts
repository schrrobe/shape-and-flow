import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { AuthModule } from '../auth/auth.module.js';
import { InboxModule } from '../messaging/inbox/inbox.module.js';
import { OutboxModule } from '../messaging/outbox/outbox.module.js';
import { NotificationModule } from '../notification/notification.module.js';

import { HealthDetailController } from './health-detail.controller.js';
import { HealthController } from './health.controller.js';
import { MigrationIndicator } from './migration.indicator.js';
import { OperationsService } from './operations.service.js';
import { QueueHealthIndicator } from './queue.indicator.js';

/**
 * The three health routes.
 *
 * AuthModule is imported because the guards named in `@UseGuards` are constructed
 * in the injector of the module that declares them; the other three because the
 * operational counters come from the components that already own their definitions
 * rather than from queries restated here.
 */
@Module({
  imports: [TerminusModule, AuthModule, OutboxModule, InboxModule, NotificationModule],
  controllers: [HealthController, HealthDetailController],
  providers: [QueueHealthIndicator, MigrationIndicator, OperationsService],
  exports: [OperationsService],
})
export class HealthModule {}
