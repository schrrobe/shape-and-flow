import { Controller, Get, Logger, Query, UseGuards } from '@nestjs/common';
import { availabilityQuerySchema } from '@shape-and-flow/booking-contracts';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { OfficeRoute } from '../auth/office-session.guard.js';
import { RefundCapabilityGuard } from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { generateAvailability } from '../domain/availability/engine.js';
import { asOfficeSnapshot } from '../domain/availability/office-view.js';
import { AvailabilitySnapshotService } from '../public/availability-snapshot.service.js';

import type { AvailabilityResponse } from '@shape-and-flow/booking-contracts';

/**
 * `GET /office/availability` — what the office may book, which is not what a customer is
 * offered.
 *
 * The difference is entirely `asOfficeSnapshot`: no minimum notice and no horizon. With
 * the default 24-hour notice, `/public/availability` cannot show this afternoon at all —
 * and this afternoon is precisely when somebody rings up asking to come in. Everything
 * else the engine enforces still applies, so a slot offered here is a slot
 * `POST /office/bookings` will accept.
 *
 * **The public query and response schemas are reused rather than copied.** The question
 * ("which slots for this service, these days, optionally this person") and the answer are
 * the same; a second pair would be a second copy of the 31-day range cap, and the copies
 * are what drift. Only the *rules* differ, and those live in the snapshot.
 *
 * `OWNER` and `ADMIN` only: the answer exists to be turned into a manual booking, and
 * `booking.create` is theirs (§10.5). No throttle — this sits behind a session, unlike
 * the public endpoint it mirrors.
 */
@Controller('office')
@UseGuards(CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
@OfficeRoute()
export class OfficeAvailabilityController {
  private readonly logger = new Logger('OfficeAvailability');

  constructor(private readonly snapshots: AvailabilitySnapshotService) {}

  @Get('availability')
  @Roles('OWNER', 'ADMIN')
  async availability(@Query() rawQuery: unknown): Promise<AvailabilityResponse> {
    const query = availabilityQuerySchema.parse(rawQuery);

    const snapshot = await this.snapshots.load(query);
    const result = generateAvailability(asOfficeSnapshot(snapshot), query.from, query.to);

    if (result.skipped.length > 0) {
      this.logger.debug(
        `skipped ${String(result.skipped.length)} local times without a valid instant`,
      );
    }

    return {
      serviceId: query.serviceId,
      timezone: snapshot.zone,
      // Field by field, like the public controller: a spread is how something the
      // response was never meant to carry gets out.
      days: result.days.map((day) => ({
        date: day.date,
        slots: day.slots.map((slot) => ({
          startsAt: slot.startsAt.toISOString(),
          endsAt: slot.endsAt.toISOString(),
          employeeIds: slot.employeeIds,
        })),
      })),
    };
  }
}
