import { Global, Module } from '@nestjs/common';

import { ManagementTokenGuard } from './management-token.guard.js';
import { ManagementTokenService } from './management-token.service.js';

/**
 * The token service, on its own.
 *
 * Separate from ManageModule to break a cycle rather than to organise files. Bookings
 * need to *mint* tokens — confirmation issues one, reschedule rotates one — while the
 * `/manage` controllers need to *spend* them and also need the booking services they
 * drive. One module holding both would make BookingModule and ManageModule mutually
 * dependent; this one is imported by each and imports neither.
 */
@Global()
@Module({
  providers: [ManagementTokenService, ManagementTokenGuard],
  exports: [ManagementTokenService, ManagementTokenGuard],
})
export class ManagementTokenModule {}
