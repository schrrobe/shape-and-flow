import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { manageCancelRequestSchema } from '@shape-and-flow/booking-contracts';

import { CancellationService } from '../booking/cancellation.service.js';

import { ManagedBooking, ManagementToken } from './management-token.guard.js';

import type { ResolvedToken } from './management-token.service.js';
import type { ManageCancelResponse } from '@shape-and-flow/booking-contracts';
import type { Response } from 'express';

/** Same limit as the rest of `/manage`: enough for a person, not for a script. */
const MANAGE_LIMIT = { default: { limit: 30, ttl: 60_000 } };

/**
 * `POST /manage/cancel`.
 *
 * Two outcomes with two status codes, because they mean different things to the caller.
 * `200` means it is done. `202` means somebody has to look at it — the appointment is
 * inside the fee window, so the office decides how much to retain, and until they do the
 * booking stands and the slot stays held.
 *
 * No booking id in the body. The token says which booking, which is what stops a valid
 * link cancelling someone else's appointment.
 */
@Controller('manage')
@ManagementToken()
@Throttle(MANAGE_LIMIT)
export class ManageCancelController {
  constructor(private readonly cancellations: CancellationService) {}

  @Post('cancel')
  // Declared as 200 and overridden to 202 for the request outcome. Nest needs a
  // declared code, and the interceptor stack reads it too.
  @HttpCode(200)
  async cancel(
    @ManagedBooking() managed: ResolvedToken,
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ManageCancelResponse> {
    const body = manageCancelRequestSchema.parse(rawBody ?? {});

    const result = await this.cancellations.cancelByCustomer(managed.bookingId, body.reason);

    if (result.outcome === 'CANCELED') {
      return {
        outcome: 'CANCELED',
        refundExpected: result.refundExpected.toJSON(),
        suggestedRetained: null,
      };
    }

    response.status(202);

    return {
      outcome: 'REQUESTED',
      refundExpected: null,
      suggestedRetained: result.suggestedRetained.toJSON(),
    };
  }
}
