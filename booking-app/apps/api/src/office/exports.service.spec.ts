import { describe, expect, it, vi } from 'vitest';

import { BookingFinancialsService } from '../payment/booking-financials.service.js';

import { ExportsService } from './exports.service.js';

import type { OrganizationContextService } from '../organization/organization-context.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Readable } from 'node:stream';

const query = { from: '2026-08-01', to: '2026-08-31', includeCustomerNote: false } as const;

describe('ExportsService.payments', () => {
  it('pages each source and keeps the refund filter on settled money', async () => {
    const payments = Array.from({ length: 500 }, (_, index) => ({
      id: `payment-${String(index).padStart(4, '0')}`,
      amountCents: 100,
      currency: 'EUR',
      status: 'SUCCEEDED',
      paymentMethodType: 'card',
      paidAt: new Date(`2026-08-${String((index % 28) + 1).padStart(2, '0')}T10:00:00.000Z`),
      booking: { reference: `REF-${String(index)}`, serviceNameSnapshot: 'Cut' },
    }));

    const paymentFindMany = vi.fn().mockResolvedValueOnce(payments).mockResolvedValueOnce([]);
    const manualFindMany = vi.fn().mockResolvedValue([]);
    const refundFindMany = vi.fn().mockResolvedValue([]);
    const service = makeService(paymentFindMany, manualFindMany, refundFindMany);

    await textOf(service.payments('organization-1', query));

    expect(paymentFindMany).toHaveBeenCalledTimes(2);
    expect(paymentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ paidAt: 'asc' }, { id: 'asc' }], take: 500 }),
    );
    expect(refundFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ settledAt: 'asc' }, { id: 'asc' }],
        take: 500,
        where: {
          organizationId: 'organization-1',
          settledAt: {
            gte: new Date('2026-07-31T22:00:00.000Z'),
            lt: new Date('2026-08-31T22:00:00.000Z'),
          },
          status: 'SUCCEEDED',
        },
      }),
    );
  });

  it('merges card, manual and refund rows by their ledger timestamp', async () => {
    const paymentFindMany = vi.fn().mockResolvedValue([
      {
        id: 'payment',
        amountCents: 3000,
        currency: 'EUR',
        status: 'SUCCEEDED',
        paymentMethodType: 'card',
        paidAt: new Date('2026-08-03T10:00:00.000Z'),
        booking: { reference: 'P', serviceNameSnapshot: 'Cut' },
      },
    ]);
    const manualFindMany = vi.fn().mockResolvedValue([
      {
        id: 'manual',
        amountCents: 2000,
        currency: 'EUR',
        method: 'CASH',
        paidAt: new Date('2026-08-02T10:00:00.000Z'),
        note: null,
        booking: { reference: 'M', serviceNameSnapshot: 'Cut' },
      },
    ]);
    const refundFindMany = vi.fn().mockResolvedValue([
      {
        id: 'refund',
        amountCents: 1000,
        currency: 'EUR',
        status: 'SUCCEEDED',
        reason: 'GOODWILL',
        settledAt: new Date('2026-08-01T10:00:00.000Z'),
        booking: { reference: 'R', serviceNameSnapshot: 'Cut' },
      },
    ]);
    const service = makeService(paymentFindMany, manualFindMany, refundFindMany);

    const csv = await textOf(service.payments('organization-1', query));
    const kinds = csv
      .split('\r\n')
      .slice(1)
      .filter(Boolean)
      .map((line) => line.split(';')[0]);

    expect(kinds).toEqual(['REFUND', 'MANUAL', 'STRIPE']);
    expect(csv).toContain(';-10,00;EUR;SUCCEEDED;');
  });
});

function makeService(
  paymentFindMany: ReturnType<typeof vi.fn>,
  manualFindMany: ReturnType<typeof vi.fn>,
  refundFindMany: ReturnType<typeof vi.fn>,
): ExportsService {
  const prisma = {
    payment: { findMany: paymentFindMany },
    manualPayment: { findMany: manualFindMany },
    refund: { findMany: refundFindMany },
  } as unknown as PrismaService;
  const organizations = {
    getTimezone: () => 'Europe/Berlin',
  } as OrganizationContextService;

  const financials = new BookingFinancialsService(prisma, organizations);
  return new ExportsService(prisma, organizations, financials);
}

async function textOf(stream: Readable): Promise<string> {
  let value = '';
  for await (const chunk of stream) value += String(chunk);
  return value;
}
