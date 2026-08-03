import { Injectable } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { ManualPayment, Prisma, Refund } from '../prisma/client.js';

/**
 * The payment columns every financial consumer needs, list and detail alike.
 *
 * `bookingId` is not decoration: it is the key the batched read groups on.
 */
export const FINANCIAL_PAYMENT = {
  id: true,
  bookingId: true,
  amountCents: true,
  currency: true,
  status: true,
  paymentMethodType: true,
  refundedAmountCents: true,
  paidAt: true,
  createdAt: true,
} as const satisfies Prisma.PaymentSelect;

export type FinancialPayment = Prisma.PaymentGetPayload<{ select: typeof FINANCIAL_PAYMENT }>;
export type FinancialManualPayment = ManualPayment;
export type FinancialRefund = Refund;

export interface BookingFinancials {
  rootBookingId: string;
  payments: FinancialPayment[];
  manualPayments: FinancialManualPayment[];
  refunds: FinancialRefund[];
}

export function emptyFinancials(rootBookingId: string): BookingFinancials {
  return { rootBookingId, payments: [], manualPayments: [], refunds: [] };
}

/**
 * What has been paid on a booking, asked once and answered the same way everywhere.
 *
 * A reschedule creates a new booking row and cancels the old one; the payment stays
 * where the money arrived. So `booking.payments` on a replacement is empty, and every
 * consumer that read it — the customer's own /manage page, the office list and detail,
 * the CSV exports, the notification composer — showed a rescheduled appointment as
 * unpaid, with a refundable balance of zero. The bug was not in any one of them. It was
 * that each of them decided independently where the money lived.
 *
 * `financialRootBookingId` is that decision, made once and stored, and this service is
 * the only place that reads it. Two consequences worth stating:
 *
 *  - **Refunds are selected through their payment**, not through `Refund.bookingId`. A
 *    refund issued from a replacement carries that replacement's id, so filtering by
 *    booking would hide it from the original and every sibling.
 *  - **`loadMany` is the shape to reach for.** A page of fifty bookings costs three
 *    queries, not fifty: resolve the roots, then one read per financial table over the
 *    distinct root ids. An N+1 here would be invisible in a test and obvious under load.
 */
@Injectable()
export class BookingFinancialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
  ) {}

  /** The booking the money is on. The booking itself, unless it was rescheduled. */
  async rootBookingId(bookingId: string, tx?: Prisma.TransactionClient): Promise<string> {
    const booking = await (tx ?? this.prisma).booking.findFirst({
      where: { id: bookingId, organizationId: this.organizations.getOrganizationId() },
      select: { id: true, financialRootBookingId: true },
    });

    if (booking === null) {
      throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
    }

    return booking.financialRootBookingId ?? booking.id;
  }

  async load(bookingId: string, tx?: Prisma.TransactionClient): Promise<BookingFinancials> {
    if (tx !== undefined) return await this.loadWithClient(tx, bookingId);

    const financials = (await this.loadMany([bookingId])).get(bookingId);

    // `loadMany` throws for an unknown booking, so this cannot be missing. Checked
    // rather than asserted, because a non-null assertion here would be a lie the day
    // the grouping changes.
    if (financials === undefined) {
      throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
    }

    return financials;
  }

  /**
   * Every requested booking's financials, in a constant number of queries.
   *
   * An unknown or foreign id is a `NOT_FOUND` rather than an empty entry: a caller
   * rendering a page would otherwise show a booking from another tenant as one with no
   * money on it.
   */
  async loadMany(bookingIds: string[]): Promise<Map<string, BookingFinancials>> {
    const requested = [...new Set(bookingIds)];
    if (requested.length === 0) return new Map();

    const bookings = await this.prisma.booking.findMany({
      where: { id: { in: requested }, organizationId: this.organizations.getOrganizationId() },
      select: { id: true, financialRootBookingId: true },
    });

    if (bookings.length !== requested.length) {
      throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
    }

    const rootByBooking = new Map(
      bookings.map((booking) => [booking.id, booking.financialRootBookingId ?? booking.id]),
    );
    const rootIds = [...new Set(rootByBooking.values())];

    const byRoot = await this.readRoots(this.prisma, rootIds);

    return new Map(
      bookingIds.map((bookingId) => {
        const rootBookingId = rootByBooking.get(bookingId);

        if (rootBookingId === undefined) {
          throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
        }

        return [bookingId, byRoot.get(rootBookingId) ?? emptyFinancials(rootBookingId)];
      }),
    );
  }

  /** The single-booking read, through a caller's transaction. */
  private async loadWithClient(
    tx: Prisma.TransactionClient,
    bookingId: string,
  ): Promise<BookingFinancials> {
    const rootBookingId = await this.rootBookingId(bookingId, tx);
    const byRoot = await this.readRoots(tx, [rootBookingId]);

    return byRoot.get(rootBookingId) ?? emptyFinancials(rootBookingId);
  }

  /**
   * One read per financial table, grouped back onto the roots they belong to.
   *
   * Three queries whether there is one root or fifty, which is the property a page
   * render depends on.
   */
  private async readRoots(
    client: PrismaService | Prisma.TransactionClient,
    rootIds: string[],
  ): Promise<Map<string, BookingFinancials>> {
    const [payments, manualPayments, refunds] = await Promise.all([
      client.payment.findMany({
        where: { bookingId: { in: rootIds } },
        select: FINANCIAL_PAYMENT,
        orderBy: { createdAt: 'asc' },
      }),
      client.manualPayment.findMany({
        where: { bookingId: { in: rootIds } },
        orderBy: { paidAt: 'asc' },
      }),
      // Through the payment, not `Refund.bookingId`: a refund issued from a replacement
      // stores that booking's id and would otherwise be invisible from the original.
      client.refund.findMany({
        where: { payment: { bookingId: { in: rootIds } } },
        include: { payment: { select: { bookingId: true } } },
        orderBy: { requestedAt: 'asc' },
      }),
    ]);

    const byRoot = new Map(
      rootIds.map((rootBookingId) => [rootBookingId, emptyFinancials(rootBookingId)]),
    );

    for (const payment of payments) byRoot.get(payment.bookingId)?.payments.push(payment);
    for (const payment of manualPayments)
      byRoot.get(payment.bookingId)?.manualPayments.push(payment);

    for (const refund of refunds) {
      // The nested payment is the grouping key only; consumers get the refund row.
      const { payment, ...row } = refund;
      byRoot.get(payment.bookingId)?.refunds.push(row);
    }

    return byRoot;
  }
}
