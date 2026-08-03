import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { officeCalendarQuerySchema } from '@shape-and-flow/booking-contracts';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { CurrentUser, OfficeRoute } from '../auth/office-session.guard.js';
import { RefundCapabilityGuard } from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';

import { CalendarService } from './calendar.service.js';

import type { OfficeSession } from '../auth/session.store.js';
import type { OfficeCalendarResponse } from '@shape-and-flow/booking-contracts';

/**
 * `GET /office/calendar`.
 *
 * Open to all three roles, and scoped rather than filtered: an employee reaches this
 * route and sees their own calendar. The narrowing happens in the service, because
 * "their own" is a property of the rows rather than of the route.
 */
@Controller('office')
@UseGuards(CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
@OfficeRoute()
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('calendar')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  async load(
    @CurrentUser() session: OfficeSession,
    @Query() rawQuery: unknown,
  ): Promise<OfficeCalendarResponse> {
    // Parsed before anything is read, so a range nobody meant to ask for is refused
    // rather than served slowly.
    const query = officeCalendarQuerySchema.parse(rawQuery);

    return await this.calendar.load(session, query);
  }
}
