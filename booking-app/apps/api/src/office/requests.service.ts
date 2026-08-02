import { Injectable } from '@nestjs/common';

import { EmployeeScopeService } from '../auth/employee-scope.service.js';
import { AppError } from '../common/errors/app-error.js';
import {
  BookingFinancialsService,
  emptyFinancials,
} from '../payment/booking-financials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { receivedFrom } from './received.js';

import type { OfficeSession } from '../auth/session.store.js';
import type { BookingFinancials } from '../payment/booking-financials.service.js';
import type {
  CancellationRequestListResponse,
  OfficeCancellationRequest,
  OfficeRescheduleRequest,
  RequestListQuery,
  RescheduleRequestListResponse,
} from '@shape-and-flow/booking-contracts';

/** Enough of the booking to decide a request without opening it. */
const REQUEST_BOOKING = {
  id: true,
  reference: true,
  startsAt: true,
  employeeId: true,
  serviceNameSnapshot: true,
  priceCentsSnapshot: true,
  currency: true,
  customer: { select: { firstName: true, lastName: true } },
} as const;

/**
 * Reading the two request queues.
 *
 * Deciding them belongs to the Stage 6 services; this is the list beside the decision,
 * plus the row-level scoping the decorators cannot express. `paid` is carried on every
 * row because the person deciding a cancellation needs to know what came in before they
 * choose what to keep — and asking them to open the booking to find out is how the wrong
 * number gets typed.
 */
@Injectable()
export class RequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: EmployeeScopeService,
    private readonly financials: BookingFinancialsService,
  ) {}

  async listCancellations(
    session: OfficeSession,
    query: RequestListQuery,
  ): Promise<CancellationRequestListResponse> {
    const rows = await this.prisma.cancellationRequest.findMany({
      where: {
        organizationId: session.organizationId,
        decision: query.decision,
        booking: this.scope.employeeFilter(session),
      },
      include: { booking: { select: REQUEST_BOOKING } },
      orderBy: { requestedAt: 'asc' },
      take: query.limit,
    });

    const financials = await this.financials.loadMany(rows.map((row) => row.booking.id));

    return {
      items: rows.map((row): OfficeCancellationRequest => ({
        id: row.id,
        booking: toRequestBooking(row.booking, financials.get(row.booking.id)),
        reason: row.reason,
        requestedAt: row.requestedAt.toISOString(),
        decision: row.decision,
        suggestedRetainedAmountCents: row.suggestedRetainedAmountCents,
        retainedAmountCents: row.retainedAmountCents,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decisionNote: row.decisionNote,
      })),
    };
  }

  async listReschedules(
    session: OfficeSession,
    query: RequestListQuery,
  ): Promise<RescheduleRequestListResponse> {
    const rows = await this.prisma.rescheduleRequest.findMany({
      where: {
        organizationId: session.organizationId,
        decision: query.decision,
        // An employee sees requests against their own bookings and no others, which is
        // §6.5's "Employee sees only its own bookings' requests".
        booking: this.scope.employeeFilter(session),
      },
      include: { booking: { select: REQUEST_BOOKING } },
      orderBy: { requestedAt: 'asc' },
      take: query.limit,
    });

    const financials = await this.financials.loadMany(rows.map((row) => row.booking.id));

    return {
      items: rows.map((row): OfficeRescheduleRequest => ({
        id: row.id,
        booking: toRequestBooking(row.booking, financials.get(row.booking.id)),
        requestedStartsAt: row.requestedStartsAt.toISOString(),
        requestedEmployeeId: row.requestedEmployeeId,
        reason: row.reason,
        requestedAt: row.requestedAt.toISOString(),
        decision: row.decision,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decisionNote: row.decisionNote,
        resultingBookingId: row.resultingBookingId,
      })),
    };
  }

  /**
   * The request is this tenant's and this session may decide it.
   *
   * Returns what the customer has paid, which the caller needs in order to know whether
   * the decision moves money — and therefore whether it needs the refund capability.
   */
  async assertCancellationReachable(session: OfficeSession, id: string): Promise<number> {
    const request = await this.prisma.cancellationRequest.findFirst({
      where: { id, organizationId: session.organizationId },
      select: { booking: { select: { id: true, employeeId: true, currency: true } } },
    });

    if (request === null) throw notFound('Cancellation request not found.');
    this.scope.assertMayAccessEmployee(session, request.booking.employeeId);

    const financials = await this.financials.load(request.booking.id);

    return receivedFrom(financials, request.booking.currency).amountCents;
  }

  async assertRescheduleReachable(session: OfficeSession, id: string): Promise<void> {
    const request = await this.prisma.rescheduleRequest.findFirst({
      where: { id, organizationId: session.organizationId },
      select: { booking: { select: { employeeId: true } } },
    });

    if (request === null) throw notFound('Reschedule request not found.');
    this.scope.assertMayAccessEmployee(session, request.booking.employeeId);
  }
}

function toRequestBooking(
  booking: {
    id: string;
    reference: string;
    startsAt: Date;
    employeeId: string;
    serviceNameSnapshot: string;
    priceCentsSnapshot: number;
    currency: string;
    customer: { firstName: string; lastName: string };
  },
  financials: BookingFinancials | undefined,
): OfficeCancellationRequest['booking'] {
  return {
    id: booking.id,
    reference: booking.reference,
    startsAt: booking.startsAt.toISOString(),
    employeeId: booking.employeeId,
    serviceName: booking.serviceNameSnapshot,
    customerName: `${booking.customer.firstName} ${booking.customer.lastName}`,
    price: { amountCents: booking.priceCentsSnapshot, currency: booking.currency },
    paid: receivedFrom(financials ?? emptyFinancials(booking.id), booking.currency).toJSON(),
  };
}

function notFound(message: string): AppError {
  return new AppError('NOT_FOUND', { message });
}
