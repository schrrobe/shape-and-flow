import { Controller, Get, UseGuards } from '@nestjs/common';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { CurrentUser, OfficeRoute, OfficeSessionGuard } from '../auth/office-session.guard.js';
import { RefundCapabilityGuard } from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';

import { DashboardService } from './dashboard.service.js';

import type { OfficeSession } from '../auth/session.store.js';
import type { OfficeDashboardResponse } from '@shape-and-flow/booking-contracts';

/** `GET /office/dashboard`. Scoped to the caller's own calendar for an EMPLOYEE. */
@Controller('office')
@OfficeRoute()
@UseGuards(OfficeSessionGuard, CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  async load(@CurrentUser() session: OfficeSession): Promise<OfficeDashboardResponse> {
    return await this.dashboard.load(session);
  }
}
