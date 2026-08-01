import { Module } from '@nestjs/common';

import { PublicModule } from '../public/public.module.js';

import { CustomerUpsertService } from './customer-upsert.service.js';
import { ReservationService } from './reservation.service.js';

/**
 * Booking mechanics: reserving, paying, confirming, expiring.
 *
 * Imports PublicModule for `AvailabilitySnapshotService`, which is the point — the
 * reservation re-check must use the same loader the availability endpoint does, or
 * "free" would eventually mean two different things.
 */
@Module({
  imports: [PublicModule],
  providers: [ReservationService, CustomerUpsertService],
  exports: [ReservationService, CustomerUpsertService],
})
export class BookingModule {}
