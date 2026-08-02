import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';

import { Public } from '../common/guards/public.decorator.js';

import { TestSupportService } from './test-support.service.js';

import type { OutboxMessage, PendingWork } from './test-support.service.js';
import type { DemoSeedResult } from '../organization/demo-seed.js';

/**
 * `/api/test-support/*`.
 *
 * `@Public` and `@SkipThrottle` because the caller is a test runner, not a person:
 * there is no session to require, and a suite that resets between every test would
 * spend half its budget on 429s. Neither weakens anything, because the whole
 * controller only exists when ENABLE_TEST_SUPPORT is true — see
 * test-support.module.ts for what enforces that.
 */

const resetBody = z
  .object({
    ownerPassword: z.string().min(8).default('e2e-owner-password'),
    staffPassword: z.string().min(8).default('e2e-staff-password'),
  })
  .default({ ownerPassword: 'e2e-owner-password', staffPassword: 'e2e-staff-password' });

const stripeEventBody = z.object({
  type: z.string().min(1),
  sessionId: z.string().min(1),
  eventId: z.string().min(1).optional(),
});

@Controller('test-support')
@Public()
@SkipThrottle()
export class TestSupportController {
  constructor(private readonly support: TestSupportService) {}

  /** Truncate, reseed, clear the queues. Returns what the suite needs to log in. */
  @Post('reset')
  @HttpCode(200)
  async reset(@Body() body: unknown): Promise<DemoSeedResult> {
    return await this.support.reset(resetBody.parse(body ?? {}));
  }

  /** Mark a fake Checkout session paid. */
  @Post('checkout/:sessionId/pay')
  @HttpCode(200)
  async pay(@Param('sessionId') sessionId: string): Promise<{ chargeId: string }> {
    return await this.support.payCheckoutSession(sessionId);
  }

  /** The bytes and the signature for a synthetic Stripe event, to be POSTed on. */
  @Post('stripe-event')
  @HttpCode(200)
  async stripeEvent(
    @Body() body: unknown,
  ): Promise<{ body: string; signature: string; eventId: string }> {
    return await this.support.signStripeEvent(stripeEventBody.parse(body));
  }

  /** Every message the system decided to send, rendered from its frozen payload. */
  @Get('outbox')
  async outbox(): Promise<OutboxMessage[]> {
    return await this.support.outbox();
  }

  /** Phase one of the expiry saga: the deadline passes, the slot stays blocked. */
  @Post('reservations/:sessionId/expire-now')
  @HttpCode(200)
  async expireNow(
    @Param('sessionId') sessionId: string,
  ): Promise<{ bookingId: string; outcome: string }> {
    return await this.support.expireReservationNow(sessionId);
  }

  /** Phase two, in the worker: ask the provider, then release or confirm. */
  @Post('reservations/:sessionId/run-expiry')
  @HttpCode(200)
  async runExpiry(@Param('sessionId') sessionId: string): Promise<{ bookingId: string }> {
    return await this.support.runExpiryJob(sessionId);
  }

  /** Outstanding work, uncached, so a helper can wait for the worker to catch up. */
  @Get('pending')
  async pending(): Promise<PendingWork> {
    return await this.support.pending();
  }
}
