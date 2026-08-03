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

import type { Prisma } from '../prisma/client.js';
import type { ExportQuery } from '@shape-and-flow/booking-contracts';

/**
 * How many rows are fetched per round trip while streaming.
 *
 * Small enough that a year of bookings never sits in memory at once, large enough that a
 * normal month is one or two queries.
 */
const PAGE_SIZE = 500;

interface LedgerCursor {
  at: Date;
  id: string;
}

interface LedgerEntry extends LedgerCursor {
  kind: 'MANUAL' | 'REFUND' | 'STRIPE';
  cells: readonly (string | number | null | undefined)[];
}

interface CardLedgerRow {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  paymentMethodType: string | null;
  paidAt: Date | null;
  booking: { reference: string; serviceNameSnapshot: string };
}

interface ManualLedgerRow {
  id: string;
  amountCents: number;
  currency: string;
  method: string;
  paidAt: Date;
  note: string | null;
  booking: { reference: string; serviceNameSnapshot: string };
}

interface RefundLedgerRow {
  id: string;
  amountCents: number;
  currency: string;
  status: string;
  reason: string;
  requestedAt: Date;
  settledAt: Date | null;
  booking: { reference: string; serviceNameSnapshot: string };
}

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

  /** Every settled movement of money in the range, merged lazily from three pagers. */
  payments(organizationId: string, query: ExportQuery): Readable {
    const zone = this.organizations.getTimezone();
    const { from, to } = this.range(query, zone);

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

    const entries = mergeLedgerEntries([
      this.cardEntries(organizationId, from, to, zone),
      this.manualEntries(organizationId, from, to, zone),
      this.refundEntries(organizationId, from, to, zone, 'SETTLED'),
      this.refundEntries(organizationId, from, to, zone, 'PENDING'),
    ]);

    return Readable.from(
      (async function* generate() {
        yield CSV_BOM + csvLine(header);
        for await (const entry of entries) yield csvLine(entry.cells);
      })(),
    );
  }

  private async *cardEntries(
    organizationId: string,
    from: Date,
    to: Date,
    zone: string,
  ): AsyncGenerator<LedgerEntry> {
    let cursor: LedgerCursor | null = null;

    for (;;) {
      const rows: CardLedgerRow[] = await this.prisma.payment.findMany({
        where: {
          organizationId,
          paidAt: { gte: from, lt: to },
          ...(cursor === null
            ? {}
            : {
                OR: [{ paidAt: { gt: cursor.at } }, { paidAt: cursor.at, id: { gt: cursor.id } }],
              }),
        },
        select: {
          id: true,
          amountCents: true,
          currency: true,
          status: true,
          paymentMethodType: true,
          paidAt: true,
          booking: { select: { reference: true, serviceNameSnapshot: true } },
        },
        orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
        take: PAGE_SIZE,
      });

      for (const payment of rows) {
        if (payment.paidAt === null) continue;
        yield {
          kind: 'STRIPE',
          id: payment.id,
          at: payment.paidAt,
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
        };
      }

      if (rows.length < PAGE_SIZE) return;
      const last = rows.at(-1);
      if (last?.paidAt === null || last === undefined) return;
      cursor = { at: last.paidAt, id: last.id };
    }
  }

  private async *manualEntries(
    organizationId: string,
    from: Date,
    to: Date,
    zone: string,
  ): AsyncGenerator<LedgerEntry> {
    let cursor: LedgerCursor | null = null;

    for (;;) {
      const rows: ManualLedgerRow[] = await this.prisma.manualPayment.findMany({
        where: {
          organizationId,
          paidAt: { gte: from, lt: to },
          ...(cursor === null
            ? {}
            : {
                OR: [{ paidAt: { gt: cursor.at } }, { paidAt: cursor.at, id: { gt: cursor.id } }],
              }),
        },
        select: {
          id: true,
          amountCents: true,
          currency: true,
          method: true,
          paidAt: true,
          note: true,
          booking: { select: { reference: true, serviceNameSnapshot: true } },
        },
        orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
        take: PAGE_SIZE,
      });

      for (const payment of rows) {
        yield {
          kind: 'MANUAL',
          id: payment.id,
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
        };
      }

      if (rows.length < PAGE_SIZE) return;
      const last = rows.at(-1);
      if (last === undefined) return;
      cursor = { at: last.paidAt, id: last.id };
    }
  }

  private async *refundEntries(
    organizationId: string,
    from: Date,
    to: Date,
    zone: string,
    state: 'PENDING' | 'SETTLED',
  ): AsyncGenerator<LedgerEntry> {
    let cursor: LedgerCursor | null = null;

    for (;;) {
      let dateWhere: Prisma.RefundWhereInput;
      let orderBy: Prisma.RefundOrderByWithRelationInput[];

      if (state === 'SETTLED') {
        dateWhere = {
          status: 'SUCCEEDED',
          settledAt: { gte: from, lt: to },
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { settledAt: { gt: cursor.at } },
                  { settledAt: cursor.at, id: { gt: cursor.id } },
                ],
              }),
        };
        orderBy = [{ settledAt: 'asc' }, { id: 'asc' }];
      } else {
        dateWhere = {
          status: 'PENDING',
          requestedAt: { gte: from, lt: to },
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { requestedAt: { gt: cursor.at } },
                  { requestedAt: cursor.at, id: { gt: cursor.id } },
                ],
              }),
        };
        orderBy = [{ requestedAt: 'asc' }, { id: 'asc' }];
      }

      const rows: RefundLedgerRow[] = await this.prisma.refund.findMany({
        where: {
          organizationId,
          ...dateWhere,
        },
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
        orderBy,
        take: PAGE_SIZE,
      });

      for (const refund of rows) {
        const occurredAt =
          state === 'SETTLED' ? (refund.settledAt ?? refund.requestedAt) : refund.requestedAt;
        yield {
          kind: 'REFUND',
          id: refund.id,
          at: occurredAt,
          cells: [
            'REFUND',
            refund.id,
            refund.booking.reference,
            refund.booking.serviceNameSnapshot,
            csvInstant(occurredAt, zone),
            csvAmount(-refund.amountCents),
            refund.currency,
            refund.status,
            refund.reason,
            '',
          ],
        };
      }

      if (rows.length < PAGE_SIZE) return;
      const last = rows.at(-1);
      if (last === undefined) return;
      cursor = {
        at: state === 'SETTLED' ? (last.settledAt ?? last.requestedAt) : last.requestedAt,
        id: last.id,
      };
    }
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

/** Merge sorted sources while holding only one current row from each source. */
async function* mergeLedgerEntries(
  sources: readonly AsyncIterable<LedgerEntry>[],
): AsyncGenerator<LedgerEntry> {
  const iterators = sources.map((source) => source[Symbol.asyncIterator]());
  const heads: IteratorResult<LedgerEntry>[] = await Promise.all(
    iterators.map(async (iterator) => await iterator.next()),
  );

  try {
    for (;;) {
      let earliest = -1;
      let earliestEntry: LedgerEntry | null = null;

      for (const [index, head] of heads.entries()) {
        if (head.done === true) continue;
        if (earliestEntry === null || compareLedgerEntries(head.value, earliestEntry) < 0) {
          earliest = index;
          earliestEntry = head.value;
        }
      }

      if (earliest === -1 || earliestEntry === null) return;
      yield earliestEntry;

      const iterator = iterators[earliest];
      if (iterator === undefined) return;
      heads[earliest] = await iterator.next();
    }
  } finally {
    await Promise.all(iterators.map(async (iterator) => await iterator.return?.()));
  }
}

function compareLedgerEntries(left: LedgerEntry, right: LedgerEntry): number {
  return (
    left.at.getTime() - right.at.getTime() ||
    left.id.localeCompare(right.id) ||
    left.kind.localeCompare(right.kind)
  );
}
