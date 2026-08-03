import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  cancelBookingSchema,
  createManualBookingSchema,
  createManualPaymentSchema,
  createRefundSchema,
  officeBookingListQuerySchema,
} from '@shape-and-flow/booking-contracts';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { CurrentUser, OfficeRoute, OfficeSessionGuard } from '../auth/office-session.guard.js';
import {
  RefundCapabilityGuard,
  RequiresRefundCapability,
  assertMayIssueRefunds,
} from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { AttendanceService } from '../booking/attendance.service.js';
import { CancellationService } from '../booking/cancellation.service.js';
import { Audited } from '../common/audit/audit.interceptor.js';
import { Idempotent } from '../messaging/idempotency/idempotent.decorator.js';
import { ManualPaymentService } from '../payment/manual-payment.service.js';
import { RefundService } from '../payment/refund.service.js';

import { OfficeBookingsService } from './office-bookings.service.js';

import type { OfficeSession } from '../auth/session.store.js';
import type {
  BookingManualPayment,
  CreateManualBookingResponse,
  OfficeBookingDetail,
  OfficeBookingListResponse,
  RefundListResponse,
} from '@shape-and-flow/booking-contracts';

/**
 * `/office/bookings`.
 *
 * Every write here delegates: cancellation to `CancellationService`, completion and
 * no-show to `AttendanceService`, refunds to `RefundService`, creation to
 * `ReservationService` through the office service. What is left in this file is the
 * decision about *who may* — which is the controller's actual job.
 *
 * Every route that creates a booking or moves money carries `@Idempotent`. A retried
 * request at a busy desk is not a
 * hypothetical, and each of these has a failure mode that costs real money: two
 * bookings, two recorded payments, two refunds.
 */
@Controller('office/bookings')
@OfficeRoute()
@UseGuards(OfficeSessionGuard, CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
export class OfficeBookingsController {
  constructor(
    private readonly bookings: OfficeBookingsService,
    private readonly cancellations: CancellationService,
    private readonly attendance: AttendanceService,
    private readonly manualPayments: ManualPaymentService,
    private readonly refundService: RefundService,
  ) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  async list(
    @CurrentUser() session: OfficeSession,
    @Query() rawQuery: unknown,
  ): Promise<OfficeBookingListResponse> {
    return await this.bookings.list(session, officeBookingListQuerySchema.parse(rawQuery));
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  async detail(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
  ): Promise<OfficeBookingDetail> {
    return await this.bookings.detail(session, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  @Idempotent('booking.create')
  @Audited({ action: 'BOOKING_CREATED_MANUALLY', entityType: 'Booking' })
  async create(
    @CurrentUser() session: OfficeSession,
    @Body() body: unknown,
  ): Promise<CreateManualBookingResponse> {
    return await this.bookings.createManual(session, createManualBookingSchema.parse(body));
  }

  /**
   * Cancel on the business's behalf.
   *
   * The refund capability is checked here rather than by the guard, because it is only
   * required when the cancellation actually returns money — an admin who may not issue
   * refunds may still cancel an appointment.
   */
  @Post(':id/cancel')
  @Roles('OWNER', 'ADMIN')
  @Idempotent('booking.cancel')
  @Audited({ action: 'BOOKING_CANCELED', entityType: 'Booking' })
  async cancel(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ bookingId: string; refundId: string | null }> {
    const input = cancelBookingSchema.parse(body);
    await this.bookings.assertReachable(session, id);

    if (input.refund !== undefined && input.refund.amountCents > 0) {
      assertMayIssueRefunds(session);
    }

    const { refundId } = await this.cancellations.cancelByBusiness({
      bookingId: id,
      officeUserId: session.officeUserId,
      reason: input.reason,
      ...(input.refund === undefined ? {} : { refundAmountCents: input.refund.amountCents }),
    });

    return { bookingId: id, refundId };
  }

  @Post(':id/complete')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  @Audited({ action: 'BOOKING_MARKED_COMPLETED', entityType: 'Booking' })
  async complete(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
  ): Promise<{ bookingId: string }> {
    // Scoped before the service runs: an employee reaching a colleague's booking gets a
    // 404, and the service is not the place that knows about sessions.
    await this.bookings.assertReachable(session, id);
    await this.attendance.complete(id, session.officeUserId);

    return { bookingId: id };
  }

  @Post(':id/no-show')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  @Audited({ action: 'BOOKING_MARKED_NO_SHOW', entityType: 'Booking' })
  async noShow(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
  ): Promise<{ bookingId: string }> {
    await this.bookings.assertReachable(session, id);
    await this.attendance.markNoShow(id, session.officeUserId);

    return { bookingId: id };
  }

  @Post(':id/manual-payments')
  @Roles('OWNER', 'ADMIN')
  // No `@Audited`: ManualPaymentService writes its row inside the transaction that
  // records the payment, which is where an audit row for money belongs.
  @Idempotent('manual-payment.create')
  async recordManualPayment(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BookingManualPayment> {
    return await this.manualPayments.record(
      id,
      session.officeUserId,
      createManualPaymentSchema.parse(body),
    );
  }

  @Get(':id/refunds')
  @Roles('OWNER', 'ADMIN')
  async listRefunds(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
  ): Promise<RefundListResponse> {
    return await this.bookings.refunds(session, id);
  }

  @Post(':id/refunds')
  @Roles('OWNER', 'ADMIN')
  @RequiresRefundCapability()
  @Idempotent('refund.create')
  @Audited({ action: 'REFUND_ISSUED', entityType: 'Refund' })
  async issueRefund(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ refundId: string }> {
    const input = createRefundSchema.parse(body);
    await this.bookings.assertReachable(session, id);

    return await this.refundService.request({
      bookingId: id,
      amountCents: input.amountCents,
      reason: input.reason,
      officeUserId: session.officeUserId,
    });
  }
}
