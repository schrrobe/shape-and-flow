import { beforeEach, describe, expect, it } from 'vitest';

import { BookingFinancialsService } from '../../src/payment/booking-financials.service.js';
import { prisma, resetDatabase } from '../database.harness.js';
import { SLOT_FRIDAY_0900, makeBooking, seedOrganization } from '../factories/index.js';

import type { OrganizationContextService } from '../../src/organization/organization-context.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import type { SeedContext } from '../factories/index.js';

/**
 * The money on a reschedule chain, read from any link in it.
 *
 * A reschedule replaces the booking row, and the payment stays on the one that was
 * paid. Every consumer that read `booking.payments` therefore saw nothing on a
 * replacement — no paid total, no refundable balance, no export line. This is the read
 * they all share now, so "which booking was paid" is answered in exactly one place.
 */

const db = prisma as unknown as PrismaService;
const NOW = new Date('2026-08-10T06:00:00.000Z');

let ctx: SeedContext;
let service: BookingFinancialsService;

let rootId: string;
let firstChildId: string;
let secondChildId: string;
let paymentId: string;
let refundId: string;

beforeEach(async () => {
  await resetDatabase();
  ctx = await seedOrganization(prisma);

  const organizations = {
    getOrganizationId: () => ctx.organization.id,
  } as OrganizationContextService;

  service = new BookingFinancialsService(db, organizations);

  const root = await prisma.booking.create({
    data: { ...makeBooking(ctx, { status: 'CANCELED_BY_BUSINESS', expiresAt: null }) },
  });
  rootId = root.id;

  const payment = await prisma.payment.create({
    data: {
      organizationId: ctx.organization.id,
      bookingId: root.id,
      stripeCheckoutSessionId: `cs_test_${root.id}`,
      amountCents: root.priceCentsSnapshot,
      currency: root.currency,
      status: 'SUCCEEDED',
      paidAt: NOW,
    },
  });
  paymentId = payment.id;

  const refund = await prisma.refund.create({
    data: {
      organizationId: ctx.organization.id,
      bookingId: root.id,
      paymentId: payment.id,
      amountCents: 1000,
      currency: root.currency,
      status: 'PENDING',
      reason: 'GOODWILL',
      idempotencyKey: `refund-${root.id}`,
    },
  });
  refundId = refund.id;

  const first = await prisma.booking.create({
    data: {
      ...makeBooking(ctx, {
        status: 'CANCELED_BY_BUSINESS',
        expiresAt: null,
        startsAt: new Date(SLOT_FRIDAY_0900.getTime() + 2 * 60 * 60_000),
      }),
      rescheduledFromBookingId: root.id,
      financialRootBookingId: root.id,
    },
  });
  firstChildId = first.id;

  const second = await prisma.booking.create({
    data: {
      ...makeBooking(ctx, {
        status: 'CONFIRMED',
        expiresAt: null,
        startsAt: new Date(SLOT_FRIDAY_0900.getTime() + 4 * 60 * 60_000),
      }),
      confirmedAt: NOW,
      rescheduledFromBookingId: first.id,
      financialRootBookingId: root.id,
    },
  });
  secondChildId = second.id;
});

describe('load', () => {
  it('answers with the root money from any booking in the chain', async () => {
    for (const bookingId of [rootId, firstChildId, secondChildId]) {
      const financials = await service.load(bookingId);

      expect(financials.rootBookingId).toBe(rootId);
      expect(financials.payments.map((payment) => payment.id)).toEqual([paymentId]);
      expect(financials.refunds.map((refund) => refund.id)).toEqual([refundId]);
    }
  });

  it('finds a refund requested against the root payment, not the refund booking id', async () => {
    // A refund issued from a replacement stores that booking's id. Selecting through the
    // payment is what keeps every refund on the chain visible from every link.
    await prisma.refund.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: secondChildId,
        paymentId,
        amountCents: 500,
        currency: 'EUR',
        status: 'PENDING',
        reason: 'GOODWILL',
        idempotencyKey: `refund-second-${secondChildId}`,
      },
    });

    expect((await service.load(rootId)).refunds).toHaveLength(2);
    expect((await service.load(secondChildId)).refunds).toHaveLength(2);
  });

  it('includes manual payments recorded on the root', async () => {
    await prisma.manualPayment.create({
      data: {
        organizationId: ctx.organization.id,
        bookingId: rootId,
        amountCents: 500,
        currency: 'EUR',
        method: 'CASH',
        paidAt: NOW,
        recordedByOfficeUserId: ctx.owner.id,
      },
    });

    expect((await service.load(secondChildId)).manualPayments).toHaveLength(1);
  });

  it('refuses a booking in another organization', async () => {
    const other = await seedOrganization(prisma, { slug: 'other-studio' });
    const foreign = await prisma.booking.create({
      data: { ...makeBooking(other, { status: 'CONFIRMED', expiresAt: null }) },
    });

    await expect(service.load(foreign.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('loadMany', () => {
  it('groups a whole page onto its roots in a constant number of queries', async () => {
    const financials = await service.loadMany([rootId, firstChildId, secondChildId]);

    expect([...financials.keys()].sort()).toEqual([rootId, firstChildId, secondChildId].sort());
    for (const entry of financials.values()) {
      expect(entry.rootBookingId).toBe(rootId);
      expect(entry.payments).toHaveLength(1);
    }
  });

  it('returns an empty map for no ids at all', async () => {
    expect((await service.loadMany([])).size).toBe(0);
  });
});

describe('rootBookingId', () => {
  it('is the booking itself when nothing was rescheduled', async () => {
    expect(await service.rootBookingId(rootId)).toBe(rootId);
  });

  it('is the original for every replacement', async () => {
    expect(await service.rootBookingId(secondChildId)).toBe(rootId);
  });
});
