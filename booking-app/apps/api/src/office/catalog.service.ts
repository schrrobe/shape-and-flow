import { Inject, Injectable } from '@nestjs/common';

import { BLOCKING_BOOKING_STATUSES } from '../booking/booking-status.machine.js';
import { AppError } from '../common/errors/app-error.js';
import { isUniqueViolation } from '../common/prisma-errors/prisma-errors.js';
import { CLOCK } from '../domain/time/clock.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { Clock } from '../domain/time/clock.js';
import type {
  CreateServiceRequest,
  CreateServiceCategoryRequest,
  OfficeService,
  OfficeServiceCategory,
  OfficeServiceCategoryListResponse,
  OfficeServiceListResponse,
  ServiceListQuery,
  UpdateServiceRequest,
  UpdateServiceCategoryRequest,
} from '@shape-and-flow/booking-contracts';

/**
 * What the business sells.
 *
 * **Archive, never delete.** Every booking snapshots the name, duration, buffers and
 * price it was sold at, so a past appointment survives its service being retired — but
 * the row itself is still what a booking's foreign key points at, and what the office
 * detail view joins to. Deleting it would either cascade away history or fail on the
 * constraint; archiving takes it out of the catalog and leaves the record intact.
 *
 * Two archive refusals, and they guard different things. A **service** with future
 * appointments cannot be archived because those appointments still have to happen. A
 * **category** with live services cannot be archived because doing so would orphan them
 * from the grouping the booking page renders — the services would quietly lose their
 * heading rather than disappear, which is the kind of change nobody notices until a
 * customer does.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /* ── categories ─────────────────────────────────────────────────────────────── */

  async listCategories(includeArchived: boolean): Promise<OfficeServiceCategoryListResponse> {
    const rows = await this.prisma.serviceCategory.findMany({
      where: {
        organizationId: this.organizationId(),
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      select: {
        id: true,
        name: true,
        description: true,
        displayOrder: true,
        archivedAt: true,
        // Nested rather than a second query per row, which is the difference between
        // one round trip and one per category.
        _count: { select: { services: { where: { archivedAt: null } } } },
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        displayOrder: row.displayOrder,
        archivedAt: row.archivedAt?.toISOString() ?? null,
        activeServiceCount: row._count.services,
      })),
    };
  }

  async createCategory(input: CreateServiceCategoryRequest): Promise<OfficeServiceCategory> {
    const row = await this.guardName(
      async () =>
        await this.prisma.serviceCategory.create({
          data: {
            organizationId: this.organizationId(),
            name: input.name,
            ...optional('description', input.description),
            ...optional('displayOrder', input.displayOrder),
          },
        }),
    );

    return { ...toCategoryDto(row), activeServiceCount: 0 };
  }

  async updateCategory(
    id: string,
    patch: UpdateServiceCategoryRequest,
  ): Promise<OfficeServiceCategory> {
    await this.loadCategory(id);

    const row = await this.guardName(
      async () =>
        await this.prisma.serviceCategory.update({
          where: { id },
          data: {
            ...optional('name', patch.name),
            ...optional('description', patch.description),
            ...optional('displayOrder', patch.displayOrder),
          },
          include: { _count: { select: { services: { where: { archivedAt: null } } } } },
        }),
    );

    return { ...toCategoryDto(row), activeServiceCount: row._count.services };
  }

  async archiveCategory(id: string): Promise<OfficeServiceCategory> {
    const category = await this.loadCategory(id);

    const serviceCount = await this.prisma.service.count({
      where: { organizationId: this.organizationId(), serviceCategoryId: id, archivedAt: null },
    });

    if (serviceCount > 0) {
      throw new AppError('CATEGORY_NOT_EMPTY', {
        message: 'Archive or move the services in this category first.',
        details: { serviceCount },
      });
    }

    if (category.archivedAt !== null) {
      return { ...toCategoryDto(category), activeServiceCount: 0 };
    }

    const row = await this.prisma.serviceCategory.update({
      where: { id },
      data: { archivedAt: this.clock.now() },
    });

    return { ...toCategoryDto(row), activeServiceCount: 0 };
  }

  /* ── services ───────────────────────────────────────────────────────────────── */

  async listServices(query: ServiceListQuery): Promise<OfficeServiceListResponse> {
    const rows = await this.prisma.service.findMany({
      where: {
        organizationId: this.organizationId(),
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...(query.serviceCategoryId === undefined
          ? {}
          : { serviceCategoryId: query.serviceCategoryId }),
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });

    return { items: rows.map(toServiceDto) };
  }

  async getService(id: string): Promise<OfficeService> {
    return toServiceDto(await this.loadService(id));
  }

  async createService(input: CreateServiceRequest): Promise<OfficeService> {
    const organizationId = this.organizationId();
    await this.assertCategoryUsable(input.serviceCategoryId);

    const row = await this.guardName(
      async () =>
        await this.prisma.service.create({
          data: {
            organizationId,
            name: input.name,
            durationMinutes: input.durationMinutes,
            priceCents: input.priceCents,
            currency: this.organizations.get().currency,
            ...optional('description', input.description),
            ...optional('serviceCategoryId', input.serviceCategoryId),
            ...optional('prepBufferMinutes', input.prepBufferMinutes),
            ...optional('cleanupBufferMinutes', input.cleanupBufferMinutes),
            ...optional('isBookableOnline', input.isBookableOnline),
            ...optional('displayOrder', input.displayOrder),
          },
        }),
    );

    return toServiceDto(row);
  }

  async updateService(id: string, patch: UpdateServiceRequest): Promise<OfficeService> {
    await this.loadService(id);
    if (patch.serviceCategoryId !== undefined && patch.serviceCategoryId !== null) {
      await this.assertCategoryUsable(patch.serviceCategoryId);
    }

    const row = await this.guardName(
      async () =>
        await this.prisma.service.update({
          where: { id },
          data: {
            ...optional('name', patch.name),
            ...optional('description', patch.description),
            ...optional('serviceCategoryId', patch.serviceCategoryId),
            ...optional('durationMinutes', patch.durationMinutes),
            ...optional('prepBufferMinutes', patch.prepBufferMinutes),
            ...optional('cleanupBufferMinutes', patch.cleanupBufferMinutes),
            ...optional('priceCents', patch.priceCents),
            ...optional('isBookableOnline', patch.isBookableOnline),
            ...optional('displayOrder', patch.displayOrder),
          },
        }),
    );

    return toServiceDto(row);
  }

  /**
   * Retire a service.
   *
   * Refused while appointments that still have to happen reference it. Past
   * appointments are no obstacle: they carry their own snapshot of what was sold, so
   * they read back correctly long after the service has gone.
   */
  async archiveService(id: string): Promise<OfficeService> {
    const service = await this.loadService(id);
    if (service.archivedAt !== null) return toServiceDto(service);

    const bookingCount = await this.prisma.booking.count({
      where: {
        organizationId: this.organizationId(),
        serviceId: id,
        status: { in: [...BLOCKING_BOOKING_STATUSES] },
        endsAt: { gt: this.clock.now() },
      },
    });

    if (bookingCount > 0) {
      throw new AppError('SERVICE_HAS_FUTURE_BOOKINGS', {
        message: 'Appointments for this service are still to come.',
        details: { bookingCount },
      });
    }

    return toServiceDto(
      await this.prisma.service.update({
        where: { id },
        data: { archivedAt: this.clock.now() },
      }),
    );
  }

  /* ── internals ──────────────────────────────────────────────────────────────── */

  private async loadCategory(id: string): Promise<{
    id: string;
    name: string;
    description: string | null;
    displayOrder: number;
    archivedAt: Date | null;
  }> {
    const category = await this.prisma.serviceCategory.findFirst({
      where: { id, organizationId: this.organizationId() },
    });

    if (category === null) throw notFound('Service category not found.');
    return category;
  }

  private async loadService(id: string): Promise<Parameters<typeof toServiceDto>[0]> {
    const service = await this.prisma.service.findFirst({
      where: { id, organizationId: this.organizationId() },
    });

    if (service === null) throw notFound('Service not found.');
    return service;
  }

  /** A service may not be filed under a category that has been retired. */
  private async assertCategoryUsable(categoryId: string | null | undefined): Promise<void> {
    if (categoryId === null || categoryId === undefined) return;

    const category = await this.loadCategory(categoryId);
    if (category.archivedAt !== null) {
      throw notFound('Service category not found.');
    }
  }

  /**
   * Turn a duplicate name into a 400 naming the field.
   *
   * `@@unique([organizationId, name])` is what actually enforces it, because two
   * requests racing a pre-check would both pass. A 400 rather than a 409: from the
   * caller's side this is a form field with a bad value, not a state conflict they
   * could resolve by retrying.
   */
  private async guardName<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error, 'name')) {
        throw new AppError('VALIDATION_FAILED', {
          message: 'That name is already in use.',
          details: { issues: [{ path: ['name'], message: 'already in use', code: 'duplicate' }] },
        });
      }
      throw error;
    }
  }

  private organizationId(): string {
    return this.organizations.getOrganizationId();
  }
}

function toCategoryDto(row: {
  id: string;
  name: string;
  description: string | null;
  displayOrder: number;
  archivedAt: Date | null;
}): Omit<OfficeServiceCategory, 'activeServiceCount'> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    displayOrder: row.displayOrder,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

function toServiceDto(row: {
  id: string;
  serviceCategoryId: string | null;
  name: string;
  description: string | null;
  durationMinutes: number;
  prepBufferMinutes: number;
  cleanupBufferMinutes: number;
  priceCents: number;
  currency: string;
  isBookableOnline: boolean;
  displayOrder: number;
  archivedAt: Date | null;
}): OfficeService {
  return {
    id: row.id,
    serviceCategoryId: row.serviceCategoryId,
    name: row.name,
    description: row.description,
    durationMinutes: row.durationMinutes,
    prepBufferMinutes: row.prepBufferMinutes,
    cleanupBufferMinutes: row.cleanupBufferMinutes,
    price: { amountCents: row.priceCents, currency: row.currency },
    isBookableOnline: row.isBookableOnline,
    displayOrder: row.displayOrder,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/** Present only when the caller sent it. See the note in `employees.service.ts`. */
function optional<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Record<Key, Value> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}

function notFound(message: string): AppError {
  return new AppError('NOT_FOUND', { message });
}
