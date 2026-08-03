import { Controller, Get, Inject, Logger, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { availabilityQuerySchema } from '@shape-and-flow/booking-contracts';

import { AppError } from '../common/errors/app-error.js';
import { Public } from '../common/guards/public.decorator.js';
import { generateAvailability } from '../domain/availability/engine.js';
import { CLOCK } from '../domain/time/clock.js';
import { addLocalDays, instantToLocalDate } from '../domain/time/local-time.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';

import { AvailabilitySnapshotService } from './availability-snapshot.service.js';

import type { Clock } from '../domain/time/clock.js';
import type { AvailabilityResponse } from '@shape-and-flow/booking-contracts';

/** 60 requests a minute per IP: a booking page browsing months, not a scraper. */
const AVAILABILITY_LIMIT = { default: { limit: 60, ttl: 60_000 } };

@Controller('public')
@Public()
export class PublicAvailabilityController {
  private readonly logger = new Logger('Availability');

  constructor(
    private readonly snapshots: AvailabilitySnapshotService,
    private readonly organizations: OrganizationContextService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('availability')
  @Throttle(AVAILABILITY_LIMIT)
  async availability(@Query() rawQuery: unknown): Promise<AvailabilityResponse> {
    // Parsed here rather than by a global pipe so the query object is narrowed before
    // anything touches it, and so an `organizationId` a client invents is stripped
    // rather than reaching a `where` clause.
    const query = availabilityQuerySchema.parse(rawQuery);

    this.assertWithinHorizon(query.from);

    const snapshot = await this.snapshots.load(query);
    const result = generateAvailability(snapshot, query.from, query.to);

    if (result.skipped.length > 0) {
      // Only ever non-empty around a DST transition. Logged rather than returned:
      // a customer has no use for it, and an operator asking why a Sunday looks thin
      // does.
      this.logger.debug(
        `skipped ${String(result.skipped.length)} local times without a valid instant`,
      );
    }

    return {
      serviceId: query.serviceId,
      timezone: snapshot.zone,
      // Written out field by field. A model spread here is how an internal booking id
      // or a customer name reaches a public response.
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

  /**
   * Refuse a range that starts beyond the booking horizon.
   *
   * The engine already clamps its output to the horizon, so without this a request
   * for next year would succeed with an empty list — indistinguishable from a fully
   * booked week. A caller deserves to be told the difference.
   */
  private assertWithinHorizon(from: string): void {
    const settings = this.organizations.getSettings();
    const zone = this.organizations.getTimezone();
    const today = instantToLocalDate(this.clock.now(), zone);

    // The same helper and the same zone the engine uses to clamp, so the boundary this
    // refuses at and the boundary the engine stops at cannot drift apart.
    const horizonEnd = addLocalDays(today, settings.bookingHorizonDays, zone);

    if (from > horizonEnd) {
      throw new AppError('OUTSIDE_BOOKING_WINDOW', {
        message: `Bookings open ${String(settings.bookingHorizonDays)} days ahead. The latest bookable date is ${horizonEnd}.`,
        details: { latestBookableDate: horizonEnd },
      });
    }
  }
}
