import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { PublicModule } from '../../src/public/public.module.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { BERLIN, SLOT_FRIDAY_0900, makeBooking, seedOrganization } from '../factories/index.js';
import { createPublicTestApp, loadOrganization, queryCounter } from '../public-app.harness.js';

import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

/** The seeded schedule's Friday. `SLOT_FRIDAY_0900` is 09:00 Berlin on this date. */
const FRIDAY = '2026-08-14';

/**
 * "Now" for every test: the Monday of that week, 08:00 Berlin.
 *
 * Fixed rather than real, because availability depends on it three ways — minimum
 * notice, the booking horizon, and the clamp to today — and a suite whose answers
 * change with the wall clock is not a suite.
 */
const NOW = new Date('2026-08-10T06:00:00.000Z');

let ctx: SeedContext;
let server: () => Server;

/** Availability for a range, as a flat list of ISO start times. */
async function slotTimes(query: Record<string, string>): Promise<string[]> {
  const response = await request(server())
    .get('/public/availability')
    .query({ serviceId: ctx.service30.id, ...query })
    .expect(200);

  const body = response.body as {
    days: { slots: { startsAt: string }[] }[];
  };

  return body.days.flatMap((day) => day.slots.map((slot) => slot.startsAt));
}

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);

  const testApp = await createPublicTestApp({
    organization: await loadOrganization(ctx.organization.id),
    now: NOW,
    imports: [PublicModule],
  });

  server = testApp.server;
  return testApp.close;
});

describe('GET /public/availability', () => {
  it('returns slots for the seeded Friday, labelled with the organization zone', async () => {
    const response = await request(server())
      .get('/public/availability')
      .query({ serviceId: ctx.service30.id, from: FRIDAY, to: FRIDAY })
      .expect(200);

    const body = response.body as {
      serviceId: string;
      timezone: string;
      days: {
        date: string;
        slots: { startsAt: string; endsAt: string; employeeIds: string[] }[];
      }[];
    };

    expect(body.serviceId).toBe(ctx.service30.id);
    expect(body.timezone).toBe(BERLIN);
    expect(body.days[0]?.date).toBe(FRIDAY);
    expect(body.days[0]?.slots.length).toBeGreaterThan(0);
    expect(body.days[0]?.slots[0]?.employeeIds.length).toBeGreaterThan(0);
  });

  it('never exposes a customer, a booking or an employee email', async () => {
    await prisma.booking.create({ data: makeBooking(ctx) });

    const response = await request(server())
      .get('/public/availability')
      .query({ serviceId: ctx.service30.id, from: FRIDAY, to: FRIDAY })
      .expect(200);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain('customer');
    expect(serialised).not.toContain('booking');
    expect(serialised).not.toContain('@');
  });

  it('offers the appointment window, not the buffered block', async () => {
    const response = await request(server())
      .get('/public/availability')
      .query({ serviceId: ctx.service30.id, from: FRIDAY, to: FRIDAY })
      .expect(200);

    const body = response.body as { days: { slots: { startsAt: string; endsAt: string }[] }[] };
    const nine = body.days[0]?.slots.find(
      (slot) => slot.startsAt === SLOT_FRIDAY_0900.toISOString(),
    );

    // The seeded service is 30 minutes with a 5-minute cleanup buffer. A customer is
    // told 09:00–09:30; the employee's calendar is blocked to 09:35, and that is not
    // the customer's business.
    expect(nine).toBeDefined();
    expect(nine?.endsAt).toBe(new Date(SLOT_FRIDAY_0900.getTime() + 30 * 60_000).toISOString());
  });

  it('removes a slot once a blocking booking exists', async () => {
    const before = await slotTimes({ from: FRIDAY, to: FRIDAY });
    const taken = before[0];
    expect(taken).toBeDefined();

    await prisma.booking.create({
      data: makeBooking(ctx, {
        employeeId: ctx.employee1.id,
        startsAt: new Date(taken ?? ''),
      }),
    });

    const after = await slotTimes({ from: FRIDAY, to: FRIDAY, employeeId: ctx.employee1.id });
    expect(after).not.toContain(taken);
  });

  it('keeps the slot for the other employee, who is still free', async () => {
    const before = await slotTimes({ from: FRIDAY, to: FRIDAY, employeeId: ctx.employee2.id });
    const taken = before[0];

    await prisma.booking.create({
      data: makeBooking(ctx, { employeeId: ctx.employee1.id, startsAt: new Date(taken ?? '') }),
    });

    const after = await slotTimes({ from: FRIDAY, to: FRIDAY, employeeId: ctx.employee2.id });
    expect(after).toContain(taken);
  });

  it('drops the booked employee from employeeIds rather than the slot', async () => {
    const all = await slotTimes({ from: FRIDAY, to: FRIDAY });
    const taken = all[0] ?? '';

    await prisma.booking.create({
      data: makeBooking(ctx, { employeeId: ctx.employee1.id, startsAt: new Date(taken) }),
    });

    const response = await request(server())
      .get('/public/availability')
      .query({ serviceId: ctx.service30.id, from: FRIDAY, to: FRIDAY })
      .expect(200);

    const body = response.body as {
      days: { slots: { startsAt: string; employeeIds: string[] }[] }[];
    };
    const slot = body.days[0]?.slots.find((candidate) => candidate.startsAt === taken);

    // This is the point of employeeIds: "any employee" is still bookable, just not
    // with the one who is busy.
    expect(slot?.employeeIds).not.toContain(ctx.employee1.id);
    expect(slot?.employeeIds).toContain(ctx.employee2.id);
  });

  it('narrows to one employee when asked, and says so in employeeIds', async () => {
    const response = await request(server())
      .get('/public/availability')
      .query({
        serviceId: ctx.service30.id,
        from: FRIDAY,
        to: FRIDAY,
        employeeId: ctx.employee2.id,
      })
      .expect(200);

    const body = response.body as { days: { slots: { employeeIds: string[] }[] }[] };
    const everyId = new Set(
      body.days.flatMap((day) => day.slots.flatMap((slot) => slot.employeeIds)),
    );

    expect([...everyId]).toEqual([ctx.employee2.id]);
  });

  it('removes a day the organization is closed', async () => {
    await prisma.closedDay.create({
      data: {
        organizationId: ctx.organization.id,
        date: new Date(`${FRIDAY}T00:00:00.000Z`),
        reason: 'Betriebsferien',
      },
    });

    expect(await slotTimes({ from: FRIDAY, to: FRIDAY })).toEqual([]);
  });

  it('removes a day an employee has approved time off, but not a requested one', async () => {
    await prisma.timeOff.create({
      data: {
        organizationId: ctx.organization.id,
        employeeId: ctx.employee1.id,
        startDate: new Date(`${FRIDAY}T00:00:00.000Z`),
        endDate: new Date(`${FRIDAY}T00:00:00.000Z`),
        status: 'REQUESTED',
      },
    });

    // Not yet decided, so it must not quietly remove a day the office might refuse.
    expect(
      (await slotTimes({ from: FRIDAY, to: FRIDAY, employeeId: ctx.employee1.id })).length,
    ).toBeGreaterThan(0);

    await prisma.timeOff.updateMany({ data: { status: 'APPROVED' } });

    expect(await slotTimes({ from: FRIDAY, to: FRIDAY, employeeId: ctx.employee1.id })).toEqual([]);
  });

  it('rejects a range wider than 31 days', async () => {
    const response = await request(server())
      .get('/public/availability')
      .query({ serviceId: ctx.service30.id, from: '2026-08-01', to: '2026-09-15' })
      .expect(400);

    expect(response.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a range that ends before it starts', async () => {
    await request(server())
      .get('/public/availability')
      .query({ serviceId: ctx.service30.id, from: FRIDAY, to: '2026-08-13' })
      .expect(400);
  });

  it('rejects a date beyond the booking horizon', async () => {
    const response = await request(server())
      .get('/public/availability')
      .query({ serviceId: ctx.service30.id, from: '2028-01-01', to: '2028-01-02' })
      .expect(422);

    expect(response.body).toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
  });

  it('404s an archived service without saying it ever existed', async () => {
    await prisma.service.update({
      where: { id: ctx.service30.id },
      data: { archivedAt: NOW },
    });

    const response = await request(server())
      .get('/public/availability')
      .query({ serviceId: ctx.service30.id, from: FRIDAY, to: FRIDAY })
      .expect(404);

    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(response.body)).not.toContain('archived');
  });

  it('404s a service that is not bookable online', async () => {
    await prisma.service.update({
      where: { id: ctx.service30.id },
      data: { isBookableOnline: false },
    });

    await request(server())
      .get('/public/availability')
      .query({ serviceId: ctx.service30.id, from: FRIDAY, to: FRIDAY })
      .expect(404);
  });

  it('404s an employee who does not perform the service', async () => {
    await prisma.employeeService.deleteMany({
      where: { employeeId: ctx.employee2.id, serviceId: ctx.service30.id },
    });

    await request(server())
      .get('/public/availability')
      .query({
        serviceId: ctx.service30.id,
        from: FRIDAY,
        to: FRIDAY,
        employeeId: ctx.employee2.id,
      })
      .expect(404);
  });

  it('ignores an organizationId supplied by the client', async () => {
    const response = await request(server())
      .get('/public/availability')
      .query({
        serviceId: ctx.service30.id,
        from: FRIDAY,
        to: FRIDAY,
        organizationId: 'some-other-organization',
      })
      .expect(200);

    // Stripped by the schema, so it is not an error and changes nothing.
    const body = response.body as { days: unknown[] };
    expect(body.days.length).toBeGreaterThan(0);
  });
});

describe('query count', () => {
  it('costs the same for a month as for a day', async () => {
    // The assertion that actually catches an N+1. A fixed ceiling would pass a
    // per-day query as long as the ceiling was generous enough.
    const oneDay = await countQueriesFor({ from: FRIDAY, to: FRIDAY });
    const oneMonth = await countQueriesFor({ from: '2026-08-01', to: '2026-08-31' });

    expect(oneMonth).toBe(oneDay);
  });

  it('costs the same for two employees as for one', async () => {
    const both = await countQueriesFor({ from: FRIDAY, to: FRIDAY });
    const one = await countQueriesFor({ from: FRIDAY, to: FRIDAY, employeeId: ctx.employee1.id });

    expect(both).toBe(one);
  });

  it('stays in single digits, so the absolute cost is bounded too', async () => {
    expect(await countQueriesFor({ from: '2026-08-01', to: '2026-08-31' })).toBeLessThan(10);
  });
});

/** Run one availability request and report how many operations it cost. */
async function countQueriesFor(query: Record<string, string>): Promise<number> {
  queryCounter.reset();
  await slotTimes(query);
  return queryCounter.total();
}

describe('the global guard', () => {
  it('lets a public route through without a credential', async () => {
    await request(server()).get('/public/services').expect(200);
  });
});
