import { Module } from '@nestjs/common';

import { ManagementTokenModule } from '../manage/management-token.module.js';
import { PublicBookingsController } from '../public/public-bookings.controller.js';
import { PublicModule } from '../public/public.module.js';

import { BookingCheckoutService } from './booking-checkout.service.js';
import { BookingConfirmationService } from './booking-confirmation.service.js';
import { CustomerUpsertService } from './customer-upsert.service.js';
import { ExpiryService } from './expiry.service.js';
import { ExpirySweeper } from './expiry.sweeper.js';
import { ExpiryProcessor } from './processors/expiry.processor.js';
import { StripeEventProcessor } from './processors/stripe-event.processor.js';
import { ReservationService } from './reservation.service.js';

/**
 * Booking mechanics: reserving, paying, confirming, expiring.
 *
 * Imports PublicModule for `AvailabilitySnapshotService`, which is the point — the
 * reservation re-check must use the same loader the availability endpoint does, or
 * "free" would eventually mean two different things.
 *
 * `POST /public/bookings` is registered here rather than in PublicModule even though it
 * sits under that path, because everything it calls lives here. The alternative is two
 * mutually dependent modules and a payment provider in every catalog test.
 */
@Module({
  imports: [PublicModule, ManagementTokenModule],
  controllers: [PublicBookingsController],
  providers: [
    ReservationService,
    CustomerUpsertService,
    BookingCheckoutService,
    BookingConfirmationService,
    StripeEventProcessor,
    ExpiryService,
    ExpirySweeper,
    ExpiryProcessor,
  ],
  exports: [
    ReservationService,
    CustomerUpsertService,
    BookingCheckoutService,
    BookingConfirmationService,
    StripeEventProcessor,
    ExpiryService,
    ExpirySweeper,
    ExpiryProcessor,
  ],
})
export class BookingModule {}
