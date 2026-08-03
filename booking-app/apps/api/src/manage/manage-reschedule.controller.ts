import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { manageRescheduleRequestSchema } from '@shape-and-flow/booking-contracts';

import { RescheduleService } from '../booking/reschedule.service.js';

import { ManagedBooking, ManagementToken } from './management-token.guard.js';

import type { ResolvedToken } from './management-token.service.js';
import type { ManageRescheduleResponse } from '@shape-and-flow/booking-contracts';

const MANAGE_LIMIT = { default: { limit: 30, ttl: 60_000 } };

/**
 * `POST /manage/reschedule-requests`.
 *
 * Always `202`: asking to move an appointment never moves it. The office decides, and
 * until then the customer keeps the appointment they have — which is also why the
 * response says nothing about the new time being confirmed.
 */
@Controller('manage')
@ManagementToken()
@Throttle(MANAGE_LIMIT)
export class ManageRescheduleController {
  constructor(private readonly reschedules: RescheduleService) {}

  @Post('reschedule-requests')
  @HttpCode(202)
  async create(
    @ManagedBooking() managed: ResolvedToken,
    @Body() rawBody: unknown,
  ): Promise<ManageRescheduleResponse> {
    const body = manageRescheduleRequestSchema.parse(rawBody);

    const { requestId } = await this.reschedules.requestByCustomer({
      // From the token, never from the body.
      bookingId: managed.bookingId,
      requestedStartsAt: new Date(body.requestedStartsAt),
      ...(body.requestedEmployeeId === undefined
        ? {}
        : { requestedEmployeeId: body.requestedEmployeeId }),
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });

    return { requestId, requestedStartsAt: body.requestedStartsAt };
  }
}
