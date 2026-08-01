import { Module } from '@nestjs/common';

import { BookingModule } from '../booking/booking.module.js';
import { PublicModule } from '../public/public.module.js';

import { ManageCancelController } from './manage-cancel.controller.js';
import { ManageController } from './manage.controller.js';

/**
 * The customer's self-service surface.
 *
 * Imports the modules whose services its controllers drive: PublicModule for the
 * availability loader — a customer choosing a new slot must see exactly what the public
 * page shows — and BookingModule for cancellation and reschedule.
 *
 * The token service is deliberately *not* here; see ManagementTokenModule for why.
 */
@Module({
  imports: [PublicModule, BookingModule],
  controllers: [ManageController, ManageCancelController],
})
export class ManageModule {}
