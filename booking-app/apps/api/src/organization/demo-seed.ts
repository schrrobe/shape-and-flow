import { hash } from '@node-rs/argon2';
import { cuidSchema } from '@shape-and-flow/booking-contracts';

import { ARGON2_OPTIONS } from '../auth/password.options.js';
import { Locale, OfficeUserRole, PaymentsMode, Weekday } from '../prisma/client.js';

import type { PrismaClient } from '../prisma/client.js';

/**
 * One demonstrable business.
 *
 * Idempotent: every write is an upsert or a find-then-create keyed on a natural
 * unique, so running it twice changes no row counts. That matters because it runs
 * on every fresh developer database, in the deployment checklist, and — since the
 * end-to-end suite needs a known starting point — before every browser test.
 *
 * It lives under `src` rather than in `prisma/seed.ts` so both callers share one
 * definition of the demo business. Two definitions would drift, and the day they
 * did, a green e2e suite would be proving something about a business the developer
 * running `pnpm db:seed` never sees.
 */

/**
 * A fixed id, not a generated one.
 *
 * The organization is resolved once at bootstrap and cached, in the API process and in
 * the worker process independently — see organization-context.service.ts. The
 * end-to-end suite truncates and reseeds between tests, and with a generated id every
 * reset minted a new organization that both caches then pointed past: the API answered
 * an empty catalog and the worker wrote rows against an id that no longer existed.
 *
 * Pinning it makes a reseeded database the same organization rather than a lookalike.
 * It is also a small honesty improvement for development, where a dropped volume used
 * to invalidate every id anybody had written down.
 */
const DEMO_ORGANIZATION_ID = 'cm000000000000000demoorg';

const DEMO_SLUG = 'shape-and-flow';
const DEMO_OWNER_EMAIL = 'owner@shape-and-flow.example';
const DEMO_STAFF_EMAIL = 'mara@shape-and-flow.example';

const WEEKDAYS = [
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
] as const;

/** Local date, stored as a date-only column. */
const localDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

export interface DemoSeedOptions {
  /** Used only if the user does not exist yet; an existing password is never reset. */
  ownerPassword: string;
  staffPassword: string;
}

export interface DemoSeedResult {
  organizationId: string;
  slug: string;
  ownerEmail: string;
  staffEmail: string;
  /** False when the user already existed, so a caller knows not to print a password. */
  ownerPasswordWasSet: boolean;
  staffPasswordWasSet: boolean;
  employeeCount: number;
  serviceCount: number;
  closedDayCount: number;
}

export async function seedDemoOrganization(
  prisma: PrismaClient,
  options: DemoSeedOptions,
): Promise<DemoSeedResult> {
  const organization = await prisma.organization.upsert({
    where: { slug: DEMO_SLUG },
    // Only the payments mode, and only because a database seeded before Connect existed
    // holds the demo organization at the `CONNECT` column default with no Express account
    // behind it — which refuses every booking. Everything else is left alone: re-seeding
    // must not undo edits somebody made while demoing.
    update: { paymentsMode: PaymentsMode.PLATFORM },
    create: {
      id: DEMO_ORGANIZATION_ID,
      slug: DEMO_SLUG,
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
      // The demo tenant is not a Connect organizer and has no Express account to
      // onboard, so its checkout runs on the platform account. Left at the CONNECT
      // default it could never take a booking.
      paymentsMode: PaymentsMode.PLATFORM,
    },
  });
  const organizationId = organization.id;

  await prisma.organizationSettings.upsert({
    where: { organizationId },
    update: {},
    create: { organizationId, officeNotificationEmail: 'buero@shape-and-flow.example' },
  });

  // ── employees ───────────────────────────────────────────────────────────────
  // Ids are left to Prisma, which generates cuids.
  //
  // Readable ids like `seed-employee-mara-vogt` were convenient to grep for, but every
  // employee id in the contracts is validated with `cuidSchema` — including the
  // `employeeId` query parameter of `GET /public/availability`. A seeded id that is not a
  // cuid is therefore rejected by the very API the seed exists to demonstrate: the office
  // UI reads the employee, sends its id back, and the request fails validation. Nothing
  // outside this file referred to those literals.
  const employeeSeeds = [
    {
      firstName: 'Mara',
      lastName: 'Vogt',
      displayOrder: 0,
      worksSaturday: true,
    },
    {
      firstName: 'Jonas',
      lastName: 'Reit',
      displayOrder: 1,
      worksSaturday: false,
    },
  ];

  const employees = [];
  for (const seed of employeeSeeds) {
    const displayName = `${seed.firstName} ${seed.lastName}`;
    // Re-running the seed stays safe without an upsert key: the display name identifies a
    // seeded employee, so an earlier run's row is found rather than duplicated.
    const existing = await prisma.employee.findFirst({
      where: { organizationId, displayName },
    });

    // A row from before this change carries one of the old literal ids, and reusing it puts
    // the problem straight back: `officeEmployeeSchema.id` and the `employeeId` query
    // parameter both validate with `cuidSchema`, so the office employee list and every
    // availability request would fail on it — while the seed reported success.
    //
    // Rewriting the id in place would mean updating every dependent foreign key in one
    // transaction. That is a lot of machinery to carry forever for demo data, and the wrong
    // trade when the fix is one command. So refuse, and name the command.
    if (existing !== null && !cuidSchema.safeParse(existing.id).success) {
      throw new Error(
        `Employee "${displayName}" has the id "${existing.id}", which is not a cuid and ` +
          'comes from a seed that predates this file. Reusing it would break the office ' +
          'employee list and every availability request. Delete the demo employees, or ' +
          'reset the database with `pnpm --filter @shape-and-flow/booking-api exec prisma ' +
          'migrate reset`, then seed again.',
      );
    }

    const employee =
      existing ??
      (await prisma.employee.create({
        data: {
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

  // ── logins ──────────────────────────────────────────────────────────────────
  // An owner and a therapist. The second is not decoration: "an employee sees only
  // their own calendar and cannot reach settings" is a rule this product enforces,
  // and a seed with no EMPLOYEE login leaves it undemonstrable — and untestable
  // through the interface a real one uses.
  const ownerPasswordWasSet = await ensureUser(prisma, {
    organizationId,
    email: DEMO_OWNER_EMAIL,
    password: options.ownerPassword,
    firstName: 'Ola',
    lastName: 'Winter',
    role: OfficeUserRole.OWNER,
    canIssueRefunds: true,
  });

  const staffPasswordWasSet = await ensureUser(prisma, {
    organizationId,
    email: DEMO_STAFF_EMAIL,
    password: options.staffPassword,
    firstName: 'Mara',
    lastName: 'Vogt',
    role: OfficeUserRole.EMPLOYEE,
    canIssueRefunds: false,
    ...(employees[0] === undefined ? {} : { employeeId: employees[0].id }),
  });

  // ── catalog ─────────────────────────────────────────────────────────────────
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

  // ── working hours ───────────────────────────────────────────────────────────
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

  // ── closures ────────────────────────────────────────────────────────────────
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

  const [employeeCount, serviceCount, closedDayCount] = await Promise.all([
    prisma.employee.count({ where: { organizationId } }),
    prisma.service.count({ where: { organizationId } }),
    prisma.closedDay.count({ where: { organizationId } }),
  ]);

  return {
    organizationId,
    slug: DEMO_SLUG,
    ownerEmail: DEMO_OWNER_EMAIL,
    staffEmail: DEMO_STAFF_EMAIL,
    ownerPasswordWasSet,
    staffPasswordWasSet,
    employeeCount,
    serviceCount,
    closedDayCount,
  };
}

/** True when the user was created here, false when it already existed. */
async function ensureUser(
  prisma: PrismaClient,
  user: {
    organizationId: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    role: OfficeUserRole;
    canIssueRefunds: boolean;
    employeeId?: string;
  },
): Promise<boolean> {
  const existing = await prisma.officeUser.findUnique({
    where: { email: user.email },
    select: { organizationId: true },
  });

  // `officeUser.email` is unique across every tenant, so the address this seed wants can
  // already belong to somebody else's organization. Returning false there would report a
  // successful seed whose demo login does not exist and cannot be created — the operator
  // needs to know the address is taken rather than hunt for a password that never worked.
  if (existing && existing.organizationId !== user.organizationId) {
    throw new Error(
      `demo seed: ${user.email} already belongs to organization ${existing.organizationId}; free the address or seed with a different one`,
    );
  }

  // An existing password is never overwritten: re-seeding a database somebody is
  // already logged into must not silently rotate their credentials.
  if (existing) return false;

  const { password, ...rest } = user;
  await prisma.officeUser.create({
    data: { ...rest, passwordHash: await hash(password, ARGON2_OPTIONS) },
  });

  return true;
}
