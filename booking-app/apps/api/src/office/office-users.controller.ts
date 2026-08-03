import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  createOfficeUserSchema,
  officeUserListQuerySchema,
  updateOfficeUserSchema,
} from '@shape-and-flow/booking-contracts';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { CurrentUser, OfficeRoute } from '../auth/office-session.guard.js';
import { RefundCapabilityGuard } from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Audited, recordAuditDetail } from '../common/audit/audit.interceptor.js';

import { OfficeUsersService } from './office-users.service.js';

import type { OfficeSession } from '../auth/session.store.js';
import type {
  OfficeUserListResponse,
  OfficeUserMutationResponse,
} from '@shape-and-flow/booking-contracts';
import type { Request } from 'express';

/**
 * `/office/users` — `OWNER` only, every route.
 *
 * `canIssueRefunds` needs no separate check for "settable only by OWNER": there is no
 * other role that reaches this controller. That is the point of putting user management
 * behind one role rather than sprinkling capability checks through it.
 */
@Controller('office/users')
@UseGuards(CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
@OfficeRoute()
export class OfficeUsersController {
  constructor(private readonly users: OfficeUsersService) {}

  @Get()
  @Roles('OWNER')
  async list(@Query() rawQuery: unknown): Promise<OfficeUserListResponse> {
    const query = officeUserListQuerySchema.parse(rawQuery);
    return await this.users.list(query.includeArchived);
  }

  @Post()
  @Roles('OWNER')
  @Audited({ action: 'OFFICE_USER_CREATED', entityType: 'OfficeUser' })
  async create(
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<OfficeUserMutationResponse> {
    const created = await this.users.create(createOfficeUserSchema.parse(body));
    recordAuditDetail(request, { entityId: created.user.id });

    return created;
  }

  @Patch(':id')
  @Roles('OWNER')
  @Audited({ action: 'OFFICE_USER_UPDATED', entityType: 'OfficeUser' })
  async update(
    @Req() request: Request,
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OfficeUserMutationResponse> {
    const updated = await this.users.update(session, id, updateOfficeUserSchema.parse(body));
    recordAuditDetail(request, { entityId: id });

    return updated;
  }

  @Post(':id/archive')
  @Roles('OWNER')
  @Audited({ action: 'OFFICE_USER_ARCHIVED', entityType: 'OfficeUser' })
  async archive(
    @Req() request: Request,
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
  ): Promise<OfficeUserMutationResponse> {
    const archived = await this.users.archive(session, id);
    recordAuditDetail(request, { entityId: id });

    return archived;
  }
}
