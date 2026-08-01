import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { BookingModule } from '../booking/booking.module.js';
import { InboxModule } from '../messaging/inbox/inbox.module.js';
import { OutboxModule } from '../messaging/outbox/outbox.module.js';
import { NotificationModule } from '../notification/notification.module.js';

import { CalendarController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

/**
 * The office API.
 *
 * Imports AuthModule because the guards named in `@UseGuards` are constructed in the
 * declaring module's injector — and the rest because the dashboard's operations block
 * reads its figures from the components that already compute them, rather than restating
 * queries that would be a second definition of "stuck".
 */
@Module({
  imports: [AuthModule, BookingModule, OutboxModule, InboxModule, NotificationModule],
  controllers: [DashboardController, CalendarController],
  providers: [DashboardService, CalendarService],
  exports: [DashboardService, CalendarService],
})
export class OfficeModule {}
