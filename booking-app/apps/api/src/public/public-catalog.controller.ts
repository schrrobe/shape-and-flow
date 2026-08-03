import { Controller, Get, Param } from '@nestjs/common';
import { cuidSchema } from '@shape-and-flow/booking-contracts';

import { AppError } from '../common/errors/app-error.js';
import { Public } from '../common/guards/public.decorator.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type {
  OrganizationCurrentResponse,
  ServiceCategoryListResponse,
  ServiceEmployeesResponse,
  ServiceListResponse,
} from '@shape-and-flow/booking-contracts';

/** A service a customer may book online: not archived, and offered online. */
const bookableService = { archivedAt: null, isBookableOnline: true };

/**
 * The catalog a booking page renders before anyone picks a slot.
 *
 * Every response is assembled field by field. That is not ceremony: these are the
 * only endpoints in the application that answer an unauthenticated caller with rows
 * from tables that also hold employee emails and customer records, and a spread of a
 * Prisma model is exactly how one of those ends up on the wire the day a column is
 * added.
 */
@Controller('public')
@Public()
export class PublicCatalogController {
  constructor(
    // The root client with an explicit organizationId in every `where`. The resolved
    // context is the only source of that id; nothing here reads one from the request.
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
  ) {}

  /**
   * `GET /public/organizations/current`.
   *
   * Named `current` rather than taking an id, because no endpoint anywhere accepts an
   * organization identifier — a collection form would be a lie and an id form would
   * be an invitation.
   */
  @Get('organizations/current')
  current(): OrganizationCurrentResponse {
    const organization = this.organizations.get();
    const settings = organization.settings;

    return {
      id: organization.id,
      name: organization.name,
      timezone: organization.timezone,
      currency: organization.currency,
      defaultLocale: organization.defaultLocale,
      address: {
        line1: organization.addressLine1,
        line2: organization.addressLine2,
        postalCode: organization.postalCode,
        city: organization.city,
        country: organization.country,
      },
      contactEmail: organization.contactEmail,
      contactPhone: organization.contactPhone,
      whatsappNumber: organization.whatsappNumber,
      // Policy, so the front end can explain the rules before a request fails on them.
      bookingHorizonDays: settings.bookingHorizonDays,
      minimumNoticeHours: settings.minimumNoticeHours,
      freeCancellationHours: settings.freeCancellationHours,
      customerNoteEnabled: settings.customerNoteEnabled,
    };
  }

  @Get('service-categories')
  async categories(): Promise<ServiceCategoryListResponse> {
    const organizationId = this.organizations.getOrganizationId();

    const rows = await this.prisma.serviceCategory.findMany({
      where: { organizationId, archivedAt: null },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        displayOrder: true,
        // Nested rather than a second query per category: this is the one place an
        // N+1 would be easy to write and invisible until the catalog grows.
        services: {
          where: bookableService,
          orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
          select: SERVICE_FIELDS,
        },
      },
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        displayOrder: row.displayOrder,
        services: row.services.map(toPublicService),
      })),
    };
  }

  @Get('services')
  async services(): Promise<ServiceListResponse> {
    const organizationId = this.organizations.getOrganizationId();

    const rows = await this.prisma.service.findMany({
      where: { organizationId, ...bookableService },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      select: SERVICE_FIELDS,
    });

    return { items: rows.map(toPublicService) };
  }

  /**
   * `GET /public/services/:serviceId/employees`.
   *
   * The price is per employee, because the join table carries an override. Resolving
   * it here rather than in the front end keeps one definition of what a customer will
   * be charged.
   */
  @Get('services/:serviceId/employees')
  async serviceEmployees(
    @Param('serviceId') rawServiceId: string,
  ): Promise<ServiceEmployeesResponse> {
    const organizationId = this.organizations.getOrganizationId();
    const serviceId = cuidSchema.parse(rawServiceId);

    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, organizationId, ...bookableService },
      select: { priceCents: true, currency: true },
    });

    // 404 without distinguishing "never existed" from "archived": an unauthenticated
    // caller does not get to enumerate ids by reading error codes.
    if (service === null) {
      throw new AppError('NOT_FOUND', { message: 'Service not found.' });
    }

    const links = await this.prisma.employeeService.findMany({
      where: {
        organizationId,
        serviceId,
        employee: { isBookableOnline: true, archivedAt: null },
      },
      orderBy: [{ employee: { displayOrder: 'asc' } }, { employee: { displayName: 'asc' } }],
      select: {
        priceOverrideCents: true,
        employee: {
          // Named explicitly. `employee: true` would include the email and the
          // office-user link.
          select: { id: true, displayName: true, bio: true, photoUrl: true, displayOrder: true },
        },
      },
    });

    return {
      items: links.map((link) => ({
        id: link.employee.id,
        displayName: link.employee.displayName,
        bio: link.employee.bio,
        photoUrl: link.employee.photoUrl,
        displayOrder: link.employee.displayOrder,
        price: {
          amountCents: link.priceOverrideCents ?? service.priceCents,
          currency: service.currency,
        },
      })),
    };
  }
}

/** The columns a public service projection needs, and only those. */
const SERVICE_FIELDS = {
  id: true,
  name: true,
  description: true,
  durationMinutes: true,
  priceCents: true,
  currency: true,
  serviceCategoryId: true,
  displayOrder: true,
} as const;

function toPublicService(row: {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  serviceCategoryId: string | null;
  displayOrder: number;
}): ServiceListResponse['items'][number] {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    durationMinutes: row.durationMinutes,
    price: { amountCents: row.priceCents, currency: row.currency },
    categoryId: row.serviceCategoryId,
    displayOrder: row.displayOrder,
  };
}
