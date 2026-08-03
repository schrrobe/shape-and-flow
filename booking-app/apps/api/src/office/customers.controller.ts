import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  auditLogQuerySchema,
  customerListQuerySchema,
  updateCustomerSchema,
} from '@shape-and-flow/booking-contracts';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { CurrentUser, OfficeRoute } from '../auth/office-session.guard.js';
import { RefundCapabilityGuard } from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';

import { CustomersService } from './customers.service.js';

import type { OfficeSession } from '../auth/session.store.js';
import type {
  AuditLogResponse,
  CustomerListResponse,
  EraseCustomerResponse,
  OfficeCustomer,
  OfficeCustomerDetail,
} from '@shape-and-flow/booking-contracts';

/**
 * `/office/customers` and `/office/audit-log`.
 *
 * Customers are `OWNER` and `ADMIN`: an employee sees the names on their own
 * appointments and has no reason to page through the whole address book.
 *
 * **Erasure is `OWNER` only**, and the audit log with it. Erasure is irreversible and
 * the log is the record of who did what — including who erased whom — so the two belong
 * to the same person.
 */
@Controller('office')
@UseGuards(CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
@OfficeRoute()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get('customers')
  @Roles('OWNER', 'ADMIN')
  async list(@Query() rawQuery: unknown): Promise<CustomerListResponse> {
    return await this.customers.list(customerListQuerySchema.parse(rawQuery));
  }

  @Get('customers/:id')
  @Roles('OWNER', 'ADMIN')
  async detail(@Param('id') id: string): Promise<OfficeCustomerDetail> {
    return await this.customers.detail(id);
  }

  // No `@Audited`: the service writes its own row inside the transaction that changes
  // the customer, which is stronger than the interceptor's after-the-fact write — and
  // both would mean two rows for one edit.
  @Patch('customers/:id')
  @Roles('OWNER', 'ADMIN')
  async update(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OfficeCustomer> {
    return await this.customers.update(id, session.officeUserId, updateCustomerSchema.parse(body));
  }

  @Post('customers/:id/erase')
  @Roles('OWNER')
  async erase(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
  ): Promise<EraseCustomerResponse> {
    return await this.customers.erase(id, session.officeUserId);
  }

  @Get('audit-log')
  @Roles('OWNER')
  async auditLog(@Query() rawQuery: unknown): Promise<AuditLogResponse> {
    return await this.customers.auditLog(auditLogQuerySchema.parse(rawQuery));
  }
}
