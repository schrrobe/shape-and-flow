import { randomBytes } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { PrismaPg } from '@prisma/adapter-pg';

import { ARGON2_OPTIONS } from '../src/auth/password.options.js';
import { loadEnvFile } from '../src/config/load-dotenv.js';
import { Locale, OfficeUserRole, Prisma, PrismaClient, Weekday } from '../src/prisma/client.js';

/**
 * Seeds one demonstrable business.
 *
 * Idempotent: writes use natural uniques or stable seed ids. A transaction-level
 * advisory lock serializes concurrent seed runs, while compatibility lookups
 * reuse employees and schedules created by the original seed version without
 * imposing false business uniqueness on names.
 *
 * Run with `pnpm db:seed`, which invokes tsx directly rather than going through
 * `prisma db seed`. The CLI wrapper adds nothing here — the seed needs no
 * Prisma CLI service — and it was observed hanging after the child had already
 * exited successfully. prisma.config.ts still declares the seed command so
 * `prisma migrate reset` keeps working.
 */

loadEnvFile();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy booking-app/.env.example to booking-app/.env.');
}

const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const SLUG = 'shape-and-flow';
const WEEKDAYS = [
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
] as const;

/** Local date, stored as a date-only column. */
const localDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

async function seed(prisma: Prisma.TransactionClient): Promise<void> {
  const organization = await prisma.organization.upsert({
    where: { slug: SLUG },
    update: {},
    create: {
      slug: SLUG,
      name: 'Shape and Flow',
      legalName: 'Shape and Flow GmbH',
      contactEmail: 'hallo@shape-and-flow.example',
      contactPhone: '+49301234567',
      whatsappNumber: '+4915112345678',
      addressLine1: 'Beispielstraße 1',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
      timezone: 'Europe/Berlin',
      currency: 'EUR',
      defaultLocale: Locale.de,
    },
  });
  const organizationId = organization.id;

  await prisma.organizationSettings.upsert({
    where: { organizationId },
    update: {},
    create: { organizationId, officeNotificationEmail: 'buero@shape-and-flow.example' },
  });

  // ── owner ─────────────────────────────────────────────────────────────────
  const ownerEmail = 'owner@shape-and-flow.example';
  const existingOwner = await prisma.officeUser.findUnique({
    where: { organizationId_email: { organizationId, email: ownerEmail } },
  });

  // A generated password is printed once rather than hard-coded, so a seeded
  // database is not a known-credentials database.
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? randomBytes(12).toString('base64url');
  let ownerPasswordWasSet = false;

  if (!existingOwner) {
    await prisma.officeUser.create({
      data: {
        organizationId,
        email: ownerEmail,
        passwordHash: await hash(ownerPassword, ARGON2_OPTIONS),
        firstName: 'Ola',
        lastName: 'Winter',
        role: OfficeUserRole.OWNER,
        canIssueRefunds: true,
      },
    });
    ownerPasswordWasSet = true;
  }

  // ── employees ─────────────────────────────────────────────────────────────
  const employeeSeeds = [
    {
      id: 'seed-employee-mara-vogt',
      firstName: 'Mara',
      lastName: 'Vogt',
      displayOrder: 0,
      worksSaturday: true,
    },
    {
      id: 'seed-employee-jonas-reit',
      firstName: 'Jonas',
      lastName: 'Reit',
      displayOrder: 1,
      worksSaturday: false,
    },
  ];

  const employees = [];
  for (const seed of employeeSeeds) {
    const displayName = `${seed.firstName} ${seed.lastName}`;
    const legacyEmployee = await prisma.employee.findFirst({
      where: { organizationId, displayName },
    });
    const employee =
      legacyEmployee ??
      (await prisma.employee.upsert({
        where: { id: seed.id },
        update: {},
        create: {
          id: seed.id,
          organizationId,
          firstName: seed.firstName,
          lastName: seed.lastName,
          displayName,
          displayOrder: seed.displayOrder,
          bio: 'Massage therapist.',
        },
      }));

    employees.push({ ...employee, worksSaturday: seed.worksSaturday });
  }

  // ── catalog ───────────────────────────────────────────────────────────────
  const category = await prisma.serviceCategory.upsert({
    where: { organizationId_name: { organizationId, name: 'Massage' } },
    update: {},
    create: { organizationId, name: 'Massage', displayOrder: 0 },
  });

  const serviceSeeds = [
    {
      name: 'Facial Massage 30 min',
      durationMinutes: 30,
      cleanupBufferMinutes: 5,
      priceCents: 4500,
      displayOrder: 0,
    },
    {
      name: 'Regular Massage 60 min',
      durationMinutes: 60,
      cleanupBufferMinutes: 10,
      priceCents: 7900,
      displayOrder: 1,
    },
  ];

  const services = [];
  for (const seed of serviceSeeds) {
    services.push(
      await prisma.service.upsert({
        where: { organizationId_name: { organizationId, name: seed.name } },
        update: {},
        create: { organizationId, serviceCategoryId: category.id, ...seed },
      }),
    );
  }

  // Every employee performs every service.
  for (const employee of employees) {
    for (const service of services) {
      await prisma.employeeService.upsert({
        where: { employeeId_serviceId: { employeeId: employee.id, serviceId: service.id } },
        update: {},
        create: { organizationId, employeeId: employee.id, serviceId: service.id },
      });
    }
  }

  // ── working hours ─────────────────────────────────────────────────────────
  // Monday–Friday 09:00–18:00 with a 12:00–12:30 break; Saturday 10:00–14:00
  // for Mara only, so "different employees have different availability" is
  // demonstrable straight after seeding.
  for (const employee of employees) {
    const segments: { weekday: Weekday; startMinute: number; endMinute: number }[] = WEEKDAYS.map(
      (weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 18 * 60 }),
    );

    if (employee.worksSaturday) {
      segments.push({ weekday: Weekday.SATURDAY, startMinute: 10 * 60, endMinute: 14 * 60 });
    }

    for (const segment of segments) {
      const segmentId = `seed-hours-${employee.id}-${segment.weekday.toLowerCase()}`;
      const legacySegment = await prisma.workingHours.findFirst({
        where: { organizationId, employeeId: employee.id, ...segment },
      });
      const created =
        legacySegment ??
        (await prisma.workingHours.upsert({
          where: { id: segmentId },
          update: {},
          create: { id: segmentId, organizationId, employeeId: employee.id, ...segment },
        }));

      // Saturday is a short shift with no lunch break.
      if (segment.weekday !== Weekday.SATURDAY) {
        const legacyBreak = await prisma.break.findFirst({
          where: {
            organizationId,
            workingHoursId: created.id,
            startMinute: 12 * 60,
            endMinute: 12 * 60 + 30,
          },
        });
        if (!legacyBreak) {
          await prisma.break.upsert({
            where: { id: `${segmentId}-lunch` },
            update: {},
            create: {
              id: `${segmentId}-lunch`,
              organizationId,
              workingHoursId: created.id,
              startMinute: 12 * 60,
              endMinute: 12 * 60 + 30,
              label: 'Mittagspause',
            },
          });
        }
      }
    }
  }

  // ── closures ──────────────────────────────────────────────────────────────
  const closures = [
    { date: '2026-10-03', reason: 'Tag der Deutschen Einheit' },
    { date: '2026-12-25', reason: 'Erster Weihnachtstag' },
  ];

  for (const closure of closures) {
    await prisma.closedDay.upsert({
      where: { organizationId_date: { organizationId, date: localDate(closure.date) } },
      update: {},
      create: { organizationId, date: localDate(closure.date), reason: closure.reason },
    });
  }

  // ── summary ───────────────────────────────────────────────────────────────
  const [employeeCount, serviceCount, closedDayCount] = await Promise.all([
    prisma.employee.count({ where: { organizationId } }),
    prisma.service.count({ where: { organizationId } }),
    prisma.closedDay.count({ where: { organizationId } }),
  ]);

  const lines = [
    '',
    `Seeded organization : ${organization.name} (${SLUG})`,
    `Employees           : ${String(employeeCount)}`,
    `Services            : ${String(serviceCount)}`,
    `Closed days         : ${String(closedDayCount)}`,
    `Owner login         : ${ownerEmail}`,
    ownerPasswordWasSet
      ? `Owner password      : ${ownerPassword}   <- shown once, change it after first login`
      : 'Owner password      : (unchanged — the owner already existed)',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  await client.$transaction(
    async (prisma) => {
      // Select a supported scalar rather than PostgreSQL's void lock result,
      // which the Prisma PG adapter cannot deserialize.
      await prisma.$queryRaw`
        SELECT 1::integer
        FROM (SELECT pg_advisory_xact_lock(hashtext(${'shape-and-flow-seed'}))) AS seed_lock
      `;
      await seed(prisma);
    },
    { maxWait: 30_000, timeout: 30_000 },
  );
}

try {
  await main();
} finally {
  await client.$disconnect();
}
