import { BookingOrigin, BookingStatus, Locale, OfficeUserRole } from '../../src/prisma/client.js';

import type { Prisma, PrismaClient } from '../../src/prisma/client.js';

/**
 * Fixtures for integration tests.
 *
 * A test should state only what it cares about, so every factory supplies a
 * complete, valid row and accepts overrides. Times are anchored on
 * 2026-08-14, a Friday inside German summer time (UTC+2), so 09:00 local is
 * 07:00Z — which makes the expected instants in assertions readable.
 */

export const BERLIN = 'Europe/Berlin';

/** 2026-08-14 09:00 Europe/Berlin. */
export const SLOT_FRIDAY_0900 = new Date('2026-08-14T07:00:00.000Z');

export interface SeedContext {
  organization: { id: string; slug: string };
  settings: { id: string };
  owner: { id: string };
  employee1: { id: string };
  employee2: { id: string };
  category: { id: string };
  service30: { id: string; name: string; priceCents: number };
  service60: { id: string; name: string; priceCents: number };
  customer: { id: string; email: string; phone: string | null };
}

let counter = 0;
const unique = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${String(counter)}`;
};

/**
 * Seed one complete organization: settings, an owner, two employees, a category,
 * two services, the employee-service links, and one customer.
 *
 * Pass a distinct slug to seed a second organization; several tests need two in
 * order to prove tenant isolation.
 */
export async function seedOrganization(
  prisma: PrismaClient,
  options: { slug?: string } = {},
): Promise<SeedContext> {
  const slug = options.slug ?? 'shape-and-flow';

  const organization = await prisma.organization.create({
    data: {
      slug,
      name: 'Shape and Flow',
      legalName: 'Shape and Flow GmbH',
      contactEmail: 'hallo@shape-and-flow.example',
      contactPhone: '+49301234567',
      whatsappNumber: '+4915112345678',
      addressLine1: 'Beispielstraße 1',
      postalCode: '10115',
      city: 'Berlin',
      defaultLocale: Locale.de,
    },
  });

  const settings = await prisma.organizationSettings.create({
    data: {
      organizationId: organization.id,
      officeNotificationEmail: 'buero@shape-and-flow.example',
    },
  });

  const employee1 = await prisma.employee.create({
    data: {
      organizationId: organization.id,
      firstName: 'Mara',
      lastName: 'Vogt',
      displayName: 'Mara Vogt',
      displayOrder: 0,
    },
  });

  const employee2 = await prisma.employee.create({
    data: {
      organizationId: organization.id,
      firstName: 'Jonas',
      lastName: 'Reit',
      displayName: 'Jonas Reit',
      displayOrder: 1,
    },
  });

  const owner = await prisma.officeUser.create({
    data: {
      organizationId: organization.id,
      email: `owner@${slug}.example`,
      // Not a real argon2id hash: no test in this suite verifies a password.
      passwordHash: 'placeholder-not-a-credential',
      firstName: 'Ola',
      lastName: 'Winter',
      role: OfficeUserRole.OWNER,
      canIssueRefunds: true,
    },
  });

  const category = await prisma.serviceCategory.create({
    data: { organizationId: organization.id, name: 'Massage', displayOrder: 0 },
  });

  const service30 = await prisma.service.create({
    data: {
      organizationId: organization.id,
      serviceCategoryId: category.id,
      name: 'Facial Massage 30 min',
      durationMinutes: 30,
      cleanupBufferMinutes: 5,
      priceCents: 4500,
      displayOrder: 0,
    },
  });

  const service60 = await prisma.service.create({
    data: {
      organizationId: organization.id,
      serviceCategoryId: category.id,
      name: 'Regular Massage 60 min',
      durationMinutes: 60,
      cleanupBufferMinutes: 10,
      priceCents: 7900,
      displayOrder: 1,
    },
  });

  for (const employeeId of [employee1.id, employee2.id]) {
    for (const serviceId of [service30.id, service60.id]) {
      await prisma.employeeService.create({
        data: { organizationId: organization.id, employeeId, serviceId },
      });
    }
  }

  // Monday–Friday 09:00–18:00 with a 12:00–12:30 break.
  for (const employeeId of [employee1.id, employee2.id]) {
    for (const weekday of ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const) {
      const segment = await prisma.workingHours.create({
        data: {
          organizationId: organization.id,
          employeeId,
          weekday,
          startMinute: 9 * 60,
          endMinute: 18 * 60,
        },
      });
      await prisma.break.create({
        data: {
          organizationId: organization.id,
          workingHoursId: segment.id,
          startMinute: 12 * 60,
          endMinute: 12 * 60 + 30,
          label: 'Mittagspause',
        },
      });
    }
  }

  const customer = await prisma.customer.create({
    data: {
      organizationId: organization.id,
      email: 'Anna@Example.com',
      emailNormalized: 'anna@example.com',
      firstName: 'Anna',
      lastName: 'Becker',
      phone: '+4915112345678',
      locale: Locale.de,
    },
  });

  return {
    organization,
    settings,
    owner,
    employee1,
    employee2,
    category,
    service30,
    service60,
    customer,
  };
}

export interface BookingOverrides {
  employeeId?: string;
  customerId?: string;
  serviceId?: string;
  status?: BookingStatus;
  startsAt?: Date;
  blockStartsAt?: Date;
  blockEndsAt?: Date;
  expiresAt?: Date | null;
  reference?: string;
  origin?: BookingOrigin;
}

/**
 * A valid booking row. Defaults to a 30-minute appointment at 09:00 local on
 * Friday 2026-08-14, held in PENDING_PAYMENT with a live expiry.
 *
 * `expiresAt` is derived from the status so the bookings_expires_at_matches_status
 * CHECK is satisfied by default — a test that wants to violate it must say so.
 */
export function makeBooking(
  ctx: SeedContext,
  overrides: BookingOverrides = {},
): Prisma.BookingUncheckedCreateInput {
  const status = overrides.status ?? BookingStatus.PENDING_PAYMENT;
  const startsAt = overrides.startsAt ?? SLOT_FRIDAY_0900;
  const durationMs = 30 * 60_000;
  const endsAt = new Date(startsAt.getTime() + durationMs);

  const blockStartsAt = overrides.blockStartsAt ?? startsAt;
  // Mirrors service30's 5-minute cleanup buffer.
  const blockEndsAt = overrides.blockEndsAt ?? new Date(endsAt.getTime() + 5 * 60_000);

  const needsExpiry = status === BookingStatus.PENDING_PAYMENT || status === BookingStatus.EXPIRING;
  const defaultExpiry = needsExpiry ? new Date(startsAt.getTime() - 60 * 60_000) : null;
  const expiresAt = overrides.expiresAt !== undefined ? overrides.expiresAt : defaultExpiry;

  return {
    organizationId: ctx.organization.id,
    reference: overrides.reference ?? unique('SF-TEST'),
    origin: overrides.origin ?? BookingOrigin.ONLINE,
    customerId: overrides.customerId ?? ctx.customer.id,
    employeeId: overrides.employeeId ?? ctx.employee1.id,
    serviceId: overrides.serviceId ?? ctx.service30.id,
    startsAt,
    endsAt,
    blockStartsAt,
    blockEndsAt,
    serviceNameSnapshot: ctx.service30.name,
    durationMinutesSnapshot: 30,
    prepBufferMinutesSnapshot: 0,
    cleanupBufferMinutesSnapshot: 5,
    priceCentsSnapshot: ctx.service30.priceCents,
    currency: 'EUR',
    status,
    expiresAt,
    locale: Locale.de,
  };
}
