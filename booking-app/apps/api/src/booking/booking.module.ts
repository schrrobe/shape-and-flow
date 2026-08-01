import { Module } from '@nestjs/common';

import { PublicBookingsController } from '../public/public-bookings.controller.js';
import { PublicModule } from '../public/public.module.js';

import { BookingCheckoutService } from './booking-checkout.service.js';
import { BookingConfirmationService } from './booking-confirmation.service.js';
import { CustomerUpsertService } from './customer-upsert.service.js';
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
  imports: [PublicModule],
  controllers: [PublicBookingsController],
  providers: [
    ReservationService,
    CustomerUpsertService,
    BookingCheckoutService,
    BookingConfirmationService,
    StripeEventProcessor,
  ],
  exports: [
    ReservationService,
    CustomerUpsertService,
    BookingCheckoutService,
    BookingConfirmationService,
    StripeEventProcessor,
  ],
})
export class BookingModule {}
