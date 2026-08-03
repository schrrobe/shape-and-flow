import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  createAvailabilityExceptionSchema,
  createEmployeeSchema,
  employeeListQuerySchema,
  replaceEmployeeServicesSchema,
  replaceWorkingHoursSchema,
  updateEmployeeSchema,
} from '@shape-and-flow/booking-contracts';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { OfficeRoute, OfficeSessionGuard } from '../auth/office-session.guard.js';
import { RefundCapabilityGuard } from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Audited, recordAuditDetail } from '../common/audit/audit.interceptor.js';

import { EmployeesService } from './employees.service.js';

import type {
  AvailabilityExceptionListResponse,
  CreateAvailabilityExceptionResponse,
  EmployeeListResponse,
  EmployeeServicesResponse,
  OfficeEmployee,
  ReplaceWorkingHoursResponse,
} from '@shape-and-flow/booking-contracts';
import type { Request } from 'express';

/**
 * `/office/employees`.
 *
 * Reading the list is open to all three roles — an employee's own booking page needs
 * names beside appointments — while every write is `OWNER` or `ADMIN`. An employee
 * editing their own hours is deliberately not a feature: the rota is the business's,
 * and "I extended my Friday" is a decision with a customer on the other end of it.
 */
@Controller('office/employees')
@OfficeRoute()
@UseGuards(OfficeSessionGuard, CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  async list(@Query() rawQuery: unknown): Promise<EmployeeListResponse> {
    const query = employeeListQuerySchema.parse(rawQuery);
    return await this.employees.list(query.includeArchived);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  async get(@Param('id') id: string): Promise<OfficeEmployee> {
    return await this.employees.get(id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'EMPLOYEE_CREATED', entityType: 'Employee' })
  async create(@Body() body: unknown): Promise<OfficeEmployee> {
    return await this.employees.create(createEmployeeSchema.parse(body));
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'EMPLOYEE_UPDATED', entityType: 'Employee' })
  async update(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<OfficeEmployee> {
    // Read before the write, because the interceptor can see the result and the path
    // but has no way to know what the row used to be — and "who changed the display
    // name, from what" is the whole reason the trail exists.
    const before = await this.employees.get(id);
    recordAuditDetail(request, { before });

    return await this.employees.update(id, updateEmployeeSchema.parse(body));
  }

  @Post(':id/archive')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'EMPLOYEE_ARCHIVED', entityType: 'Employee' })
  async archive(@Param('id') id: string): Promise<OfficeEmployee> {
    return await this.employees.archive(id);
  }

  @Put(':id/working-hours')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'WORKING_HOURS_REPLACED', entityType: 'WorkingHours' })
  async replaceWorkingHours(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ReplaceWorkingHoursResponse> {
    recordAuditDetail(request, { entityId: id, summary: `working hours replaced for ${id}` });

    return await this.employees.replaceWorkingHours(id, replaceWorkingHoursSchema.parse(body));
  }

  @Get(':id/services')
  @Roles('OWNER', 'ADMIN')
  async listServices(@Param('id') id: string): Promise<EmployeeServicesResponse> {
    return await this.employees.listServices(id);
  }

  @Put(':id/services')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'EMPLOYEE_SERVICES_REPLACED', entityType: 'EmployeeService' })
  async replaceServices(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<EmployeeServicesResponse> {
    const before = await this.employees.listServices(id);
    recordAuditDetail(request, { entityId: id, before });

    return await this.employees.replaceServices(id, replaceEmployeeServicesSchema.parse(body));
  }

  @Get(':id/availability-exceptions')
  @Roles('OWNER', 'ADMIN')
  async listExceptions(@Param('id') id: string): Promise<AvailabilityExceptionListResponse> {
    return await this.employees.listAvailabilityExceptions(id);
  }

  @Post(':id/availability-exceptions')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'AVAILABILITY_EXCEPTION_CREATED', entityType: 'AvailabilityException' })
  async createException(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CreateAvailabilityExceptionResponse> {
    const created = await this.employees.createAvailabilityException(
      id,
      createAvailabilityExceptionSchema.parse(body),
    );

    // The response is nested, so the interceptor's "id from the body" fallback would
    // find nothing and file the row under the employee id instead.
    recordAuditDetail(request, { entityId: created.exception.id });

    return created;
  }

  @Delete(':employeeId/availability-exceptions/:id')
  @Roles('OWNER', 'ADMIN')
  @Audited({ action: 'AVAILABILITY_EXCEPTION_DELETED', entityType: 'AvailabilityException' })
  async deleteException(
    @Param('employeeId') employeeId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.employees.deleteAvailabilityException(employeeId, id);
  }
}
