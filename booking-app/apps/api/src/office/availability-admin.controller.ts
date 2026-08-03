import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  blockedTimeListQuerySchema,
  closedDayListQuerySchema,
  createBlockedTimeSchema,
  createClosedDaySchema,
  createTimeOffSchema,
  timeOffListQuerySchema,
  updateTimeOffSchema,
} from '@shape-and-flow/booking-contracts';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { CurrentUser, OfficeRoute, OfficeSessionGuard } from '../auth/office-session.guard.js';
import { RefundCapabilityGuard } from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Audited } from '../common/audit/audit.interceptor.js';

import { AvailabilityAdminService } from './availability-admin.service.js';

import type { OfficeSession } from '../auth/session.store.js';
import type {
  BlockedTime,
  BlockedTimeListResponse,
  ClosedDay,
  ClosedDayListResponse,
  TimeOffEntry,
  TimeOffListResponse,
} from '@shape-and-flow/booking-contracts';

/**
 * Blocked time, leave and closures.
 *
 * The role split follows §6.5 and follows how a studio works. An **employee** may block
 * their own time — an hour at the dentist is theirs to record — and may read their own
 * leave, but may not approve it. **Closed days** are the business's, so `OWNER` and
 * `ADMIN` only.
 *
 * "Own" is a property of the row rather than of the route, so the narrowing happens in
 * the service through `EmployeeScopeService`, and reaching a colleague's row answers
 * 404 rather than 403.
 */
@Controller('office')
@OfficeRoute()
@UseGuards(OfficeSessionGuard, CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
export class AvailabilityAdminController {
  constructor(private readonly availability: AvailabilityAdminService) {}

  /* ── blocked time ───────────────────────────────────────────────────────────── */

  @Get('blocked-times')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  async listBlockedTimes(
    @CurrentUser() session: OfficeSession,
    @Query() rawQuery: unknown,
  ): Promise<BlockedTimeListResponse> {
    return await this.availability.listBlockedTimes(
      session,
      blockedTimeListQuerySchema.parse(rawQuery),
    );
  }

  @Post('blocked-times')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  @Audited({ action: 'BLOCKED_TIME_CREATED', entityType: 'BlockedTime' })
  async createBlockedTime(
    @CurrentUser() session: OfficeSession,
    @Body() body: unknown,
  ): Promise<BlockedTime> {
    return await this.availability.createBlockedTime(session, createBlockedTimeSchema.parse(body));
  }

  @Delete('blocked-times/:id')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  @Audited({ action: 'BLOCKED_TIME_DELETED', entityType: 'BlockedTime' })
  async deleteBlockedTime(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
  ): Promise<void> {
    await this.availability.deleteBlockedTime(session, id);
  }

  /* ── time off ───────────────────────────────────────────────────────────────── */

  @Get('time-off')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  async listTimeOff(
    @CurrentUser() session: OfficeSession,
    @Query() rawQuery: unknown,
  ): Promise<TimeOffListResponse> {
    return await this.availability.listTimeOff(session, timeOffListQuerySchema.parse(rawQuery));
  }

  @Post('time-off')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'TIME_OFF_CREATED', entityType: 'TimeOff' })
  async createTimeOff(
    @CurrentUser() session: OfficeSession,
    @Body() body: unknown,
  ): Promise<TimeOffEntry> {
    return await this.availability.createTimeOff(session, createTimeOffSchema.parse(body));
  }

  @Patch('time-off/:id')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'TIME_OFF_UPDATED', entityType: 'TimeOff' })
  async updateTimeOff(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<TimeOffEntry> {
    return await this.availability.updateTimeOff(session, id, updateTimeOffSchema.parse(body));
  }

  /* ── closed days ────────────────────────────────────────────────────────────── */

  @Get('closed-days')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  async listClosedDays(
    @CurrentUser() session: OfficeSession,
    @Query() rawQuery: unknown,
  ): Promise<ClosedDayListResponse> {
    return await this.availability.listClosedDays(
      session,
      closedDayListQuerySchema.parse(rawQuery),
    );
  }

  @Post('closed-days')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'CLOSED_DAY_CREATED', entityType: 'ClosedDay' })
  async createClosedDay(
    @CurrentUser() session: OfficeSession,
    @Body() body: unknown,
  ): Promise<ClosedDay> {
    return await this.availability.createClosedDay(session, createClosedDaySchema.parse(body));
  }

  @Delete('closed-days/:id')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'CLOSED_DAY_DELETED', entityType: 'ClosedDay' })
  async deleteClosedDay(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
  ): Promise<void> {
    await this.availability.deleteClosedDay(session, id);
  }
}
