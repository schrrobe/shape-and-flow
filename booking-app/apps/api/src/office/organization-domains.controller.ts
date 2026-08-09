import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { createOrganizationDomainSchema } from '@shape-and-flow/booking-contracts';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { OfficeRoute } from '../auth/office-session.guard.js';
import { RefundCapabilityGuard } from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Audited, recordAuditDetail } from '../common/audit/audit.interceptor.js';

import { OrganizationDomainsService } from './organization-domains.service.js';

import type {
  OrganizationDomainListResponse,
  OrganizationDomainMutationResponse,
} from '@shape-and-flow/booking-contracts';
import type { Request } from 'express';

/**
 * `/office/domains` — `OWNER` only, every route.
 *
 * A domain decides which organization an unauthenticated visitor is served as, so this
 * is closer to user management than to settings: not "how the booking flow behaves" but
 * "who it answers as". `ADMIN` configures the former and does not get the latter.
 */
@Controller('office/domains')
@UseGuards(CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
@OfficeRoute()
export class OrganizationDomainsController {
  constructor(private readonly domains: OrganizationDomainsService) {}

  @Get()
  @Roles('OWNER')
  async list(): Promise<OrganizationDomainListResponse> {
    return await this.domains.list();
  }

  @Post()
  @Roles('OWNER')
  @Audited({ action: 'ORGANIZATION_DOMAIN_ADDED', entityType: 'OrganizationDomain' })
  async add(
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<OrganizationDomainMutationResponse> {
    const created = await this.domains.add(createOrganizationDomainSchema.parse(body));
    recordAuditDetail(request, { entityId: created.domain.id, summary: created.domain.hostname });

    return created;
  }

  @Delete(':id')
  @Roles('OWNER')
  @Audited({ action: 'ORGANIZATION_DOMAIN_REMOVED', entityType: 'OrganizationDomain' })
  async remove(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<OrganizationDomainMutationResponse> {
    const removed = await this.domains.remove(id);
    recordAuditDetail(request, { entityId: id, summary: removed.domain.hostname });

    return removed;
  }
}
