import { Module } from '@nestjs/common';

import { AvailabilitySnapshotService } from './availability-snapshot.service.js';
import { PublicAvailabilityController } from './public-availability.controller.js';
import { PublicCatalogController } from './public-catalog.controller.js';

/**
 * The unauthenticated surface.
 *
 * `AvailabilitySnapshotService` is exported because the reservation transaction in
 * Task 5.2 re-checks availability through `loadForSlot`, and it must be the same
 * loader: two implementations of "is this slot free" would eventually disagree, and
 * the disagreement would show up as a slot offered that cannot be booked.
 */
@Module({
  controllers: [PublicCatalogController, PublicAvailabilityController],
  providers: [AvailabilitySnapshotService],
  exports: [AvailabilitySnapshotService],
})
export class PublicModule {}
