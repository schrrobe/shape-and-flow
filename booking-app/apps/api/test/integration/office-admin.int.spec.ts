import {
  SERVICE_BOUNDS,
  SETTINGS_BOUNDS,
  officeSettingsResponseSchema,
} from '@shape-and-flow/booking-contracts';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module.js';
import { SessionStore } from '../../src/auth/session.store.js';
import { AuditModule } from '../../src/common/audit/audit.module.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { OfficeModule } from '../../src/office/office.module.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { makeBooking, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';
import { queues, redis } from '../redis.harness.js';

import type { BookingStatus, OfficeUserRole } from '../../src/prisma/client.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/**
 * The configuration surface, against a real PostgreSQL and a real Redis.
 *
 * Three things here are only provable with the real thing behind them, which is why
 * none of this is a unit test:
 *
 *  - The **exclusion constraint** on `blocked_times` — two overlapping blocks are
 *    refused by the database, not by a check in front of it, and a mocked client would
 *    prove the check and not the guarantee.
 *  - **Session revocation**, which is a Redis key disappearing. A fake store would
 *    assert that a method was called rather than that a cookie stopped working.
 *  - The **`CHECK` constraints**, read back out of `pg_constraint` and compared against
 *    the Zod bounds. That is the only way to notice the two drifting.
 *
 * The clock is fixed to 20:00Z — 22:00 in Berlin — for the reason the calendar suite
 * fixes it there: anything reasoning about a day in UTC lands on the wrong side of a
 * boundary, and a round hour would let it pass.
 */

const NOW = new Date('2026-08-14T20:00:00.000Z');
const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;

/** The Monday after `NOW`, which is when the seeded Mon–Fri rota next applies. */
const NEXT_MONDAY = '2026-08-17';

let ctx: SeedContext;
let testApp: BookingTestApp;
let server: () => Server;
let sessions: SessionStore;

let userCounter = 0;

interface Agent {
  cookie: string;
  officeUserId: string;
  get: (path: string) => request.Test;
  post: (path: string) => request.Test;
  patch: (path: string) => request.Test;
  put: (path: string) => request.Test;
  delete: (path: string) => request.Test;
}

/**
 * A signed-in office user.
 *
 * The cookie is carried by hand rather than through `request.agent()`. A supertest
 * agent keeps a keep-alive socket open against the application it was built for; the
 * socket outlives `app.close()`, and the next file's `TRUNCATE` then blocks on the
 * stray connection. That was a real, hours-long bug in the auth suite — it made *other*
 * files fail, in different places each run.
 */
async function signedInAs(role: OfficeUserRole, employeeId: string | null = null): Promise<Agent> {
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
      ...(employeeId === null ? {} : { employeeId }),
    },
    select: { id: true },
  });

  const sid = await sessions.create({
    id: user.id,
    organizationId: ctx.organization.id,
    role,
    canIssueRefunds: true,
    employeeId,
  });

  return agentFor(`sf_office_session=${sid}`, user.id);
}

function agentFor(cookie: string, officeUserId: string): Agent {
  const call = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string) =>
    request(server())
      [method](path)
      .set('Cookie', cookie)
      .set(...CSRF);

  return {
    cookie,
    officeUserId,
    get: (path) => call('get', path),
    post: (path) => call('post', path),
    patch: (path) => call('patch', path),
    put: (path) => call('put', path),
    delete: (path) => call('delete', path),
  };
}

/** Berlin wall clock on a local date, as an instant. August and September are UTC+2. */
function berlin(date: string, hourMinute: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = hourMinute.split(':').map(Number);

  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, (hour ?? 0) - 2, minute ?? 0));
}

async function bookingAt(
  startsAt: Date,
  overrides: { status?: BookingStatus; employeeId?: string; serviceId?: string } = {},
): Promise<{ id: string; startsAt: Date; endsAt: Date }> {
  const status = overrides.status ?? 'CONFIRMED';

  return await prisma.booking.create({
    data: {
      ...makeBooking(ctx, {
        status,
        startsAt,
        expiresAt: status === 'PENDING_PAYMENT' || status === 'EXPIRING' ? startsAt : null,
        ...(overrides.employeeId === undefined ? {} : { employeeId: overrides.employeeId }),
        ...(overrides.serviceId === undefined ? {} : { serviceId: overrides.serviceId }),
      }),
      ...(status === 'CONFIRMED' ? { confirmedAt: NOW } : {}),
    },
    select: { id: true, startsAt: true, endsAt: true },
  });
}

/**
 * How much the public booking page can actually offer on a date.
 *
 * Counted as (slot × employee) pairs rather than slots, because the engine merges: one
 * start time comes back once listing everybody free for it. Counting slots would show
 * no change when one of two employees goes on leave, which is exactly the change these
 * tests are trying to observe.
 */
async function publicSlotOffers(date: string): Promise<number> {
  const response = await request(server())
    .get('/api/public/availability')
    .query({ serviceId: ctx.service30.id, from: date, to: date })
    .expect(200);

  const body = response.body as { days: { slots: { employeeIds: string[] }[] }[] };

  return body.days.reduce(
    (total, day) => total + day.slots.reduce((slots, slot) => slots + slot.employeeIds.length, 0),
    0,
  );
}

/** The definition PostgreSQL holds for one named constraint. */
async function constraintDefinition(name: string): Promise<string> {
  const rows = await prisma.$queryRaw<{ definition: string }[]>`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = ${name}
  `;

  const definition = rows[0]?.definition;
  if (definition === undefined) throw new Error(`no constraint named ${name}`);

  return definition;
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
    extraImports: [AuthModule, AuditModule, OfficeModule],
    redis,
    queues,
    globalPrefix: 'api',
  });

  server = testApp.server;
  sessions = testApp.app.get(SessionStore);

  return testApp.close;
});

/* ── employees and working hours ──────────────────────────────────────────────── */

describe('PUT /api/office/employees/:id/working-hours', () => {
  it('replaces the whole week, breaks and all', async () => {
    const owner = await signedInAs('OWNER');

    await owner
      .put(`/api/office/employees/${ctx.employee1.id}/working-hours`)
      .send({
        segments: [
          {
            weekday: 'MONDAY',
            startMinute: 540,
            endMinute: 1080,
            breaks: [{ startMinute: 720, endMinute: 750, label: 'Mittagspause' }],
          },
          { weekday: 'MONDAY', startMinute: 1140, endMinute: 1260, breaks: [] },
        ],
      })
      .expect(200);

    const rows = await prisma.workingHours.findMany({
      where: { employeeId: ctx.employee1.id },
      include: { breaks: true },
      orderBy: { startMinute: 'asc' },
    });

    // Two, not seven: the seeded Monday–Friday week is gone, because the request said
    // what the week *is* rather than what to add to it.
    expect(rows).toHaveLength(2);
    expect(rows[0]?.breaks).toHaveLength(1);
    expect(rows[1]?.breaks).toHaveLength(0);
  });

  it('refuses two segments that overlap on one weekday', async () => {
    const owner = await signedInAs('OWNER');

    const response = await owner
      .put(`/api/office/employees/${ctx.employee1.id}/working-hours`)
      .send({
        segments: [
          { weekday: 'MONDAY', startMinute: 540, endMinute: 720, breaks: [] },
          { weekday: 'MONDAY', startMinute: 660, endMinute: 840, breaks: [] },
        ],
      })
      .expect(400);

    const body = response.body as { code: string; details: { issues: { message: string }[] } };

    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details.issues.map((issue) => issue.message).join(' ')).toContain('overlap');
  });

  it('refuses a break outside its segment, and a minute past midnight', async () => {
    const owner = await signedInAs('OWNER');
    const path = `/api/office/employees/${ctx.employee1.id}/working-hours`;

    // A break outside its shift is not a shorter shift, it is a contradiction.
    await owner
      .put(path)
      .send({
        segments: [
          {
            weekday: 'MONDAY',
            startMinute: 540,
            endMinute: 720,
            breaks: [{ startMinute: 800, endMinute: 820 }],
          },
        ],
      })
      .expect(400);

    // 1440 is the last legal minute — local midnight — so 1500 is not a long day.
    await owner
      .put(path)
      .send({ segments: [{ weekday: 'MONDAY', startMinute: 1400, endMinute: 1500, breaks: [] }] })
      .expect(400);

    // Neither request touched the rota.
    expect(await prisma.workingHours.count({ where: { employeeId: ctx.employee1.id } })).toBe(5);
  });

  it('saves the new week and reports the appointments it no longer covers', async () => {
    const owner = await signedInAs('OWNER');

    const stranded = await bookingAt(berlin(NEXT_MONDAY, '09:00'));
    const stillCovered = await bookingAt(berlin(NEXT_MONDAY, '15:00'));

    const response = await owner
      .put(`/api/office/employees/${ctx.employee1.id}/working-hours`)
      .send({ segments: [{ weekday: 'MONDAY', startMinute: 840, endMinute: 1080, breaks: [] }] })
      .expect(200);

    const body = response.body as { conflictingBookings: { id: string; reference: string }[] };
    const reported = body.conflictingBookings.map((booking) => booking.id);

    expect(reported).toContain(stranded.id);
    expect(reported).not.toContain(stillCovered.id);

    // Reported, not enforced. Cancelling somebody's appointment because the rota moved
    // is a decision only a person makes.
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: stranded.id } });
    expect(after.status).toBe('CONFIRMED');
    expect(await prisma.workingHours.count({ where: { employeeId: ctx.employee1.id } })).toBe(1);
  });

  it('counts an appointment whose cleanup buffer falls outside the shift', async () => {
    const owner = await signedInAs('OWNER');

    // 17:30 plus 30 minutes plus five of cleanup ends at 18:05. The shift closes at
    // 18:00, so the buffer — the employee's time, not the customer's — does not fit.
    const overrunning = await bookingAt(berlin(NEXT_MONDAY, '17:30'));

    const response = await owner
      .put(`/api/office/employees/${ctx.employee1.id}/working-hours`)
      .send({ segments: [{ weekday: 'MONDAY', startMinute: 540, endMinute: 1080, breaks: [] }] })
      .expect(200);

    const body = response.body as { conflictingBookings: { id: string }[] };
    expect(body.conflictingBookings.map((booking) => booking.id)).toContain(overrunning.id);
  });
});

describe('POST /api/office/employees/:id/archive', () => {
  it('refuses while appointments are still to come, and names how many', async () => {
    const owner = await signedInAs('OWNER');
    await bookingAt(berlin(NEXT_MONDAY, '09:00'), { employeeId: ctx.employee2.id });

    const response = await owner
      .post(`/api/office/employees/${ctx.employee2.id}/archive`)
      .expect(409);

    const body = response.body as { code: string; details: { bookingCount: number } };
    expect(body.code).toBe('EMPLOYEE_HAS_FUTURE_BOOKINGS');
    expect(body.details.bookingCount).toBe(1);
  });

  it('archives an employee whose appointments are all in the past', async () => {
    const owner = await signedInAs('OWNER');
    const past = await bookingAt(new Date(NOW.getTime() - 48 * 3_600_000), {
      employeeId: ctx.employee2.id,
    });
    await prisma.booking.update({ where: { id: past.id }, data: { status: 'COMPLETED' } });

    await owner.post(`/api/office/employees/${ctx.employee2.id}/archive`).expect(201);

    const employees = await owner.get('/api/office/employees').expect(200);
    expect(
      (employees.body as { items: { id: string }[] }).items.map((row) => row.id),
    ).not.toContain(ctx.employee2.id);
  });
});

describe('PUT /api/office/employees/:id/services', () => {
  it('refuses to remove a pairing somebody is already booked for', async () => {
    const owner = await signedInAs('OWNER');
    await bookingAt(berlin(NEXT_MONDAY, '09:00'), {
      employeeId: ctx.employee1.id,
      serviceId: ctx.service60.id,
    });

    const response = await owner
      .put(`/api/office/employees/${ctx.employee1.id}/services`)
      .send({ assignments: [{ serviceId: ctx.service30.id }] })
      .expect(409);

    const body = response.body as { code: string; details: { serviceId: string } };
    expect(body.code).toBe('EMPLOYEE_HAS_FUTURE_BOOKINGS');
    expect(body.details.serviceId).toBe(ctx.service60.id);
  });

  it('replaces the set and applies a price override', async () => {
    const owner = await signedInAs('OWNER');

    const response = await owner
      .put(`/api/office/employees/${ctx.employee1.id}/services`)
      .send({
        assignments: [
          { serviceId: ctx.service30.id, priceOverrideCents: 5500 },
          { serviceId: ctx.service60.id },
        ],
      })
      .expect(200);

    const body = response.body as {
      items: {
        serviceId: string;
        effectivePriceCents: number;
        priceOverrideCents: number | null;
      }[];
    };

    const overridden = body.items.find((item) => item.serviceId === ctx.service30.id);
    const listed = body.items.find((item) => item.serviceId === ctx.service60.id);

    expect(overridden?.effectivePriceCents).toBe(5500);
    expect(listed?.priceOverrideCents).toBeNull();
    expect(listed?.effectivePriceCents).toBe(ctx.service60.priceCents);
  });
});

/* ── blocked time, leave, closures ────────────────────────────────────────────── */

describe('blocked time and time off', () => {
  it('refuses blocked time on top of a confirmed appointment', async () => {
    const owner = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(NEXT_MONDAY, '09:00'));

    const response = await owner
      .post('/api/office/blocked-times')
      .send({
        employeeId: ctx.employee1.id,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        reason: 'Besprechung',
      })
      .expect(409);

    expect((response.body as { code: string }).code).toBe('SLOT_UNAVAILABLE');
  });

  it('refuses a second blocked time overlapping the first', async () => {
    const owner = await signedInAs('OWNER');
    const body = {
      employeeId: ctx.employee1.id,
      startsAt: berlin(NEXT_MONDAY, '13:00').toISOString(),
      endsAt: berlin(NEXT_MONDAY, '14:00').toISOString(),
    };

    await owner.post('/api/office/blocked-times').send(body).expect(201);

    // The exclusion constraint is what refuses this, and it is the only thing that
    // would still refuse it if the re-check above were removed.
    const response = await owner.post('/api/office/blocked-times').send(body).expect(409);
    expect((response.body as { code: string }).code).toBe('SLOT_UNAVAILABLE');
    expect(await prisma.blockedTime.count()).toBe(1);
  });

  it('allows a block that abuts an appointment without overlapping it', async () => {
    const owner = await signedInAs('OWNER');
    // 09:00 + 30 minutes + five of cleanup, so the block starts at 09:35 and the
    // half-open bounds make it legal.
    await bookingAt(berlin(NEXT_MONDAY, '09:00'));

    await owner
      .post('/api/office/blocked-times')
      .send({
        employeeId: ctx.employee1.id,
        startsAt: berlin(NEXT_MONDAY, '09:35').toISOString(),
        endsAt: berlin(NEXT_MONDAY, '10:00').toISOString(),
      })
      .expect(201);
  });

  it('lets an employee block their own time and refuses a colleague with 404', async () => {
    const employee = await signedInAs('EMPLOYEE', ctx.employee1.id);

    await employee
      .post('/api/office/blocked-times')
      .send({
        employeeId: ctx.employee1.id,
        startsAt: berlin(NEXT_MONDAY, '13:00').toISOString(),
        endsAt: berlin(NEXT_MONDAY, '14:00').toISOString(),
      })
      .expect(201);

    // 404 rather than 403, so the refusal does not confirm the id belongs to somebody.
    const response = await employee
      .post('/api/office/blocked-times')
      .send({
        employeeId: ctx.employee2.id,
        startsAt: berlin(NEXT_MONDAY, '13:00').toISOString(),
        endsAt: berlin(NEXT_MONDAY, '14:00').toISOString(),
      })
      .expect(404);

    expect((response.body as { code: string }).code).toBe('NOT_FOUND');
  });

  it('refuses approved leave over an appointment, and names how many', async () => {
    const owner = await signedInAs('OWNER');
    await bookingAt(berlin('2026-08-24', '10:00'));

    const response = await owner
      .post('/api/office/time-off')
      .send({
        employeeId: ctx.employee1.id,
        startDate: '2026-08-23',
        endDate: '2026-08-25',
        status: 'APPROVED',
      })
      .expect(409);

    const body = response.body as { code: string; details: { bookingCount: number } };
    expect(body.code).toBe('EMPLOYEE_HAS_FUTURE_BOOKINGS');
    expect(body.details.bookingCount).toBe(1);
  });

  it('records unapproved leave over an appointment without complaint', async () => {
    const owner = await signedInAs('OWNER');
    await bookingAt(berlin('2026-08-24', '10:00'));

    // A request nobody has decided changes nothing, so there is nothing to contradict.
    await owner
      .post('/api/office/time-off')
      .send({
        employeeId: ctx.employee1.id,
        startDate: '2026-08-23',
        endDate: '2026-08-25',
        status: 'REQUESTED',
      })
      .expect(201);
  });

  it('takes the days off the public calendar once approved', async () => {
    const owner = await signedInAs('OWNER');
    const before = await publicSlotOffers('2026-09-14');

    await owner
      .post('/api/office/time-off')
      .send({
        employeeId: ctx.employee1.id,
        startDate: '2026-09-14',
        endDate: '2026-09-14',
        status: 'APPROVED',
      })
      .expect(201);

    const after = await publicSlotOffers('2026-09-14');

    expect(before).toBeGreaterThan(0);
    // One of two employees, so the offers roughly halve rather than vanish.
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });
});

describe('closed days', () => {
  it('closes a day for everybody, and says so again without a conflict', async () => {
    const owner = await signedInAs('OWNER');
    const before = await publicSlotOffers('2026-09-14');

    await owner
      .post('/api/office/closed-days')
      .send({ date: '2026-09-14', reason: 'Betriebsferien' })
      .expect(201);

    expect(before).toBeGreaterThan(0);
    expect(await publicSlotOffers('2026-09-14')).toBe(0);

    // Saying it twice means the same thing both times, so the second is an update
    // rather than a 409 for repeating yourself.
    await owner
      .post('/api/office/closed-days')
      .send({ date: '2026-09-14', reason: 'Feiertag' })
      .expect(201);

    const rows = await prisma.closedDay.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe('Feiertag');
  });

  it('reopens the day when the closure is deleted', async () => {
    const owner = await signedInAs('OWNER');

    const created = await owner
      .post('/api/office/closed-days')
      .send({ date: '2026-09-14' })
      .expect(201);

    const { id } = created.body as { id: string };
    await owner.delete(`/api/office/closed-days/${id}`).expect(200);

    expect(await publicSlotOffers('2026-09-14')).toBeGreaterThan(0);
  });
});

/* ── catalog ──────────────────────────────────────────────────────────────────── */

describe('catalog', () => {
  it('archives a service with only past appointments, keeping their snapshot', async () => {
    const owner = await signedInAs('OWNER');
    const past = await bookingAt(new Date(NOW.getTime() - 48 * 3_600_000), {
      serviceId: ctx.service30.id,
    });
    await prisma.booking.update({ where: { id: past.id }, data: { status: 'COMPLETED' } });

    await owner.post(`/api/office/services/${ctx.service30.id}/archive`).expect(201);

    const publicList = await request(server()).get('/api/public/services').expect(200);
    expect(
      (publicList.body as { items: { id: string }[] }).items.map((service) => service.id),
    ).not.toContain(ctx.service30.id);

    // The appointment still reads correctly, because it carries what it was sold as.
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: past.id } });
    expect(booking.serviceNameSnapshot).toBe(ctx.service30.name);
  });

  it('refuses to archive a service with appointments still to come', async () => {
    const owner = await signedInAs('OWNER');
    await bookingAt(berlin(NEXT_MONDAY, '09:00'), { serviceId: ctx.service60.id });

    const response = await owner
      .post(`/api/office/services/${ctx.service60.id}/archive`)
      .expect(409);

    const body = response.body as { code: string; details: { bookingCount: number } };
    expect(body.code).toBe('SERVICE_HAS_FUTURE_BOOKINGS');
    expect(body.details.bookingCount).toBe(1);
  });

  it('refuses to archive a category that still holds a live service', async () => {
    const owner = await signedInAs('OWNER');

    const response = await owner
      .post(`/api/office/service-categories/${ctx.category.id}/archive`)
      .expect(409);

    const body = response.body as { code: string; details: { serviceCount: number } };
    expect(body.code).toBe('CATEGORY_NOT_EMPTY');
    expect(body.details.serviceCount).toBe(2);
  });

  it('refuses a duplicate service name, naming the field', async () => {
    const owner = await signedInAs('OWNER');

    const response = await owner
      .post('/api/office/services')
      .send({ name: ctx.service30.name, durationMinutes: 30, priceCents: 1000 })
      .expect(400);

    const body = response.body as { code: string; details: { issues: { path: string[] }[] } };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details.issues[0]?.path).toEqual(['name']);
  });

  it('rejects a duration outside the bounds the database also enforces', async () => {
    const owner = await signedInAs('OWNER');

    await owner
      .post('/api/office/services')
      .send({ name: 'Zu kurz', durationMinutes: 1, priceCents: 1000 })
      .expect(400);

    await owner
      .post('/api/office/services')
      .send({ name: 'Zu lang', durationMinutes: 481, priceCents: 1000 })
      .expect(400);
  });

  it('creates a service in the organization currency and offers it publicly', async () => {
    const owner = await signedInAs('OWNER');

    const created = await owner
      .post('/api/office/services')
      .send({
        name: 'Hot Stone 45',
        serviceCategoryId: ctx.category.id,
        durationMinutes: 45,
        cleanupBufferMinutes: 10,
        priceCents: 6900,
      })
      .expect(201);

    const body = created.body as { id: string; price: { amountCents: number; currency: string } };
    expect(body.price).toEqual({ amountCents: 6900, currency: 'EUR' });

    const publicList = await request(server()).get('/api/public/services').expect(200);
    expect(
      (publicList.body as { items: { id: string }[] }).items.map((service) => service.id),
    ).toContain(body.id);
  });
});

/* ── settings ─────────────────────────────────────────────────────────────────── */

describe('PATCH /api/office/settings', () => {
  it('returns the published shape', async () => {
    const owner = await signedInAs('OWNER');

    const response = await owner.get('/api/office/settings').expect(200);

    // Parsed against the contract rather than matched field by field, so this also
    // proves nothing extra crept into the response.
    const body = officeSettingsResponseSchema.parse(response.body);
    expect(body.organization.timezone).toBe('Europe/Berlin');
  });

  it('rejects values outside the bounds', async () => {
    const owner = await signedInAs('OWNER');

    await owner.patch('/api/office/settings').send({ schedulingIntervalMinutes: 7 }).expect(400);
    await owner.patch('/api/office/settings').send({ cancellationFeePercent: 101 }).expect(400);
    await owner.patch('/api/office/settings').send({ bookingHorizonDays: 0 }).expect(400);
  });

  it('takes effect immediately, because the cached context is refreshed', async () => {
    const owner = await signedInAs('OWNER');
    const before = await publicSlotOffers('2026-09-14');

    await owner.patch('/api/office/settings').send({ schedulingIntervalMinutes: 60 }).expect(200);

    // The row would be updated either way. What this proves is that the process's
    // cached settings — which the availability engine reads — were reloaded, rather
    // than the change taking effect on the next deploy.
    expect(await publicSlotOffers('2026-09-14')).toBeLessThan(before);
  });

  it('sorts and de-duplicates the reminder offsets', async () => {
    const owner = await signedInAs('OWNER');

    const response = await owner
      .patch('/api/office/settings')
      .send({ reminderOffsetsMinutes: [1440, 120, 1440] })
      .expect(200);

    expect((response.body as { reminderOffsetsMinutes: number[] }).reminderOffsetsMinutes).toEqual([
      120, 1440,
    ]);
  });

  it('audits the change with what it was before', async () => {
    const owner = await signedInAs('OWNER');

    await owner.patch('/api/office/settings').send({ minimumNoticeHours: 48 }).expect(200);

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'SETTINGS_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });

    expect(row.before).toMatchObject({ minimumNoticeHours: 24 });
    expect(row.after).toMatchObject({ minimumNoticeHours: 48 });
    expect(row.officeUserId).toBe(owner.officeUserId);
  });

  it('is closed to ADMIN, both reading and writing', async () => {
    const admin = await signedInAs('ADMIN');

    await admin.get('/api/office/settings').expect(403);
    await admin.patch('/api/office/settings').send({ minimumNoticeHours: 48 }).expect(403);
  });
});

/* ── office users ─────────────────────────────────────────────────────────────── */

describe('/api/office/users', () => {
  it('creates a user with no usable password and sends a reset link', async () => {
    const owner = await signedInAs('OWNER');

    const created = await owner
      .post('/api/office/users')
      .send({
        email: 'neu@shape-and-flow.example',
        firstName: 'Nele',
        lastName: 'Wagner',
        role: 'ADMIN',
      })
      .expect(201);

    const { user } = created.body as { user: { id: string; role: string } };
    expect(user.role).toBe('ADMIN');

    // No password crossed the wire, so the only way in is the link they were sent.
    expect(await prisma.passwordResetToken.count({ where: { officeUserId: user.id } })).toBe(1);
    const notifications = await prisma.notification.findMany({
      where: { officeUserId: user.id },
    });
    expect(notifications.map((row) => row.kind)).toEqual(['OFFICE_PASSWORD_RESET']);
  });

  it('refuses a duplicate address', async () => {
    const owner = await signedInAs('OWNER');
    const body = {
      email: 'doppelt@shape-and-flow.example',
      firstName: 'Nele',
      lastName: 'Wagner',
      role: 'ADMIN' as const,
    };

    await owner.post('/api/office/users').send(body).expect(201);
    await owner.post('/api/office/users').send(body).expect(400);
  });

  it('ends every session of a user it archives', async () => {
    const owner = await signedInAs('OWNER');
    const admin = await signedInAs('ADMIN');

    // The session works before the archive, which is what makes the 401 afterwards mean
    // something.
    await admin.get('/api/office/employees').expect(200);

    const response = await owner
      .post(`/api/office/users/${admin.officeUserId}/archive`)
      .expect(201);
    expect((response.body as { revokedSessions: number }).revokedSessions).toBe(1);

    // Archiving only sets a column; a live session never touches the login path, so
    // without the revocation this would still answer 200.
    await admin.get('/api/office/employees').expect(401);
  });

  it('ends sessions when a role changes, because the session carries a copy of it', async () => {
    const owner = await signedInAs('OWNER');
    const admin = await signedInAs('ADMIN');

    await owner
      .patch(`/api/office/users/${admin.officeUserId}`)
      .send({ role: 'EMPLOYEE' })
      .expect(200);

    await admin.get('/api/office/employees').expect(401);
  });

  it('does not end sessions for a change that alters nothing about access', async () => {
    const owner = await signedInAs('OWNER');
    const admin = await signedInAs('ADMIN');

    const response = await owner
      .patch(`/api/office/users/${admin.officeUserId}`)
      .send({ firstName: 'Neuer' })
      .expect(200);

    expect((response.body as { revokedSessions: number }).revokedSessions).toBe(0);
    await admin.get('/api/office/employees').expect(200);
  });

  it('refuses self-archive and self-demotion', async () => {
    const owner = await signedInAs('OWNER');

    const archive = await owner.post(`/api/office/users/${owner.officeUserId}/archive`).expect(409);
    expect((archive.body as { code: string }).code).toBe('CANNOT_MODIFY_SELF');

    const demote = await owner
      .patch(`/api/office/users/${owner.officeUserId}`)
      .send({ role: 'ADMIN' })
      .expect(409);
    expect((demote.body as { code: string }).code).toBe('CANNOT_MODIFY_SELF');

    // Still an owner, and still able to work.
    await owner.get('/api/office/settings').expect(200);
  });

  it('lets an owner rename themselves', async () => {
    const owner = await signedInAs('OWNER');

    // The rule is about losing access, not about touching your own row at all.
    await owner
      .patch(`/api/office/users/${owner.officeUserId}`)
      .send({ firstName: 'Ola' })
      .expect(200);
  });

  it('is closed to ADMIN', async () => {
    const admin = await signedInAs('ADMIN');

    await admin.get('/api/office/users').expect(403);
    await admin
      .post('/api/office/users')
      .send({ email: 'x@y.example', firstName: 'A', lastName: 'B', role: 'ADMIN' })
      .expect(403);
  });
});

/* ── authorization and audit coverage ─────────────────────────────────────────── */

describe('role matrix over the real routes', () => {
  it('lets an EMPLOYEE read the staff list but not change it', async () => {
    const employee = await signedInAs('EMPLOYEE', ctx.employee1.id);

    await employee.get('/api/office/employees').expect(200);
    await employee
      .post('/api/office/employees')
      .send({ firstName: 'Neu', lastName: 'Person' })
      .expect(403);
    await employee
      .put(`/api/office/employees/${ctx.employee1.id}/working-hours`)
      .send({ segments: [] })
      .expect(403);
  });

  it('lets an EMPLOYEE read their own leave but not decide it', async () => {
    const employee = await signedInAs('EMPLOYEE', ctx.employee1.id);

    await employee.get('/api/office/time-off').expect(200);
    await employee
      .post('/api/office/time-off')
      .send({ employeeId: ctx.employee1.id, startDate: '2026-09-14', endDate: '2026-09-14' })
      .expect(403);
  });

  it('refuses a state-changing request without the CSRF header', async () => {
    const owner = await signedInAs('OWNER');

    const response = await request(server())
      .post('/api/office/closed-days')
      .set('Cookie', owner.cookie)
      .send({ date: '2026-09-14' })
      .expect(403);

    expect((response.body as { code: string }).code).toBe('CSRF_FAILED');
  });

  it('leaves an audit row for a configuration change', async () => {
    const owner = await signedInAs('OWNER');

    await owner
      .post('/api/office/closed-days')
      .send({ date: '2026-09-14', reason: 'Betriebsferien' })
      .expect(201);

    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'CLOSED_DAY_CREATED' } });
    expect(row.officeUserId).toBe(owner.officeUserId);
    expect(row.entityType).toBe('ClosedDay');
  });
});

/* ── contract bounds against the database ─────────────────────────────────────── */

describe('Zod bounds and SQL CHECK constraints agree', () => {
  it('holds for every settings range', async () => {
    const definition = await constraintDefinition('organization_settings_ranges_check');

    // PostgreSQL renders `IN (…)` as `= ANY (ARRAY[…])` and `BETWEEN a AND b` as two
    // comparisons, so the expectations below are written the way it stores them.
    expect(definition).toContain(`ARRAY[${SETTINGS_BOUNDS.schedulingIntervalMinutes.join(', ')}]`);

    const columns = {
      booking_horizon_days: SETTINGS_BOUNDS.bookingHorizonDays,
      minimum_notice_hours: SETTINGS_BOUNDS.minimumNoticeHours,
      reservation_ttl_minutes: SETTINGS_BOUNDS.reservationTtlMinutes,
      free_cancellation_hours: SETTINGS_BOUNDS.freeCancellationHours,
      cancellation_fee_percent: SETTINGS_BOUNDS.cancellationFeePercent,
      data_retention_days: SETTINGS_BOUNDS.dataRetentionDays,
    };

    for (const [column, bounds] of Object.entries(columns)) {
      expect(definition, column).toContain(`(${column} >= ${String(bounds.min)})`);
      expect(definition, column).toContain(`(${column} <= ${String(bounds.max)})`);
    }
  });

  it('holds for the service duration and buffers', async () => {
    const duration = await constraintDefinition('services_duration_check');
    const buffers = await constraintDefinition('services_buffers_check');

    expect(duration).toContain(
      `(duration_minutes >= ${String(SERVICE_BOUNDS.durationMinutes.min)})`,
    );
    expect(duration).toContain(
      `(duration_minutes <= ${String(SERVICE_BOUNDS.durationMinutes.max)})`,
    );
    expect(buffers).toContain(
      `(prep_buffer_minutes <= ${String(SERVICE_BOUNDS.prepBufferMinutes.max)})`,
    );
    expect(buffers).toContain(
      `(cleanup_buffer_minutes <= ${String(SERVICE_BOUNDS.cleanupBufferMinutes.max)})`,
    );
  });
});
