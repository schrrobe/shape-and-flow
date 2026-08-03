import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module.js';
import { SessionStore } from '../../src/auth/session.store.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { OfficeModule } from '../../src/office/office.module.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { BERLIN, SLOT_FRIDAY_0900, makeBooking, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { queues, redis } from '../redis.harness.js';

import type { OfficeUserRole } from '../../src/prisma/client.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/**
 * `GET /api/office/availability`, beside the public route it mirrors.
 *
 * The point of the endpoint is a difference, so every test that matters here asks both
 * routes the same question. "Now" is **07:00 on the seeded Friday**: the working day
 * starts at 09:00, and the seeded settings keep the default 24-hour notice — so the whole
 * of today is invisible to a customer and has to be visible to the office.
 */

const FRIDAY = '2026-08-14';
const NOW = new Date('2026-08-14T05:00:00.000Z');

/** A Friday 364 days out — past the seeded 180-day horizon, still a working day. */
const FRIDAY_NEXT_YEAR = '2027-08-13';

const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;

let ctx: SeedContext;
let testApp: BookingTestApp;
let server: () => Server;
let sessions: SessionStore;

let userCounter = 0;

async function signedInAs(role: OfficeUserRole): Promise<string> {
  userCounter += 1;

  const user = await prisma.officeUser.create({
    data: {
      organizationId: ctx.organization.id,
      email: `${role.toLowerCase()}-${String(userCounter)}@shape-and-flow.example`,
      passwordHash: 'placeholder-not-a-credential',
      firstName: 'Test',
      lastName: role,
      role,
      canIssueRefunds: true,
    },
    select: { id: true },
  });

  const sid = await sessions.create({
    id: user.id,
    organizationId: ctx.organization.id,
    role,
    canIssueRefunds: true,
    employeeId: null,
  });

  return `sf_office_session=${sid}`;
}

interface SlotBody {
  serviceId: string;
  timezone: string;
  days: { date: string; slots: { startsAt: string; endsAt: string; employeeIds: string[] }[] }[];
}

/** Every start time in an answer. Empty for a refusal, which has no days to read. */
function startTimes(body: SlotBody | undefined): string[] {
  return (body?.days ?? []).flatMap((day) => day.slots.map((slot) => slot.startsAt));
}

/** The office's answer, as a flat list of ISO start times. */
async function officeSlots(
  cookie: string,
  query: Record<string, string>,
  expected = 200,
): Promise<string[]> {
  const response = await request(server())
    .get('/api/office/availability')
    .set('Cookie', cookie)
    .set(...CSRF)
    .query({ serviceId: ctx.service30.id, ...query })
    .expect(expected);

  return startTimes(response.body as SlotBody);
}

/** The same question, asked the way a customer's browser asks it. */
async function publicSlots(query: Record<string, string>, expected = 200): Promise<string[]> {
  const response = await request(server())
    .get('/api/public/availability')
    .query({ serviceId: ctx.service30.id, ...query })
    .expect(expected);

  return startTimes(response.body as SlotBody);
}

async function clearSessions(): Promise<void> {
  const keys = await redis.keys('session:*');
  if (keys.length > 0) await redis.del(...keys);
}

beforeEach(async () => {
  await resetDatabase();
  await clearSessions();

  ctx = await seedOrganization(prisma);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock: new FixedClock(NOW),
    // `OfficeModule` imports `PublicModule`, so the public route is mounted here too —
    // which is what lets a single test compare the two answers.
    extraImports: [AuthModule, OfficeModule],
    redis,
    queues,
    globalPrefix: 'api',
  });

  server = testApp.server;
  sessions = testApp.app.get(SessionStore);

  return testApp.close;
});

describe('what the office may book but a customer may not', () => {
  it('offers today, which the minimum-notice window hides from a customer', async () => {
    const cookie = await signedInAs('OWNER');

    // 07:00 with a 24-hour notice: the customer's earliest bookable moment is Saturday
    // morning, and the business is closed at weekends.
    expect(await publicSlots({ from: FRIDAY, to: FRIDAY })).toEqual([]);

    const office = await officeSlots(cookie, { from: FRIDAY, to: FRIDAY });
    expect(office).toContain(SLOT_FRIDAY_0900.toISOString());
  });

  it('offers a date past the booking horizon, which the customer is refused outright', async () => {
    const cookie = await signedInAs('OWNER');

    await publicSlots({ from: FRIDAY_NEXT_YEAR, to: FRIDAY_NEXT_YEAR }, 422);

    expect(
      (await officeSlots(cookie, { from: FRIDAY_NEXT_YEAR, to: FRIDAY_NEXT_YEAR })).length,
    ).toBeGreaterThan(0);
  });

  it('labels the answer with the organization zone, like the public one', async () => {
    const cookie = await signedInAs('OWNER');

    const response = await request(server())
      .get('/api/office/availability')
      .set('Cookie', cookie)
      .set(...CSRF)
      .query({ serviceId: ctx.service30.id, from: FRIDAY, to: FRIDAY })
      .expect(200);

    const body = response.body as SlotBody;
    expect(body.serviceId).toBe(ctx.service30.id);
    expect(body.timezone).toBe(BERLIN);
    expect(body.days[0]?.date).toBe(FRIDAY);
  });
});

describe('what still applies to the office', () => {
  it('does not offer a slot somebody already holds', async () => {
    const cookie = await signedInAs('OWNER');

    await prisma.booking.create({
      data: makeBooking(ctx, { employeeId: ctx.employee1.id, startsAt: SLOT_FRIDAY_0900 }),
    });

    const forEmployee1 = await officeSlots(cookie, {
      from: FRIDAY,
      to: FRIDAY,
      employeeId: ctx.employee1.id,
    });

    expect(forEmployee1).not.toContain(SLOT_FRIDAY_0900.toISOString());

    // And the slot itself survives for the person who is free, which is the whole point
    // of `employeeIds`.
    const forEmployee2 = await officeSlots(cookie, {
      from: FRIDAY,
      to: FRIDAY,
      employeeId: ctx.employee2.id,
    });
    expect(forEmployee2).toContain(SLOT_FRIDAY_0900.toISOString());
  });

  it('does not offer a blocked time', async () => {
    const cookie = await signedInAs('OWNER');

    await prisma.blockedTime.create({
      data: {
        organizationId: ctx.organization.id,
        employeeId: ctx.employee1.id,
        startsAt: SLOT_FRIDAY_0900,
        endsAt: new Date(SLOT_FRIDAY_0900.getTime() + 60 * 60_000),
        reason: 'Team training',
        createdByOfficeUserId: ctx.owner.id,
      },
    });

    expect(
      await officeSlots(cookie, { from: FRIDAY, to: FRIDAY, employeeId: ctx.employee1.id }),
    ).not.toContain(SLOT_FRIDAY_0900.toISOString());
  });

  it('offers nothing on a day the organization is closed', async () => {
    const cookie = await signedInAs('OWNER');

    await prisma.closedDay.create({
      data: {
        organizationId: ctx.organization.id,
        date: new Date(`${FRIDAY}T00:00:00.000Z`),
        reason: 'Betriebsferien',
      },
    });

    expect(await officeSlots(cookie, { from: FRIDAY, to: FRIDAY })).toEqual([]);
  });

  it('offers nothing outside the rota — no evening, no weekend', async () => {
    const cookie = await signedInAs('OWNER');

    const friday = await officeSlots(cookie, { from: FRIDAY, to: FRIDAY });

    // The seeded rota is 09:00–18:00 with a 30-minute break at noon. An office booking
    // is not a licence to write an appointment into somebody's evening.
    const outsideHours = friday.filter((startsAt) => {
      const hour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: BERLIN,
          hour: '2-digit',
          hourCycle: 'h23',
        }).format(new Date(startsAt)),
      );
      return hour < 9 || hour >= 18;
    });

    expect(outsideHours).toEqual([]);
    // 2026-08-15 is the Saturday after the seeded Friday.
    expect(await officeSlots(cookie, { from: '2026-08-15', to: '2026-08-15' })).toEqual([]);
  });

  it('404s a service that is not bookable online, which is what reserving would do', async () => {
    const cookie = await signedInAs('OWNER');

    await prisma.service.update({
      where: { id: ctx.service30.id },
      data: { isBookableOnline: false },
    });

    await officeSlots(cookie, { from: FRIDAY, to: FRIDAY }, 404);
  });

  it('refuses a range wider than 31 days', async () => {
    const cookie = await signedInAs('OWNER');

    const response = await request(server())
      .get('/api/office/availability')
      .set('Cookie', cookie)
      .set(...CSRF)
      .query({ serviceId: ctx.service30.id, from: '2026-08-01', to: '2026-09-15' })
      .expect(400);

    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('who may ask', () => {
  it('answers an admin and refuses an employee', async () => {
    await officeSlots(await signedInAs('ADMIN'), { from: FRIDAY, to: FRIDAY });

    const employee = await signedInAs('EMPLOYEE');
    const response = await request(server())
      .get('/api/office/availability')
      .set('Cookie', employee)
      .set(...CSRF)
      .query({ serviceId: ctx.service30.id, from: FRIDAY, to: FRIDAY })
      .expect(403);

    expect(response.body).toMatchObject({ code: 'FORBIDDEN_ROLE' });
  });

  it('refuses an unauthenticated caller', async () => {
    await request(server())
      .get('/api/office/availability')
      .query({ serviceId: ctx.service30.id, from: FRIDAY, to: FRIDAY })
      .expect(401);
  });
});
