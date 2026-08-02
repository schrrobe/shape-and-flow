import { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';

import { addLocalDays, wallClockToInstantOrThrow } from '../domain/time/local-time.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import {
  BookingFinancialsService,
  emptyFinancials,
} from '../payment/booking-financials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { CSV_BOM, csvAmount, csvInstant, csvLine } from './csv.js';
import { receivedFrom } from './received.js';

import type { ExportQuery } from '@shape-and-flow/booking-contracts';

/**
 * How many rows are fetched per round trip while streaming.
 *
 * Small enough that a year of bookings never sits in memory at once, large enough that a
 * normal month is one or two queries.
 */
const PAGE_SIZE = 500;

/**
 * The accounting hand-off.
 *
 * **Streamed, not buffered.** A `Readable` that pages through the range with a keyset
 * cursor, so exporting a year costs the same memory as exporting a day. Building the
 * whole file as a string first is the version that works in testing and falls over on
 * the one request that matters — the annual one, in January.
 *
 * The payments export is deliberately **one ledger with a `kind` column** rather than
 * three files. A bookkeeper reconciling a month wants every movement of money in date
 * order; splitting them by mechanism makes them do the merge by hand.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly financials: BookingFinancialsService,
  ) {}

  bookings(organizationId: string, query: ExportQuery): Readable {
    const zone = this.organizations.getTimezone();
    const { from, to } = this.range(query, zone);

    const header = [
      'reference',
      'status',
      'origin',
      'startsAt',
      'endsAt',
      'employee',
      'service',
      'customerFirstName',
      'customerLastName',
      'customerEmail',
      'customerPhone',
      'priceEur',
      'paidEur',
      'currency',
      'createdAt',
      ...(query.includeCustomerNote ? ['customerNote'] : []),
    ];

    return this.stream(header, async (cursor) => {
      const rows = await this.prisma.booking.findMany({
        where: {
          organizationId,
          startsAt: { gte: from, lt: to },
          ...(query.status === undefined ? {} : { status: { in: query.status } }),
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        select: {
          id: true,
          reference: true,
          status: true,
          origin: true,
          startsAt: true,
          endsAt: true,
          serviceNameSnapshot: true,
          priceCentsSnapshot: true,
          currency: true,
          customerNote: true,
          createdAt: true,
          employee: { select: { displayName: true } },
          customer: {
            select: { firstName: true, lastName: true, email: true, phone: true },
          },
        },
        // By id, which is the only column guaranteed unique — so the page boundary can
        // never split or repeat a row the way a timestamp cursor can on ties.
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
      });

      // Batched per page. A rescheduled booking's payment sits on the row that was paid,
      // so reading each booking's own relation exported it as unpaid.
      const financials = await this.financials.loadMany(rows.map((row) => row.id));

      return {
        cursor: rows.at(-1)?.id ?? null,
        lines: rows.map((booking) =>
          csvLine([
            booking.reference,
            booking.status,
            booking.origin,
            csvInstant(booking.startsAt, zone),
            csvInstant(booking.endsAt, zone),
            booking.employee.displayName,
            booking.serviceNameSnapshot,
            booking.customer.firstName,
            booking.customer.lastName,
            booking.customer.email,
            booking.customer.phone,
            csvAmount(booking.priceCentsSnapshot),
            csvAmount(
              receivedFrom(
                financials.get(booking.id) ?? emptyFinancials(booking.id),
                booking.currency,
              ).amountCents,
            ),
            booking.currency,
            csvInstant(booking.createdAt, zone),
            ...(query.includeCustomerNote ? [booking.customerNote] : []),
          ]),
        ),
      };
    });
  }

  /**
   * Every movement of money in the range, in one file.
   *
   * Three sources, one shape. The three reads happen up front rather than page by page,
   * because a ledger has to be *sorted by date across all three* — paging them
   * independently would interleave them wrongly, and a bookkeeper reading a month of
   * movements out of order is worse than a month held in memory.
   */
  async payments(organizationId: string, query: ExportQuery): Promise<Readable> {
    const zone = this.organizations.getTimezone();
    const { from, to } = this.range(query, zone);

    const [payments, manualPayments, refunds] = await Promise.all([
      this.prisma.payment.findMany({
        where: { organizationId, paidAt: { gte: from, lt: to } },
        select: {
          id: true,
          amountCents: true,
          currency: true,
          status: true,
          paymentMethodType: true,
          paidAt: true,
          booking: { select: { reference: true, serviceNameSnapshot: true } },
        },
      }),
      this.prisma.manualPayment.findMany({
        where: { organizationId, paidAt: { gte: from, lt: to } },
        select: {
          id: true,
          amountCents: true,
          currency: true,
          method: true,
          paidAt: true,
          note: true,
          booking: { select: { reference: true, serviceNameSnapshot: true } },
        },
      }),
      this.prisma.refund.findMany({
        where: { organizationId, requestedAt: { gte: from, lt: to } },
        select: {
          id: true,
          amountCents: true,
          currency: true,
          status: true,
          reason: true,
          requestedAt: true,
          settledAt: true,
          booking: { select: { reference: true, serviceNameSnapshot: true } },
        },
      }),
    ]);

    const entries = [
      ...payments.map((payment) => ({
        at: payment.paidAt ?? new Date(0),
        cells: [
          'STRIPE',
          payment.id,
          payment.booking.reference,
          payment.booking.serviceNameSnapshot,
          csvInstant(payment.paidAt, zone),
          csvAmount(payment.amountCents),
          payment.currency,
          payment.status,
          payment.paymentMethodType,
          '',
        ],
      })),
      ...manualPayments.map((payment) => ({
        at: payment.paidAt,
        cells: [
          'MANUAL',
          payment.id,
          payment.booking.reference,
          payment.booking.serviceNameSnapshot,
          csvInstant(payment.paidAt, zone),
          csvAmount(payment.amountCents),
          payment.currency,
          'RECORDED',
          payment.method,
          payment.note,
        ],
      })),
      ...refunds.map((refund) => ({
        at: refund.settledAt ?? refund.requestedAt,
        cells: [
          'REFUND',
          refund.id,
          refund.booking.reference,
          refund.booking.serviceNameSnapshot,
          csvInstant(refund.settledAt ?? refund.requestedAt, zone),
          // Negative, because that is the direction the money went. A ledger whose
          // refunds are positive is one somebody will sum wrongly.
          csvAmount(-refund.amountCents),
          refund.currency,
          refund.status,
          refund.reason,
          '',
        ],
      })),
    ].sort((left, right) => left.at.getTime() - right.at.getTime());

    const header = [
      'kind',
      'id',
      'bookingReference',
      'service',
      'occurredAt',
      'amountEur',
      'currency',
      'status',
      'method',
      'note',
    ];

    return Readable.from([
      CSV_BOM + csvLine(header),
      ...entries.map((entry) => csvLine(entry.cells)),
    ]);
  }

  /**
   * A local date range as an instant range, with the last day whole.
   *
   * Through the time primitives rather than by adding 86 400 000 milliseconds: a range
   * that crosses a DST boundary is 23 or 25 hours on one of its days, and an export that
   * silently dropped the last hour of October would be found by a bookkeeper, not a test.
   */
  private range(query: ExportQuery, zone: string): { from: Date; to: Date } {
    return {
      from: wallClockToInstantOrThrow(query.from, 0, zone),
      to: wallClockToInstantOrThrow(addLocalDays(query.to, 1, zone), 0, zone),
    };
  }

  /**
   * A stream that pulls the next page only when the consumer asks for it.
   *
   * `Readable.from` over an async generator gives backpressure for free: if the client
   * reads slowly, the generator is not resumed and the next query is not issued.
   */
  private stream(
    header: readonly string[],
    page: (cursor: string | null) => Promise<{ cursor: string | null; lines: string[] }>,
  ): Readable {
    return Readable.from(
      (async function* generate() {
        yield CSV_BOM + csvLine(header);

        let cursor: string | null = null;
        for (;;) {
          const result: { cursor: string | null; lines: string[] } = await page(cursor);
          for (const line of result.lines) yield line;

          if (result.lines.length < PAGE_SIZE || result.cursor === null) return;
          cursor = result.cursor;
        }
      })(),
    );
  }
}
