import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { RescheduleService } from '../../src/booking/reschedule.service.js';
import { ReservationService } from '../../src/booking/reservation.service.js';
import { FixedClock } from '../../src/domain/time/clock.js';
import { ManageModule } from '../../src/manage/manage.module.js';
import { ManagementTokenService } from '../../src/manage/management-token.service.js';
import { JOB } from '../../src/messaging/queues/job-contracts.js';
import { createBookingTestApp } from '../booking-app.harness.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, makeBooking, seedOrganization } from '../factories/index.js';
import { loadOrganization } from '../public-app.harness.js';

import type { ReserveInput } from '../../src/booking/reservation.service.js';
import type { BookingTestApp } from '../booking-app.harness.js';
import type { SeedContext } from '../factories/index.js';
import type { Server } from 'node:http';

const NOW = new Date('2026-08-10T06:00:00.000Z');

/** The slot the original booking holds: Friday 09:00 Berlin. */
const ORIGINAL_SLOT = SLOT_FRIDAY_0900;

/** Two hours later the same day — a real slot on the seeded schedule. */
const NEW_SLOT = new Date(SLOT_FRIDAY_0900.getTime() + 2 * 60 * 60_000);

let ctx: SeedContext;
let clock: FixedClock;
let testApp: BookingTestApp;
let server: () => Server;
let service: RescheduleService;
let reservations: ReservationService;
let tokens: ManagementTokenService;
let bookingId: string;

/** A confirmed, paid booking on the original slot. */
async function confirmedBooking(): Promise<string> {
  const booking = await prisma.booking.create({
    data: {
      ...makeBooking(ctx, { status: 'CONFIRMED', expiresAt: null, startsAt: ORIGINAL_SLOT }),
      confirmedAt: NOW,
    },
  });

  await prisma.payment.create({
    data: {
      organizationId: ctx.organization.id,
      bookingId: booking.id,
      stripeCheckoutSessionId: `cs_test_${booking.id}`,
      amountCents: booking.priceCentsSnapshot,
      currency: booking.currency,
      status: 'SUCCEEDED',
      paidAt: NOW,
    },
  });

  return booking.id;
}

/** A reservation for a given slot with employee1, for proving whether it is free. */
function atSlot(startsAt: Date, employeeId = ctx.employee1.id): ReserveInput {
  return {
    serviceId: ctx.service30.id,
    employeeId,
    startsAt,
    customer: { email: 'bea@example.com', firstName: 'Bea', lastName: 'Kraus', locale: 'de' },
    locale: 'de',
  };
}

async function openRequest(
  overrides: { requestedStartsAt?: Date; requestedEmployeeId?: string } = {},
): Promise<string> {
  const { requestId } = await service.requestByCustomer({
    bookingId,
    requestedStartsAt: overrides.requestedStartsAt ?? NEW_SLOT,
    ...(overrides.requestedEmployeeId === undefined
      ? {}
      : { requestedEmployeeId: overrides.requestedEmployeeId }),
  });

  return requestId;
}

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);
  clock = new FixedClock(NOW);

  testApp = await createBookingTestApp({
    organization: await loadOrganization(ctx.organization.id),
    clock,
    extraImports: [ManageModule],
  });

  server = testApp.server;
  service = testApp.app.get(RescheduleService);
  reservations = testApp.app.get(ReservationService);
  tokens = testApp.app.get(ManagementTokenService);

  bookingId = await confirmedBooking();

  return testApp.close;
});

describe('the financial root', () => {
  it('stays the original booking across two reschedules', async () => {
    // The money never moves off the booking that was paid. Without a stable root, the
    // second replacement is two hops from it and every financial read has to walk the
    // chain — or, as they all did, give up and report nothing.
    const first = await service.decide({
      requestId: await openRequest(),
      officeUserId: ctx.owner.id,
      decision: 'APPROVED',
    });
    if (first.newBookingId === null) throw new Error('expected a replacement booking');

    const { requestId } = await service.requestByCustomer({
      bookingId: first.newBookingId,
      requestedStartsAt: new Date(NEW_SLOT.getTime() + 2 * 60 * 60_000),
    });
    const second = await service.decide({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'APPROVED',
    });
    if (second.newBookingId === null) throw new Error('expected a second replacement');

    const [firstReplacement, secondReplacement] = await Promise.all([
      prisma.booking.findUniqueOrThrow({ where: { id: first.newBookingId } }),
      prisma.booking.findUniqueOrThrow({ where: { id: second.newBookingId } }),
    ]);

    expect(firstReplacement.financialRootBookingId).toBe(bookingId);
    expect(secondReplacement.financialRootBookingId).toBe(bookingId);
  });
});

describe('the notifications a request produces', () => {
  it('queues a notification row for every send event it records', async () => {
    await openRequest();

    const events = await prisma.outboxEvent.findMany({
      where: { eventType: JOB.NOTIFICATION_SEND },
    });
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      const { notificationId } = event.payload as { notificationId: string };
      await expect(
        prisma.notification.findUniqueOrThrow({ where: { id: notificationId } }),
      ).resolves.toBeDefined();
    }

    expect(
      await prisma.notification.count({
        where: { bookingId, kind: 'RESCHEDULE_REQUEST_RECEIVED' },
      }),
    ).toBe(1);
  });

  it('tells the customer when their request is rejected, with no link to a moved booking', async () => {
    const requestId = await openRequest();

    await service.decide({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'REJECTED',
      note: 'an dem Tag ausgebucht',
    });

    const decided = await prisma.notification.findFirstOrThrow({
      where: { bookingId, kind: 'RESCHEDULE_REQUEST_DECIDED' },
    });
    expect(decided.payload).toMatchObject({ approved: false, manageUrl: null });
  });

  it('tells the customer once when their request is approved', async () => {
    const requestId = await openRequest();

    const { newBookingId } = await service.decide({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'APPROVED',
    });
    if (newBookingId === null) throw new Error('expected a replacement booking');

    // Against the replacement, which is the booking the customer now has.
    expect(
      await prisma.notification.count({
        where: { bookingId: newBookingId, kind: 'RESCHEDULE_REQUEST_DECIDED' },
      }),
    ).toBe(1);

    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: newBookingId, eventType: JOB.BOOKING_RESCHEDULED },
    });
    expect(
      (event.payload as { customerNotificationAlreadyQueued?: boolean })
        .customerNotificationAlreadyQueued,
    ).toBe(true);
  });
});

describe('asking for a new slot', () => {
  it('creates a request without touching the booking', async () => {
    const requestId = await openRequest();

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(
      'CONFIRMED',
    );
    expect(
      (await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).decision,
    ).toBe('PENDING');
  });

  it('keeps the original slot blocked while the office decides', async () => {
    await openRequest();

    // Until the office agrees, the customer still has the appointment they had.
    await expect(reservations.reserve(atSlot(ORIGINAL_SLOT))).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });

  it('refuses a second open request', async () => {
    await openRequest();

    await expect(openRequest()).rejects.toMatchObject({
      code: 'BOOKING_NOT_RESCHEDULABLE',
    });
    expect(await prisma.rescheduleRequest.count({ where: { bookingId } })).toBe(1);
  });

  it('refuses a booking that is not confirmed', async () => {
    await prisma.booking.update({ where: { id: bookingId }, data: { status: 'COMPLETED' } });

    await expect(openRequest()).rejects.toMatchObject({
      code: 'BOOKING_NOT_RESCHEDULABLE',
    });
  });

  it('refuses an appointment that has already started', async () => {
    clock.set(new Date(ORIGINAL_SLOT.getTime() + 60_000));

    await expect(openRequest()).rejects.toMatchObject({
      code: 'BOOKING_NOT_RESCHEDULABLE',
    });
  });

  it('refuses a requested time inside the notice window', async () => {
    await expect(
      openRequest({ requestedStartsAt: new Date(NOW.getTime() + 60 * 60_000) }),
    ).rejects.toMatchObject({ code: 'OUTSIDE_BOOKING_WINDOW' });
  });

  it('refuses a requested slot that is already taken, before the office sees it', async () => {
    await reservations.reserve(atSlot(NEW_SLOT));

    // An optimistic check: better a fast rejection than a request sitting in the queue
    // that nobody can approve.
    await expect(openRequest()).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });
});

describe('approving', () => {
  it('creates a new CONFIRMED booking and cancels the old one', async () => {
    const requestId = await openRequest();

    const { newBookingId } = await service.decide({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'APPROVED',
    });

    expect(newBookingId).not.toBeNull();

    const old = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const created = await prisma.booking.findUniqueOrThrow({ where: { id: newBookingId ?? '' } });

    expect(old).toMatchObject({
      status: 'CANCELED_BY_BUSINESS',
      cancellationReason: 'RESCHEDULED',
      canceledByOfficeUserId: ctx.owner.id,
    });
    expect(created).toMatchObject({
      status: 'CONFIRMED',
      rescheduledFromBookingId: bookingId,
    });
    expect(created.startsAt).toEqual(NEW_SLOT);
  });

  it('carries the original price and duration, not the current service values', async () => {
    // A service repriced since the booking was made must not change what the customer
    // agreed to pay.
    await prisma.service.update({
      where: { id: ctx.service30.id },
      data: { priceCents: 9900, durationMinutes: 90 },
    });

    const requestId = await openRequest();
    const { newBookingId } = await service.decide({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'APPROVED',
    });

    const created = await prisma.booking.findUniqueOrThrow({ where: { id: newBookingId ?? '' } });

    expect(created.priceCentsSnapshot).toBe(ctx.service30.priceCents);
    expect(created.durationMinutesSnapshot).toBe(30);
    expect(created.endsAt).toEqual(new Date(NEW_SLOT.getTime() + 30 * 60_000));
  });

  it('swaps the slots: the old one is free and the new one is taken', async () => {
    const requestId = await openRequest();
    await service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' });

    await expect(reservations.reserve(atSlot(ORIGINAL_SLOT))).resolves.toBeDefined();
    await expect(reservations.reserve(atSlot(NEW_SLOT))).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });

  it('moves to another employee when one is requested', async () => {
    const requestId = await openRequest({ requestedEmployeeId: ctx.employee2.id });

    const { newBookingId } = await service.decide({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'APPROVED',
    });

    const created = await prisma.booking.findUniqueOrThrow({ where: { id: newBookingId ?? '' } });
    expect(created.employeeId).toBe(ctx.employee2.id);
  });

  it('writes a history row for each booking', async () => {
    const requestId = await openRequest();
    const { newBookingId } = await service.decide({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'APPROVED',
    });

    // Two bookings changed status, so each needs its own explanation.
    expect(
      await prisma.bookingStatusHistory.count({
        where: { bookingId, toStatus: 'CANCELED_BY_BUSINESS' },
      }),
    ).toBe(1);
    expect(
      await prisma.bookingStatusHistory.count({
        where: { bookingId: newBookingId ?? '', toStatus: 'CONFIRMED' },
      }),
    ).toBe(1);
  });

  it('links the request to the booking it produced', async () => {
    const requestId = await openRequest();
    const { newBookingId } = await service.decide({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'APPROVED',
    });

    const req = await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(req).toMatchObject({
      decision: 'APPROVED',
      resultingBookingId: newBookingId,
      decidedByOfficeUserId: ctx.owner.id,
    });
  });

  it('leaves the payment on the original booking, reachable through the lineage', async () => {
    const requestId = await openRequest();
    const { newBookingId } = await service.decide({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'APPROVED',
    });

    // The money was taken for the original booking; the link is how the replacement
    // reaches it.
    expect(await prisma.payment.count({ where: { bookingId } })).toBe(1);
    expect(await prisma.payment.count({ where: { bookingId: newBookingId ?? '' } })).toBe(0);

    const created = await prisma.booking.findUniqueOrThrow({
      where: { id: newBookingId ?? '' },
      include: { rescheduledFrom: { include: { payments: true } } },
    });
    expect(created.rescheduledFrom?.payments).toHaveLength(1);
  });

  it('queues the notification and re-schedules the reminders', async () => {
    const requestId = await openRequest();
    const { newBookingId } = await service.decide({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'APPROVED',
    });

    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: newBookingId ?? '', eventType: JOB.BOOKING_RESCHEDULED },
      }),
    ).toBe(1);
    // The reminders were scheduled for the old time and have to be scheduled again.
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: newBookingId ?? '', eventType: JOB.REMINDER_SCHEDULE },
      }),
    ).toBe(1);
  });

  it('audits the decision', async () => {
    const requestId = await openRequest();
    await service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' });

    expect(
      await prisma.auditLog.count({
        where: { action: 'RESCHEDULE_REQUEST_DECIDED', entityId: requestId },
      }),
    ).toBe(1);
  });

  it('refuses a second decision', async () => {
    const requestId = await openRequest();
    await service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' });

    await expect(
      service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' }),
    ).rejects.toMatchObject({ code: 'REQUEST_ALREADY_DECIDED' });
  });
});

describe('the management link', () => {
  it('rotates, so the old link stops working', async () => {
    const { token: oldToken } = await prisma.$transaction((tx) =>
      tokens.issue(tx, bookingId, ctx.organization.id, ORIGINAL_SLOT),
    );

    // Prove it worked before the reschedule, so the 401 afterwards means something.
    await request(server())
      .get('/manage/booking')
      .set('Authorization', `Bearer ${oldToken}`)
      .expect(200);

    const requestId = await openRequest();
    await service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' });

    // The old link is in the customer's mailbox and would otherwise keep opening a
    // cancelled booking, showing them a stale appointment.
    await request(server())
      .get('/manage/booking')
      .set('Authorization', `Bearer ${oldToken}`)
      .expect(401);

    expect(await prisma.managementToken.count({ where: { revokedAt: null } })).toBe(1);
  });

  it('issues a working link for the new booking, carried in the outbox payload', async () => {
    await prisma.$transaction((tx) =>
      tokens.issue(tx, bookingId, ctx.organization.id, ORIGINAL_SLOT),
    );

    const requestId = await openRequest();
    const { newBookingId } = await service.decide({
      requestId,
      officeUserId: ctx.owner.id,
      decision: 'APPROVED',
    });

    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: newBookingId ?? '', eventType: JOB.BOOKING_RESCHEDULED },
    });
    const token = (event.payload as { managementToken: string }).managementToken;

    const response = await request(server())
      .get('/manage/booking')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect((response.body as { startsAt: string }).startsAt).toBe(NEW_SLOT.toISOString());
  });
});

describe('when the requested slot was taken meanwhile', () => {
  it('fails with SLOT_UNAVAILABLE and changes nothing', async () => {
    const requestId = await openRequest();

    // Somebody books the requested slot between the request and the approval.
    await reservations.reserve(atSlot(NEW_SLOT));

    await expect(
      service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'APPROVED' }),
    ).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });

    // The whole transaction rolled back: the office can try again or reject it.
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(
      'CONFIRMED',
    );
    expect(
      (await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).decision,
    ).toBe('PENDING');
    expect(await prisma.booking.count({ where: { rescheduledFromBookingId: bookingId } })).toBe(0);
  });
});

describe('rejecting', () => {
  it('changes nothing but the request', async () => {
    const requestId = await openRequest();

    expect(
      await service.decide({ requestId, officeUserId: ctx.owner.id, decision: 'REJECTED' }),
    ).toEqual({ newBookingId: null });

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(
      'CONFIRMED',
    );
    expect(
      (await prisma.rescheduleRequest.findUniqueOrThrow({ where: { id: requestId } })).decision,
    ).toBe('REJECTED');

    // The original slot is still theirs.
    await expect(reservations.reserve(atSlot(ORIGINAL_SLOT))).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
    });
  });

  it('lets a new request be opened afterwards', async () => {
    const first = await openRequest();
    await service.decide({ requestId: first, officeUserId: ctx.owner.id, decision: 'REJECTED' });

    // The partial unique index only excludes a second *pending* request.
    await expect(openRequest()).resolves.toBeDefined();
  });
});

describe('POST /manage/reschedule-requests', () => {
  it('accepts a request and always answers 202', async () => {
    const { token } = await prisma.$transaction((tx) =>
      tokens.issue(tx, bookingId, ctx.organization.id, ORIGINAL_SLOT),
    );

    const response = await request(server())
      .post('/manage/reschedule-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ requestedStartsAt: NEW_SLOT.toISOString(), reason: 'Zug fällt aus' })
      .expect(202);

    // Asking never moves the appointment, so there is nothing to report as done.
    expect(response.body).toMatchObject({ requestedStartsAt: NEW_SLOT.toISOString() });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status).toBe(
      'CONFIRMED',
    );
  });

  it('takes the booking from the token, not the body', async () => {
    const other = await prisma.booking.create({
      data: {
        ...makeBooking(ctx, {
          status: 'CONFIRMED',
          expiresAt: null,
          employeeId: ctx.employee2.id,
          startsAt: ORIGINAL_SLOT,
        }),
        confirmedAt: NOW,
      },
    });

    const { token } = await prisma.$transaction((tx) =>
      tokens.issue(tx, bookingId, ctx.organization.id, ORIGINAL_SLOT),
    );

    await request(server())
      .post('/manage/reschedule-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ bookingId: other.id, requestedStartsAt: NEW_SLOT.toISOString() })
      .expect(202);

    expect(await prisma.rescheduleRequest.count({ where: { bookingId } })).toBe(1);
    expect(await prisma.rescheduleRequest.count({ where: { bookingId: other.id } })).toBe(0);
  });

  it('requires a token', async () => {
    await request(server())
      .post('/manage/reschedule-requests')
      .send({ requestedStartsAt: NEW_SLOT.toISOString() })
      .expect(401);
  });

  it('rejects a malformed instant', async () => {
    const { token } = await prisma.$transaction((tx) =>
      tokens.issue(tx, bookingId, ctx.organization.id, ORIGINAL_SLOT),
    );

    await request(server())
      .post('/manage/reschedule-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ requestedStartsAt: 'next tuesday' })
      .expect(400);
  });
});
