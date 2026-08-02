import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { BookingModule } from '../booking/booking.module.js';
import { InboxModule } from '../messaging/inbox/inbox.module.js';
import { OutboxModule } from '../messaging/outbox/outbox.module.js';
import { NotificationModule } from '../notification/notification.module.js';
import { PaymentModule } from '../payment/payment.module.js';

import { AvailabilityAdminController } from './availability-admin.controller.js';
import { AvailabilityAdminService } from './availability-admin.service.js';
import { CalendarController } from './calendar.controller.js';
import { CalendarService } from './calendar.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { CustomersController } from './customers.controller.js';
import { CustomersService } from './customers.service.js';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { EmployeesController } from './employees.controller.js';
import { EmployeesService } from './employees.service.js';
import { ExportsController } from './exports.controller.js';
import { ExportsService } from './exports.service.js';
import { OfficeBookingsController } from './office-bookings.controller.js';
import { OfficeBookingsService } from './office-bookings.service.js';
import { OfficeUsersController } from './office-users.controller.js';
import { OfficeUsersService } from './office-users.service.js';
import { RequestsController } from './requests.controller.js';
import { RequestsService } from './requests.service.js';
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
  imports: [
    AuthModule,
    BookingModule,
    PaymentModule,
    OutboxModule,
    InboxModule,
    NotificationModule,
  ],
  controllers: [
    DashboardController,
    CalendarController,
    EmployeesController,
    AvailabilityAdminController,
    CatalogController,
    SettingsController,
    OfficeUsersController,
    // Before the two `office` controllers that declare `:id` segments of their own:
    // `office/bookings` and `office/exports` are literal prefixes, and Express resolves
    // by registration order rather than specificity.
    OfficeBookingsController,
    ExportsController,
    RequestsController,
    CustomersController,
  ],
  providers: [
    DashboardService,
    CalendarService,
    EmployeesService,
    AvailabilityAdminService,
    CatalogService,
    SettingsService,
    OfficeUsersService,
    OfficeBookingsService,
    RequestsService,
    CustomersService,
    ExportsService,
  ],
  exports: [
    DashboardService,
    CalendarService,
    EmployeesService,
    CatalogService,
    OfficeBookingsService,
  ],
})
export class OfficeModule {}
