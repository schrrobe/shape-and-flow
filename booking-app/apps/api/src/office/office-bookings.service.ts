import { Injectable } from '@nestjs/common';

import { EmployeeScopeService } from '../auth/employee-scope.service.js';
import { ReservationService } from '../booking/reservation.service.js';
import { AppError } from '../common/errors/app-error.js';
import { addLocalDays, wallClockToInstantOrThrow } from '../domain/time/local-time.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import {
  BookingFinancialsService,
  emptyFinancials,
} from '../payment/booking-financials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { decodeCursor, keysetOrderBy, keysetWhere, toPage } from './cursor.js';
import { deriveDisplayStatus } from './display-status.js';
import { receivedFrom } from './received.js';

import type { OfficeSession } from '../auth/session.store.js';
import type { CustomerInput } from '../booking/customer-upsert.service.js';
import type { LocalDate } from '../domain/time/local-time.js';
import type { BookingFinancials } from '../payment/booking-financials.service.js';
import type { Prisma } from '../prisma/client.js';
import type {
  CreateManualBookingRequest,
  CreateManualBookingResponse,
  OfficeBookingDetail,
  OfficeBookingListQuery,
  OfficeBookingListResponse,
  RefundListResponse,
} from '@shape-and-flow/booking-contracts';

/**
 * What a list row needs.
 *
 * No financial relations. A reschedule leaves the payment on the booking that was paid,
 * so `booking.payments` on a replacement is empty and every row in a chain but the first
 * reported nothing received. The money comes from `BookingFinancialsService`, which
 * resolves the chain's root once for the whole page.
 */
const LIST_FIELDS = {
  id: true,
  reference: true,
  status: true,
  origin: true,
  startsAt: true,
  endsAt: true,
  employeeId: true,
  serviceNameSnapshot: true,
  priceCentsSnapshot: true,
  currency: true,
  createdAt: true,
  customerId: true,
  employee: { select: { displayName: true } },
  customer: { select: { firstName: true, lastName: true } },
  cancellationRequests: { where: { decision: 'PENDING' as const }, select: { id: true } },
  rescheduleRequests: { where: { decision: 'PENDING' as const }, select: { id: true } },
} as const satisfies Prisma.BookingSelect;

/**
 * The detail select, declared rather than spread inline.
 *
 * `satisfies` is doing real work here. Spreading `LIST_FIELDS` into an inline `select`
 * turns off TypeScript's excess-property check for the whole literal, and two invented
 * column names — `internalNote` on Booking, `failureReason` on Notification — reached
 * PostgreSQL before a test caught them. A named constant with `satisfies` keeps the
 * exact literal type that `GetPayload` needs *and* checks every key against the model.
 */
const DETAIL_FIELDS = {
  ...LIST_FIELDS,
  serviceId: true,
  blockStartsAt: true,
  blockEndsAt: true,
  durationMinutesSnapshot: true,
  prepBufferMinutesSnapshot: true,
  cleanupBufferMinutesSnapshot: true,
  locale: true,
  customerNote: true,
  canceledByOfficeUserId: true,
  cancellationReason: true,
  confirmedAt: true,
  canceledAt: true,
  completedAt: true,
  expiresAt: true,
  createdByOfficeUserId: true,
  customer: {
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  },
  statusHistory: { orderBy: { createdAt: 'asc' as const } },
  notifications: {
    select: {
      id: true,
      kind: true,
      channel: true,
      status: true,
      sentAt: true,
      // `lastError`, not `failureReason` — the latter is Refund's column, and the two
      // were confused until PostgreSQL said so.
      lastError: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
  cancellationRequests: {
    where: { decision: 'PENDING' as const },
    orderBy: { requestedAt: 'desc' as const },
  },
  rescheduleRequests: {
    where: { decision: 'PENDING' as const },
    orderBy: { requestedAt: 'desc' as const },
  },
} as const satisfies Prisma.BookingSelect;

/**
 * The office's view of bookings, and the one write that creates them.
 *
 * **Creation goes through `ReservationService`**, not through an insert of its own. The
 * two paths differ in exactly one rule — an office booking may ignore the minimum-notice
 * window — and that difference is expressed as an actor passed *into* the shared path.
 * A second insert here would be a second answer to "may this slot be taken", and the two
 * would drift the first time somebody changed one.
 *
 * Every status change delegates to the Stage 6 services for the same reason: the fee
 * window, the refund arithmetic and the status machine already live somewhere, and a
 * controller that reimplemented any of them would be a second policy nobody knew about.
 */
@Injectable()
export class OfficeBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly scope: EmployeeScopeService,
    private readonly reservations: ReservationService,
    private readonly financials: BookingFinancialsService,
  ) {}

  /* ── reading ────────────────────────────────────────────────────────────────── */

  async list(
    session: OfficeSession,
    query: OfficeBookingListQuery,
  ): Promise<OfficeBookingListResponse> {
    if (query.employeeId !== undefined) {
      this.scope.assertMayAccessEmployee(session, query.employeeId);
    }

    const [field, direction] = splitSort(query.sort);
    const zone = this.organizations.getTimezone();

    const rows = await this.prisma.booking.findMany({
      where: {
        organizationId: session.organizationId,
        ...(query.employeeId === undefined
          ? this.scope.employeeFilter(session)
          : { employeeId: query.employeeId }),
        ...(query.status === undefined ? {} : { status: { in: query.status } }),
        ...(query.serviceId === undefined ? {} : { serviceId: query.serviceId }),
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        ...this.dateRange(query.from, query.to, zone),
        AND: [
          search(query.q),
          ...(query.cursor === undefined
            ? []
            : [keysetWhere(field, direction, decodeCursor(query.cursor))]),
        ],
      },
      select: LIST_FIELDS,
      orderBy: keysetOrderBy(field, direction),
      // One more than asked for, which is how `nextCursor` knows there is a next page
      // without a second count query that would answer about a moment already gone.
      take: query.limit + 1,
    });

    const page = toPage(rows, query.limit, (row) =>
      (field === 'startsAt' ? row.startsAt : row.createdAt).toISOString(),
    );

    // One batched read for the whole page, not one per row: a page of fifty costs three
    // queries however many reschedule chains it contains.
    const financials = await this.financials.loadMany(page.items.map((row) => row.id));

    return {
      items: page.items.map((row) =>
        toListItem(row, financials.get(row.id) ?? emptyFinancials(row.id)),
      ),
      nextCursor: page.nextCursor,
    };
  }

  async detail(session: OfficeSession, id: string): Promise<OfficeBookingDetail> {
    const booking = await this.prisma.booking.findFirst({
      where: { id, organizationId: session.organizationId },
      select: DETAIL_FIELDS,
    });

    if (booking === null) throw notFound();
    // Row-level scoping, after the read: an employee reaching a colleague's booking gets
    // the same 404 as one reaching another organization's.
    this.scope.assertMayAccessEmployee(session, booking.employeeId);

    const openCancellation = booking.cancellationRequests[0];
    const openReschedule = booking.rescheduleRequests[0];
    const financials = await this.financials.load(booking.id);

    return {
      // The detail select is a superset of the list one, so the same mapper produces the
      // same fields — which is what stops a list row and a detail row disagreeing about
      // what a booking's `paid` figure is.
      ...toListItem(booking, financials),
      serviceId: booking.serviceId,
      blockStartsAt: booking.blockStartsAt.toISOString(),
      blockEndsAt: booking.blockEndsAt.toISOString(),
      durationMinutes: booking.durationMinutesSnapshot,
      prepBufferMinutes: booking.prepBufferMinutesSnapshot,
      cleanupBufferMinutes: booking.cleanupBufferMinutesSnapshot,
      locale: booking.locale,
      customerNote: booking.customerNote,
      canceledByOfficeUserId: booking.canceledByOfficeUserId,
      cancellationReason: booking.cancellationReason,
      confirmedAt: booking.confirmedAt?.toISOString() ?? null,
      canceledAt: booking.canceledAt?.toISOString() ?? null,
      completedAt: booking.completedAt?.toISOString() ?? null,
      expiresAt: booking.expiresAt?.toISOString() ?? null,
      createdByOfficeUserId: booking.createdByOfficeUserId,
      customer: {
        id: booking.customer.id,
        firstName: booking.customer.firstName,
        lastName: booking.customer.lastName,
        email: booking.customer.email,
        phone: booking.customer.phone,
      },
      payments: financials.payments.map((payment) => ({
        id: payment.id,
        amount: { amountCents: payment.amountCents, currency: payment.currency },
        status: payment.status,
        paymentMethodType: payment.paymentMethodType,
        refundedAmountCents: payment.refundedAmountCents,
        paidAt: payment.paidAt?.toISOString() ?? null,
      })),
      manualPayments: financials.manualPayments.map((payment) => ({
        id: payment.id,
        amount: { amountCents: payment.amountCents, currency: payment.currency },
        method: payment.method,
        paidAt: payment.paidAt.toISOString(),
        recordedByOfficeUserId: payment.recordedByOfficeUserId,
        note: payment.note,
      })),
      refunds: financials.refunds.map(toRefundDto),
      statusHistory: booking.statusHistory.map((entry) => ({
        id: entry.id,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        actorType: entry.actorType,
        actorOfficeUserId: entry.actorOfficeUserId,
        reason: entry.reason,
        createdAt: entry.createdAt.toISOString(),
      })),
      notifications: booking.notifications.map((notification) => ({
        id: notification.id,
        kind: notification.kind,
        channel: notification.channel,
        status: notification.status,
        sentAt: notification.sentAt?.toISOString() ?? null,
        failureReason: notification.lastError,
      })),
      openCancellationRequest:
        openCancellation === undefined
          ? null
          : {
              id: openCancellation.id,
              reason: openCancellation.reason,
              requestedAt: openCancellation.requestedAt.toISOString(),
              suggestedRetainedAmountCents: openCancellation.suggestedRetainedAmountCents,
            },
      openRescheduleRequest:
        openReschedule === undefined
          ? null
          : {
              id: openReschedule.id,
              requestedStartsAt: openReschedule.requestedStartsAt.toISOString(),
              requestedEmployeeId: openReschedule.requestedEmployeeId,
              reason: openReschedule.reason,
              requestedAt: openReschedule.requestedAt.toISOString(),
            },
    };
  }

  async refunds(session: OfficeSession, bookingId: string): Promise<RefundListResponse> {
    await this.assertReachable(session, bookingId);

    // Through the chain's root, so a refund issued before a reschedule is still listed
    // against the appointment the office is looking at.
    const { refunds } = await this.financials.load(bookingId);

    return { items: refunds.map(toRefundDto) };
  }

  /* ── creating ───────────────────────────────────────────────────────────────── */

  /**
   * A booking taken at the desk or on the phone.
   *
   * Straight to CONFIRMED with no payment and no Checkout Session: the office is not
   * going to send a customer standing in front of them to a payment page. What they owe
   * is recorded afterwards as a manual payment, or not at all if they have a voucher.
   */
  async createManual(
    session: OfficeSession,
    input: CreateManualBookingRequest,
  ): Promise<CreateManualBookingResponse> {
    const organizationId = session.organizationId;
    const customer = await this.resolveCustomer(organizationId, input.customer);

    const result = await this.reservations.reserve({
      serviceId: input.serviceId,
      employeeId: input.employeeId,
      startsAt: new Date(input.startsAt),
      customer,
      locale: customer.locale,
      ...(input.customerNote === undefined ? {} : { customerNote: input.customerNote }),
      actor: { type: 'OFFICE', officeUserId: session.officeUserId },
    });

    return {
      bookingId: result.booking.id,
      reference: result.booking.reference,
      status: result.booking.status,
      startsAt: result.booking.startsAt.toISOString(),
      endsAt: result.booking.endsAt.toISOString(),
      employeeId: result.booking.employeeId,
      price: result.price.toJSON(),
    };
  }

  /* ── internals ──────────────────────────────────────────────────────────────── */

  /** The booking exists, belongs to this tenant, and this session may touch it. */
  async assertReachable(session: OfficeSession, bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, organizationId: session.organizationId },
      select: { employeeId: true },
    });

    if (booking === null) throw notFound();
    this.scope.assertMayAccessEmployee(session, booking.employeeId);
  }

  /**
   * An existing customer, or the fields to upsert one.
   *
   * A named `customerId` is read back rather than trusted, so an office booking cannot
   * be attached to another organization's customer by id.
   */
  private async resolveCustomer(
    organizationId: string,
    input: CreateManualBookingRequest['customer'],
  ): Promise<CustomerInput> {
    const fallbackLocale = this.organizations.get().defaultLocale;

    if (!('customerId' in input)) return { ...input, locale: input.locale ?? fallbackLocale };

    const customer = await this.prisma.customer.findFirst({
      where: { id: input.customerId, organizationId },
      select: { email: true, firstName: true, lastName: true, phone: true, locale: true },
    });

    if (customer === null) throw new AppError('NOT_FOUND', { message: 'Customer not found.' });

    return {
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
      ...(customer.phone === null ? {} : { phone: customer.phone }),
      locale: customer.locale,
    };
  }

  /**
   * A local date range as an instant range.
   *
   * Filtered on `startsAt`, which is what an office means by "bookings in August" — not
   * when the row was created. Resolved through the time primitives, so the last day of
   * the range is whole however many hours it has.
   */
  private dateRange(
    from: LocalDate | undefined,
    to: LocalDate | undefined,
    zone: string,
  ): Prisma.BookingWhereInput {
    if (from === undefined && to === undefined) return {};

    return {
      startsAt: {
        ...(from === undefined ? {} : { gte: wallClockToInstantOrThrow(from, 0, zone) }),
        ...(to === undefined
          ? {}
          : { lt: wallClockToInstantOrThrow(addLocalDays(to, 1, zone), 0, zone) }),
      },
    };
  }
}

/**
 * Free-text search over the three things an office actually types.
 *
 * A reference read off a customer's email, a surname, or the address they booked with.
 * Not a full-text index: this is a handful of `ILIKE`s over indexed columns for a
 * business with thousands of bookings, and reaching for `tsvector` here would be
 * infrastructure in place of a feature.
 */
function search(q: string | undefined): Prisma.BookingWhereInput {
  if (q === undefined) return {};

  return {
    OR: [
      { reference: { contains: q, mode: 'insensitive' } },
      { customer: { lastName: { contains: q, mode: 'insensitive' } } },
      { customer: { firstName: { contains: q, mode: 'insensitive' } } },
      { customer: { emailNormalized: { contains: q.toLowerCase() } } },
    ],
  };
}

function splitSort(sort: string): ['startsAt' | 'createdAt', 'asc' | 'desc'] {
  const [field, direction] = sort.split(':');

  return [field === 'createdAt' ? 'createdAt' : 'startsAt', direction === 'asc' ? 'asc' : 'desc'];
}

/**
 * Derived from the select rather than written out.
 *
 * A hand-written union got `CANCELED` where the schema has `CANCELED_BY_CUSTOMER` and
 * `CANCELED_BY_BUSINESS`, which typechecked against itself and would have been wrong
 * only at the boundary. `GetPayload` cannot drift from the query it describes.
 */
type ListRow = Prisma.BookingGetPayload<{ select: typeof LIST_FIELDS }>;

function toListItem(row: ListRow, financials: BookingFinancials) {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    displayStatus: deriveDisplayStatus(row, {
      cancellation: row.cancellationRequests.length > 0,
      reschedule: row.rescheduleRequests.length > 0,
    }),
    origin: row.origin,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    employeeId: row.employeeId,
    employeeName: row.employee.displayName,
    serviceName: row.serviceNameSnapshot,
    customerId: row.customerId,
    customerName: `${row.customer.firstName} ${row.customer.lastName}`,
    price: { amountCents: row.priceCentsSnapshot, currency: row.currency },
    paid: receivedFrom(financials, row.currency).toJSON(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toRefundDto(refund: {
  id: string;
  amountCents: number;
  currency: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  reason: 'CUSTOMER_CANCELLATION' | 'BUSINESS_CANCELLATION' | 'GOODWILL' | 'DUPLICATE_PAYMENT';
  issuedByOfficeUserId: string | null;
  failureReason: string | null;
  requestedAt: Date;
  settledAt: Date | null;
}) {
  return {
    id: refund.id,
    amount: { amountCents: refund.amountCents, currency: refund.currency },
    status: refund.status,
    reason: refund.reason,
    issuedByOfficeUserId: refund.issuedByOfficeUserId,
    failureReason: refund.failureReason,
    requestedAt: refund.requestedAt.toISOString(),
    settledAt: refund.settledAt?.toISOString() ?? null,
  };
}

function notFound(): AppError {
  return new AppError('NOT_FOUND', { message: 'Booking not found.' });
}
