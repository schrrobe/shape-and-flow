import { Module } from '@nestjs/common';

import { AvailabilitySnapshotService } from './availability-snapshot.service.js';
import { PublicAvailabilityController } from './public-availability.controller.js';
import { PublicCatalogController } from './public-catalog.controller.js';

/**
 * The unauthenticated surface.
 *
 * `AvailabilitySnapshotService` is exported because the reservation transaction
 * re-checks availability through `loadForSlot`, and it must be the same loader: two
 * implementations of "is this slot free" would eventually disagree, and the
 * disagreement would show up as a slot offered that cannot be booked.
 *
 * `PublicBookingsController` lives in this directory but is registered by
 * BookingModule, which owns everything it calls. Registering it here would make the
 * two modules mutually dependent and would drag the payment provider into every test
 * that only wants to read a catalog.
 */
@Module({
  controllers: [PublicCatalogController, PublicAvailabilityController],
  providers: [AvailabilitySnapshotService],
  exports: [AvailabilitySnapshotService],
})
export class PublicModule {}
