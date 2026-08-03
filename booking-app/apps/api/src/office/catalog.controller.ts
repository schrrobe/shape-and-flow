import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  createServiceCategorySchema,
  createServiceSchema,
  serviceCategoryListQuerySchema,
  serviceListQuerySchema,
  updateServiceCategorySchema,
  updateServiceSchema,
} from '@shape-and-flow/booking-contracts';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { OfficeRoute } from '../auth/office-session.guard.js';
import { RefundCapabilityGuard } from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Audited, recordAuditDetail } from '../common/audit/audit.interceptor.js';

import { CatalogService } from './catalog.service.js';

import type {
  OfficeService,
  OfficeServiceCategory,
  OfficeServiceCategoryListResponse,
  OfficeServiceListResponse,
} from '@shape-and-flow/booking-contracts';
import type { Request } from 'express';

/**
 * `/office/services` and `/office/service-categories`.
 *
 * No `DELETE` on either, which is the whole design: a booking's foreign key points at
 * these rows, so retiring something is `POST :id/archive` and the row stays. What a
 * customer was sold is already snapshotted on their booking, so history reads correctly
 * either way — but the join for the office's own detail view does not.
 */
@Controller('office')
@UseGuards(CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
@OfficeRoute()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  /* ── categories ─────────────────────────────────────────────────────────────── */

  @Get('service-categories')
  @Roles('OWNER', 'ADMIN')
  async listCategories(@Query() rawQuery: unknown): Promise<OfficeServiceCategoryListResponse> {
    const query = serviceCategoryListQuerySchema.parse(rawQuery);
    return await this.catalog.listCategories(query.includeArchived);
  }

  @Post('service-categories')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'SERVICE_CATEGORY_CREATED', entityType: 'ServiceCategory' })
  async createCategory(@Body() body: unknown): Promise<OfficeServiceCategory> {
    return await this.catalog.createCategory(createServiceCategorySchema.parse(body));
  }

  @Patch('service-categories/:id')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'SERVICE_CATEGORY_UPDATED', entityType: 'ServiceCategory' })
  async updateCategory(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OfficeServiceCategory> {
    recordAuditDetail(request, { before: await this.categoryBefore(id) });

    return await this.catalog.updateCategory(id, updateServiceCategorySchema.parse(body));
  }

  @Post('service-categories/:id/archive')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'SERVICE_CATEGORY_ARCHIVED', entityType: 'ServiceCategory' })
  async archiveCategory(@Param('id') id: string): Promise<OfficeServiceCategory> {
    return await this.catalog.archiveCategory(id);
  }

  /* ── services ───────────────────────────────────────────────────────────────── */

  @Get('services')
  @Roles('OWNER', 'ADMIN')
  async listServices(@Query() rawQuery: unknown): Promise<OfficeServiceListResponse> {
    return await this.catalog.listServices(serviceListQuerySchema.parse(rawQuery));
  }

  @Get('services/:id')
  @Roles('OWNER', 'ADMIN')
  async getService(@Param('id') id: string): Promise<OfficeService> {
    return await this.catalog.getService(id);
  }

  @Post('services')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'SERVICE_CREATED', entityType: 'Service' })
  async createService(@Body() body: unknown): Promise<OfficeService> {
    return await this.catalog.createService(createServiceSchema.parse(body));
  }

  @Patch('services/:id')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'SERVICE_UPDATED', entityType: 'Service' })
  async updateService(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OfficeService> {
    // A price change is exactly the kind of edit somebody asks about six months later,
    // and the response alone cannot answer "from what".
    recordAuditDetail(request, { before: await this.catalog.getService(id) });

    return await this.catalog.updateService(id, updateServiceSchema.parse(body));
  }

  @Post('services/:id/archive')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'SERVICE_ARCHIVED', entityType: 'Service' })
  async archiveService(@Param('id') id: string): Promise<OfficeService> {
    return await this.catalog.archiveService(id);
  }

  /** The one category, found through the list so the count comes with it. */
  private async categoryBefore(id: string): Promise<OfficeServiceCategory | undefined> {
    const { items } = await this.catalog.listCategories(true);
    return items.find((category) => category.id === id);
  }
}
