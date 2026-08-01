import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { BookingModule } from '../booking/booking.module.js';
import { InboxModule } from '../messaging/inbox/inbox.module.js';
import { OutboxModule } from '../messaging/outbox/outbox.module.js';
import { NotificationModule } from '../notification/notification.module.js';

import { AvailabilityAdminController } from './availability-admin.controller.js';
import { AvailabilityAdminService } from './availability-admin.service.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { EmployeesController } from './employees.controller.js';
import { EmployeesService } from './employees.service.js';
import { OfficeUsersController } from './office-users.controller.js';
import { OfficeUsersService } from './office-users.service.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

/**
 * The office API.
 *
 * Imports AuthModule because the guards named in `@UseGuards` are constructed in the
 * declaring module's injector — and the rest because the dashboard's operations block
 * reads its figures from the components that already compute them, rather than restating
 * queries that would be a second definition of "stuck".
 *
 * Controller order matters more than it looks. `EmployeesController` is mounted on
 * `office/employees` while `AvailabilityAdminController` and `CatalogController` sit on
 * bare `office`, so their paths cannot collide — but a future controller on `office`
 * declaring `:id` would swallow `office/employees`, and Express resolves that by
 * registration order rather than by specificity.
 */
@Module({
  imports: [AuthModule, BookingModule, OutboxModule, InboxModule, NotificationModule],
  controllers: [
    DashboardController,
    CalendarController,
    EmployeesController,
    AvailabilityAdminController,
    CatalogController,
    SettingsController,
    OfficeUsersController,
  ],
  providers: [
    DashboardService,
    CalendarService,
    EmployeesService,
    AvailabilityAdminService,
    CatalogService,
    SettingsService,
    OfficeUsersService,
  ],
  exports: [DashboardService, CalendarService, EmployeesService, CatalogService],
})
export class OfficeModule {}
