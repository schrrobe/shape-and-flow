import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { updateOfficeSettingsSchema } from '@shape-and-flow/booking-contracts';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { OfficeRoute, OfficeSessionGuard } from '../auth/office-session.guard.js';
import { RefundCapabilityGuard } from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Audited, recordAuditDetail } from '../common/audit/audit.interceptor.js';

import { SettingsService } from './settings.service.js';

import type { OfficeSettingsResponse } from '@shape-and-flow/booking-contracts';
import type { Request } from 'express';

/**
 * `/office/settings` — `OWNER` only, both verbs.
 *
 * Reading is restricted as tightly as writing, deliberately: the row carries the office
 * notification address and the retention period, and an admin who can read the policy
 * they cannot change gains nothing an owner wanted them to have.
 */
@Controller('office/settings')
@OfficeRoute()
@UseGuards(OfficeSessionGuard, CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @Roles('OWNER')
  read(): OfficeSettingsResponse {
    return this.settings.read();
  }

  @Patch()
  @Roles('OWNER')
  @Audited({ action: 'SETTINGS_UPDATED', entityType: 'OrganizationSettings' })
  async update(@Req() request: Request, @Body() body: unknown): Promise<OfficeSettingsResponse> {
    // Captured before the write. Settings are the one place where "what was it before"
    // is the entire value of the trail: a booking horizon that changed under somebody
    // is invisible in the row that replaced it.
    const before = this.settings.read();
    const after = await this.settings.update(updateOfficeSettingsSchema.parse(body));

    recordAuditDetail(request, { entityId: before.organization.id, before, after });

    return after;
  }
}
