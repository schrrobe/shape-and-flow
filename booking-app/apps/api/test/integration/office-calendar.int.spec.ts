import { officeDashboardResponseSchema } from '@shape-and-flow/booking-contracts';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthModule } from '../../src/auth/auth.module.js';
import { SessionStore } from '../../src/auth/session.store.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { OfficeModule } from '../../src/office/office.module.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, makeBooking, seedOrganization } from '../factories/index.js';
import { loadOrganization, queryCounter } from '../public-app.harness.js';
import { queues, redis } from '../redis.harness.js';

import type { BookingStatus, OfficeUserRole } from '../../src/prisma/client.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/**
 * The two office screens, against a real database and a real Redis.
 *
 * "Today" is the reason the clock is fixed to a specific instant rather than to a round
 * one: `2026-08-14T20:00:00Z` is 22:00 in Berlin, so anything that reasons about the day
 * in UTC lands on the wrong side of a boundary and the local-day assertions below catch
 * it. A round UTC time would let a UTC-day implementation pass.
 */

const NOW = new Date('2026-08-14T20:00:00.000Z');
/** The Berlin day `NOW` falls in. In UTC it is already the 14th late evening. */
const TODAY = '2026-08-14';

const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;

let ctx: SeedContext;
let testApp: BookingTestApp;
let server: () => Server;
let sessions: SessionStore;

let userCounter = 0;

async function signedInAs(role: OfficeUserRole, employeeId: string | null = null): Promise<string> {
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

  return `sf_office_session=${sid}`;
}

const get = (cookie: string, path: string) =>
  request(server())
    .get(path)
    .set('Cookie', cookie)
    .set(...CSRF);

const calendar = (cookie: string, query: Record<string, string>) =>
  get(cookie, '/api/office/calendar').query(query);

/** A booking at a chosen instant, in a chosen status. */
async function bookingAt(
  startsAt: Date,
  overrides: { status?: BookingStatus; employeeId?: string } = {},
): Promise<{ id: string }> {
  const status = overrides.status ?? 'CONFIRMED';

  return await prisma.booking.create({
    data: {
      ...makeBooking(ctx, {
        status,
        startsAt,
        expiresAt: status === 'PENDING_PAYMENT' || status === 'EXPIRING' ? startsAt : null,
        ...(overrides.employeeId === undefined ? {} : { employeeId: overrides.employeeId }),
      }),
      ...(status === 'CONFIRMED' ? { confirmedAt: NOW } : {}),
    },
    select: { id: true },
  });
}

/** Berlin-local wall clock on the seeded Friday, as an instant. Summer is UTC+2. */
function berlin(day: string, hourMinute: string): Date {
  const [hour, minute] = hourMinute.split(':').map(Number);
  return new Date(Date.UTC(2026, 7, Number(day.slice(-2)), (hour ?? 0) - 2, minute ?? 0));
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
    extraImports: [AuthModule, OfficeModule],
    redis,
    // Real queues, not the recording fake: the dashboard's `failedJobs` tile calls
    // BullMQ's own `getFailedCount`, and the fake has no such method — which the
    // service's degradation path swallows into a -1. Passing the real registry is what
    // makes that tile actually tested rather than tested-as-degraded.
    queues,
    globalPrefix: 'api',
    countQueries: true,
  });

  server = testApp.server;
  sessions = testApp.app.get(SessionStore);

  return testApp.close;
});

describe('GET /api/office/calendar', () => {
  it('returns exactly the five collections a calendar is drawn from', async () => {
    const cookie = await signedInAs('OWNER');

    const response = await calendar(cookie, { from: '2026-08-10', to: '2026-08-20' }).expect(200);

    expect(Object.keys(response.body as object).sort()).toEqual([
      'blockedTimes',
      'bookings',
      'closedDays',
      'timeOff',
      'workingHours',
    ]);
  });

  it('caps the range', async () => {
    const cookie = await signedInAs('OWNER');

    // Refusing is a better interface than paginating a calendar, so the refusal has to
    // actually happen.
    const response = await calendar(cookie, { from: '2026-01-01', to: '2026-06-01' }).expect(400);
    expect((response.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('accepts a range at exactly the cap', async () => {
    const cookie = await signedInAs('OWNER');

    // 62 days inclusive: an off-by-one here would refuse a range the contract allows.
    await calendar(cookie, { from: '2026-08-01', to: '2026-10-01' }).expect(200);
    await calendar(cookie, { from: '2026-08-01', to: '2026-10-02' }).expect(400);
  });

  it('refuses a backwards range', async () => {
    const cookie = await signedInAs('OWNER');

    await calendar(cookie, { from: '2026-08-20', to: '2026-08-10' }).expect(400);
  });

  it('returns bookings with their blocking span, not only the appointment', async () => {
    const cookie = await signedInAs('OWNER');
    const booking = await bookingAt(SLOT_FRIDAY_0900);

    const response = await calendar(cookie, { from: '2026-08-14', to: '2026-08-14' }).expect(200);
    const row = bookingRow(response.body, booking.id);

    expect(row.startsAt).toBe(SLOT_FRIDAY_0900.toISOString());
    // The cleanup buffer is why the next slot is unavailable, so the calendar has to be
    // able to draw it.
    expect(new Date(row.blockEndsAt).getTime()).toBeGreaterThan(new Date(row.endsAt).getTime());
    expect(row.customerName).toBe('Anna Becker');
  });

  it('shows CANCELLATION_REQUESTED while the booking itself stays CONFIRMED', async () => {
    const cookie = await signedInAs('OWNER');
    const booking = await bookingAt(SLOT_FRIDAY_0900);

    await prisma.cancellationRequest.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        suggestedRetainedAmountCents: 0,
      },
    });

    const response = await calendar(cookie, { from: '2026-08-14', to: '2026-08-14' }).expect(200);
    const row = bookingRow(response.body, booking.id);

    // The row is still CONFIRMED — the slot is still blocked — but the office needs to
    // see that somebody is waiting for an answer.
    expect(row.status).toBe('CONFIRMED');
    expect(row.displayStatus).toBe('CANCELLATION_REQUESTED');
  });

  it('shows RESCHEDULE_REQUESTED, and prefers cancellation when both are open', async () => {
    const cookie = await signedInAs('OWNER');
    const booking = await bookingAt(SLOT_FRIDAY_0900);

    await prisma.rescheduleRequest.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        requestedStartsAt: new Date(SLOT_FRIDAY_0900.getTime() + 86_400_000),
      },
    });

    let response = await calendar(cookie, { from: '2026-08-14', to: '2026-08-14' }).expect(200);
    expect(bookingRow(response.body, booking.id).displayStatus).toBe('RESCHEDULE_REQUESTED');

    await prisma.cancellationRequest.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        suggestedRetainedAmountCents: 0,
      },
    });

    response = await calendar(cookie, { from: '2026-08-14', to: '2026-08-14' }).expect(200);
    expect(bookingRow(response.body, booking.id).displayStatus).toBe('CANCELLATION_REQUESTED');
  });

  it('omits bookings that no longer hold their slot, and includes them on request', async () => {
    const cookie = await signedInAs('OWNER');
    const expired = await bookingAt(SLOT_FRIDAY_0900, { status: 'EXPIRED' });

    // A calendar showing expired appointments beside live ones is how somebody
    // double-books a slot they thought was taken.
    let response = await calendar(cookie, { from: '2026-08-14', to: '2026-08-14' }).expect(200);
    expect(bookingIds(response.body)).not.toContain(expired.id);

    response = await calendar(cookie, {
      from: '2026-08-14',
      to: '2026-08-14',
      includeInactive: 'true',
    }).expect(200);
    expect(bookingIds(response.body)).toContain(expired.id);
  });

  it('returns the other four collections', async () => {
    const cookie = await signedInAs('OWNER');

    await prisma.blockedTime.create({
      data: {
        organizationId: ctx.organization.id,
        employeeId: ctx.employee1.id,
        startsAt: berlin('2026-08-14', '13:00'),
        endsAt: berlin('2026-08-14', '14:00'),
        reason: 'Zahnarzt',
        createdByOfficeUserId: ctx.owner.id,
      },
    });
    await prisma.timeOff.create({
      data: {
        organizationId: ctx.organization.id,
        employeeId: ctx.employee2.id,
        startDate: new Date('2026-08-17T00:00:00.000Z'),
        endDate: new Date('2026-08-19T00:00:00.000Z'),
        status: 'APPROVED',
      },
    });
    await prisma.closedDay.create({
      data: { organizationId: ctx.organization.id, date: new Date('2026-08-15T00:00:00.000Z') },
    });

    const response = await calendar(cookie, { from: '2026-08-10', to: '2026-08-20' }).expect(200);
    const body = response.body as {
      blockedTimes: { reason: string | null }[];
      timeOff: { startDate: string; endDate: string }[];
      closedDays: { date: string }[];
      workingHours: { weekday: string; breaks: unknown[] }[];
    };

    expect(body.blockedTimes).toHaveLength(1);
    expect(body.blockedTimes[0]?.reason).toBe('Zahnarzt');
    // Inclusive local dates, sent as dates rather than instants: an absence is a run of
    // days, not a span of hours.
    expect(body.timeOff[0]).toMatchObject({ startDate: '2026-08-17', endDate: '2026-08-19' });
    expect(body.closedDays[0]?.date).toBe('2026-08-15');
    // Ten segments: five weekdays for each of two employees, each with its lunch break.
    expect(body.workingHours).toHaveLength(10);
    expect(body.workingHours[0]?.breaks).toHaveLength(1);
  });

  it('excludes time off that has not been approved', async () => {
    const cookie = await signedInAs('OWNER');

    await prisma.timeOff.create({
      data: {
        organizationId: ctx.organization.id,
        employeeId: ctx.employee2.id,
        startDate: new Date('2026-08-17T00:00:00.000Z'),
        endDate: new Date('2026-08-19T00:00:00.000Z'),
        status: 'REQUESTED',
      },
    });

    const response = await calendar(cookie, { from: '2026-08-10', to: '2026-08-20' }).expect(200);
    // A request nobody has decided does not free the employee's calendar.
    expect((response.body as { timeOff: unknown[] }).timeOff).toHaveLength(0);
  });

  it('shows an EMPLOYEE only their own rows', async () => {
    const cookie = await signedInAs('EMPLOYEE', ctx.employee1.id);

    await bookingAt(SLOT_FRIDAY_0900, { employeeId: ctx.employee1.id });
    await bookingAt(new Date(SLOT_FRIDAY_0900.getTime() + 3_600_000), {
      employeeId: ctx.employee2.id,
    });

    const response = await calendar(cookie, { from: '2026-08-14', to: '2026-08-14' }).expect(200);
    const employees = new Set(
      (response.body as { bookings: { employeeId: string }[] }).bookings.map(
        (booking) => booking.employeeId,
      ),
    );

    expect(employees).toEqual(new Set([ctx.employee1.id]));
  });

  it('refuses an EMPLOYEE asking for a colleague, with NOT_FOUND', async () => {
    const cookie = await signedInAs('EMPLOYEE', ctx.employee1.id);

    // 404 rather than 403, so the refusal does not confirm the id belongs to somebody.
    const response = await calendar(cookie, {
      from: '2026-08-14',
      to: '2026-08-14',
      employeeId: ctx.employee2.id,
    }).expect(404);

    expect((response.body as { code: string }).code).toBe('NOT_FOUND');
  });

  it('lets an ADMIN narrow to one employee', async () => {
    const cookie = await signedInAs('ADMIN');

    await bookingAt(SLOT_FRIDAY_0900, { employeeId: ctx.employee1.id });
    await bookingAt(new Date(SLOT_FRIDAY_0900.getTime() + 3_600_000), {
      employeeId: ctx.employee2.id,
    });

    const response = await calendar(cookie, {
      from: '2026-08-14',
      to: '2026-08-14',
      employeeId: ctx.employee2.id,
    }).expect(200);

    expect(bookingIds(response.body)).toHaveLength(1);
  });

  it('costs the same number of queries however wide the range', async () => {
    const cookie = await signedInAs('OWNER');
    await bookingAt(SLOT_FRIDAY_0900);

    queryCounter.reset();
    await calendar(cookie, { from: '2026-08-14', to: '2026-08-14' }).expect(200);
    const oneDay = queryCounter.total();

    queryCounter.reset();
    await calendar(cookie, { from: '2026-08-01', to: '2026-09-30' }).expect(200);
    const twoMonths = queryCounter.total();

    // Constancy, not a ceiling: an N+1 breaks the property, and a fixed ceiling generous
    // enough to pass one day would hide a per-day query for a while.
    expect(twoMonths).toBe(oneDay);
    expect(twoMonths).toBeLessThanOrEqual(6);
  });

  it('requires a session', async () => {
    await request(server())
      .get('/api/office/calendar')
      .query({ from: '2026-08-14', to: '2026-08-14' })
      .expect(401);
  });
});

describe('GET /api/office/dashboard', () => {
  it('returns every tile plus the operations block, in the published shape', async () => {
    const cookie = await signedInAs('OWNER');

    const response = await get(cookie, '/api/office/dashboard').expect(200);

    // Parsed against the contract rather than matched field by field. A `toMatchObject`
    // with `expect.any(Number)` proves each named field exists; this proves the response
    // *is* what the browser's types say it is, including that nothing extra crept in.
    const body = officeDashboardResponseSchema.parse(response.body);

    expect(body.todayRevenue.currency).toBe('EUR');
    // Every operations figure is readable here — a -1 would mean a health source threw,
    // which is a degradation the dashboard tolerates but a test should not.
    for (const [name, value] of Object.entries(body.operations)) {
      expect(value, name).toBeGreaterThanOrEqual(0);
    }
  });

  it('scopes today to the organization timezone, not to UTC', async () => {
    const cookie = await signedInAs('OWNER');

    // 23:30 Berlin on the 14th is 21:30Z on the 14th — same UTC day here, so the test
    // that actually bites is the one below.
    const late = await bookingAt(berlin(TODAY, '23:30'));
    // 00:30 Berlin on the 15th is 22:30Z on the *14th*. A UTC day would file it under
    // today; the Berlin day it belongs to is tomorrow.
    const tomorrowEarly = await bookingAt(berlin('2026-08-15', '00:30'));

    const response = await get(cookie, '/api/office/dashboard').expect(200);
    const ids = (response.body as { today: { id: string }[] }).today.map((row) => row.id);

    expect(ids).toContain(late.id);
    expect(ids).not.toContain(tomorrowEarly.id);
  });

  it('counts the next seven days without counting today twice', async () => {
    const cookie = await signedInAs('OWNER');

    await bookingAt(berlin(TODAY, '10:00'));
    await bookingAt(new Date(NOW.getTime() + 2 * 86_400_000));
    await bookingAt(new Date(NOW.getTime() + 6 * 86_400_000));
    // Outside the window.
    await bookingAt(new Date(NOW.getTime() + 30 * 86_400_000));

    const body = (await get(cookie, '/api/office/dashboard').expect(200)).body as {
      today: unknown[];
      next7DaysCount: number;
    };

    expect(body.today).toHaveLength(1);
    expect(body.next7DaysCount).toBe(2);
  });

  it('counts a part-paid booking as unpaid until the price is covered', async () => {
    const cookie = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(TODAY, '10:00'));
    const price = ctx.service30.priceCents;

    const unpaid = async (): Promise<number> =>
      (
        (await get(cookie, '/api/office/dashboard').expect(200)).body as {
          unpaidConfirmedBookings: number;
        }
      ).unpaidConfirmedBookings;

    expect(await unpaid()).toBe(1);

    await recordManualPayment(booking.id, price - 500);
    // Still short, so still something to chase.
    expect(await unpaid()).toBe(1);

    await recordManualPayment(booking.id, 500);
    expect(await unpaid()).toBe(0);
  });

  it('adds card and cash into one figure for today, and ignores yesterday', async () => {
    const cookie = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(TODAY, '10:00'));

    await recordManualPayment(booking.id, 1500, berlin(TODAY, '11:00'));
    await recordManualPayment(booking.id, 1000, new Date(NOW.getTime() - 86_400_000));

    await prisma.payment.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        stripeCheckoutSessionId: `cs_test_${booking.id}`,
        amountCents: 2000,
        currency: 'EUR',
        status: 'SUCCEEDED',
        paidAt: berlin(TODAY, '09:00'),
      },
    });

    const body = (await get(cookie, '/api/office/dashboard').expect(200)).body as {
      todayRevenue: { amountCents: number };
    };

    expect(body.todayRevenue.amountCents).toBe(3500);
  });

  it('shows an EMPLOYEE only their own appointments', async () => {
    const cookie = await signedInAs('EMPLOYEE', ctx.employee1.id);

    await bookingAt(berlin(TODAY, '10:00'), { employeeId: ctx.employee1.id });
    await bookingAt(berlin(TODAY, '11:00'), { employeeId: ctx.employee2.id });

    const body = (await get(cookie, '/api/office/dashboard').expect(200)).body as {
      today: { employeeId: string }[];
    };

    expect(body.today).toHaveLength(1);
    expect(body.today[0]?.employeeId).toBe(ctx.employee1.id);
  });

  it('scopes the money tiles to an EMPLOYEE as well, not just the appointment list', async () => {
    const price = ctx.service30.priceCents;

    const mine = await bookingAt(berlin(TODAY, '10:00'), { employeeId: ctx.employee1.id });
    const theirs = await bookingAt(berlin(TODAY, '11:00'), { employeeId: ctx.employee2.id });

    // Mine is settled; the colleague's is short, so the two sessions must disagree about
    // both tiles rather than happening to agree on a number.
    await recordManualPayment(mine.id, price, berlin(TODAY, '11:00'));
    await recordManualPayment(theirs.id, 2000, berlin(TODAY, '12:00'));

    const figures = async (cookie: string) =>
      (await get(cookie, '/api/office/dashboard').expect(200)).body as {
        todayRevenue: { amountCents: number };
        unpaidConfirmedBookings: number;
      };

    const owner = await figures(await signedInAs('OWNER'));
    expect(owner.todayRevenue.amountCents).toBe(price + 2000);
    expect(owner.unpaidConfirmedBookings).toBe(1);

    // Revenue across the whole business is the figure an employee is least entitled to.
    const employee = await figures(await signedInAs('EMPLOYEE', ctx.employee1.id));
    expect(employee.todayRevenue.amountCents).toBe(price);
    expect(employee.unpaidConfirmedBookings).toBe(0);
  });

  it('leaves an unpaid booking older than the lookback out of the count', async () => {
    const cookie = await signedInAs('OWNER');

    // Ninety days is where "still chasing this" turns into a write-off, and an unbounded
    // scan of every confirmed booking a business ever took is what the bound exists to stop.
    await bookingAt(new Date(NOW.getTime() - 120 * 86_400_000));
    expect((await get(cookie, '/api/office/dashboard').expect(200)).body).toMatchObject({
      unpaidConfirmedBookings: 0,
    });

    await bookingAt(new Date(NOW.getTime() - 10 * 86_400_000));
    expect((await get(cookie, '/api/office/dashboard').expect(200)).body).toMatchObject({
      unpaidConfirmedBookings: 1,
    });
  });

  it('counts open requests', async () => {
    const cookie = await signedInAs('OWNER');
    const booking = await bookingAt(berlin(TODAY, '10:00'));

    await prisma.cancellationRequest.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        suggestedRetainedAmountCents: 0,
      },
    });
    await prisma.rescheduleRequest.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: booking.id,
        requestedStartsAt: new Date(NOW.getTime() + 86_400_000),
      },
    });

    const body = (await get(cookie, '/api/office/dashboard').expect(200)).body as {
      pendingCancellationRequests: number;
      pendingRescheduleRequests: number;
      today: { displayStatus: string }[];
    };

    expect(body.pendingCancellationRequests).toBe(1);
    expect(body.pendingRescheduleRequests).toBe(1);
    expect(body.today[0]?.displayStatus).toBe('CANCELLATION_REQUESTED');
  });

  it('requires a session', async () => {
    await request(server()).get('/api/office/dashboard').expect(401);
  });
});

/* ── helpers ─────────────────────────────────────────────────────────────────── */

function bookingIds(body: unknown): string[] {
  return (body as { bookings: { id: string }[] }).bookings.map((booking) => booking.id);
}

function bookingRow(
  body: unknown,
  id: string,
): {
  status: string;
  displayStatus: string;
  startsAt: string;
  endsAt: string;
  blockEndsAt: string;
  customerName: string;
} {
  const rows = (
    body as {
      bookings: {
        id: string;
        status: string;
        displayStatus: string;
        startsAt: string;
        endsAt: string;
        blockEndsAt: string;
        customerName: string;
      }[];
    }
  ).bookings;

  const row = rows.find((booking) => booking.id === id);
  if (row === undefined) throw new Error(`no calendar row for ${id}`);

  return row;
}

async function recordManualPayment(bookingId: string, amountCents: number, paidAt = NOW) {
  return await prisma.manualPayment.create({
    data: {
      organizationId: ctx.organization.id,
      bookingId,
      amountCents,
      currency: 'EUR',
      method: 'CASH',
      paidAt,
      recordedByOfficeUserId: ctx.owner.id,
    },
    select: { id: true },
  });
}
