import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  decideCancellationSchema,
  decideRescheduleSchema,
  requestListQuerySchema,
} from '@shape-and-flow/booking-contracts';

import { CsrfHeaderGuard } from '../auth/csrf-header.guard.js';
import { CurrentUser, OfficeRoute } from '../auth/office-session.guard.js';
import { RefundCapabilityGuard } from '../auth/refund-capability.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CancellationService } from '../booking/cancellation.service.js';
import { RescheduleService } from '../booking/reschedule.service.js';

import { RequestsService } from './requests.service.js';

import type { OfficeSession } from '../auth/session.store.js';
import type {
  CancellationRequestListResponse,
  RescheduleRequestListResponse,
} from '@shape-and-flow/booking-contracts';

/**
 * What customers have asked for, and what the office decides.
 *
 * The role split is not symmetric, and follows §6.5. **Cancellation** is `OWNER` and
 * `ADMIN` only, because deciding it means deciding how much money to keep.
 * **Reschedule** includes `EMPLOYEE`, because moving one's own appointment is scheduling
 * rather than finance — scoped to their own bookings, in the service.
 *
 * Both decisions delegate to the Stage 6 services, which hold the parts that are easy to
 * get wrong: the frozen retention suggestion, and the dual advisory lock an approved
 * reschedule needs to release one slot and take another atomically.
 */
@Controller('office')
@UseGuards(CsrfHeaderGuard, RolesGuard, RefundCapabilityGuard)
@OfficeRoute()
export class RequestsController {
  constructor(
    private readonly requests: RequestsService,
    private readonly cancellations: CancellationService,
    private readonly reschedules: RescheduleService,
  ) {}

  @Get('cancellation-requests')
  @Roles('OWNER', 'ADMIN')
  async listCancellations(
    @CurrentUser() session: OfficeSession,
    @Query() rawQuery: unknown,
  ): Promise<CancellationRequestListResponse> {
    return await this.requests.listCancellations(session, requestListQuerySchema.parse(rawQuery));
  }

  /**
   * Decide a cancellation request.
   *
   * Retaining **less** than the customer paid means money goes back, so that — and only
   * that — needs the refund capability. Retaining everything is a decision an admin
   * without it may still make.
   */
  @Post('cancellation-requests/:id/decide')
  @Roles('OWNER', 'ADMIN')
  // No `@Audited`: CancellationService writes its row inside the decision transaction,
  // where it can also name the retained amount. A second row here duplicated every
  // decision in the log.
  async decideCancellation(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ requestId: string }> {
    const input = decideCancellationSchema.parse(body);
    await this.requests.assertCancellationReachable(session, id);

    // The capability is checked inside the decision transaction, against the amount the
    // reservation actually moves. Deciding it here meant comparing an omitted retained
    // amount — which means "accept the frozen suggestion" — against the paid total as
    // if it were zero, so approving the suggestion in full was refused as a refund.
    await this.cancellations.decideRequest({
      requestId: id,
      officeUserId: session.officeUserId,
      decision: input.decision,
      // The same rule `assertMayIssueRefunds` applies: an owner always may.
      mayIssueRefunds: session.role === 'OWNER' || session.canIssueRefunds,
      ...(input.retainedAmountCents === undefined
        ? {}
        : { retainedAmountCents: input.retainedAmountCents }),
      ...(input.note === undefined ? {} : { note: input.note }),
    });

    return { requestId: id };
  }

  @Get('reschedule-requests')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  async listReschedules(
    @CurrentUser() session: OfficeSession,
    @Query() rawQuery: unknown,
  ): Promise<RescheduleRequestListResponse> {
    return await this.requests.listReschedules(session, requestListQuerySchema.parse(rawQuery));
  }

  @Post('reschedule-requests/:id/decide')
  @Roles('OWNER', 'ADMIN', 'EMPLOYEE')
  // No `@Audited`: RescheduleService writes its row inside the decision transaction,
  // where it can also name the replacement booking.
  async decideReschedule(
    @CurrentUser() session: OfficeSession,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ requestId: string; newBookingId: string | null }> {
    const input = decideRescheduleSchema.parse(body);
    await this.requests.assertRescheduleReachable(session, id);

    const { newBookingId } = await this.reschedules.decide({
      requestId: id,
      officeUserId: session.officeUserId,
      decision: input.decision,
      ...(input.note === undefined ? {} : { note: input.note }),
    });

    return { requestId: id, newBookingId };
  }
}
