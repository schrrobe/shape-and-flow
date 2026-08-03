import { Controller, Headers, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { AppError } from '../common/errors/app-error.js';
import { Public } from '../common/guards/public.decorator.js';
import { inboxJobId } from '../messaging/inbox/inbox.reconciler.js';
import { InboxRecorder } from '../messaging/inbox/inbox.recorder.js';
import { EnqueueService } from '../messaging/queues/enqueue.service.js';
import { JOB } from '../messaging/queues/job-contracts.js';
import { PAYMENT_PROVIDER } from '../providers/payment/payment-provider.js';

import { rawBodyOf } from './raw-body.js';

import type { PaymentProvider } from '../providers/payment/payment-provider.js';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Stripe's ingress.
 *
 * Not throttled, deliberately: the signature is the gate, and a rate limit here would
 * let anyone delay real payment events by flooding the endpoint. Public for the same
 * reason — Stripe has no session, and requiring one would mean the signature check never
 * runs.
 *
 * The handler does as little as possible. Verify, store, enqueue, return 200. Everything
 * that could fail slowly — confirming a booking, sending an email — happens in a worker,
 * because Stripe retries on a slow response and a retry storm during an outage is how a
 * webhook endpoint takes the rest of the system with it.
 */
@Controller('webhooks')
@Public()
@SkipThrottle()
export class StripeWebhookController {
  private readonly logger = new Logger('StripeWebhook');

  constructor(
    private readonly inbox: InboxRecorder,
    private readonly enqueue: EnqueueService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
  ) {}

  @Post('stripe')
  @HttpCode(200)
  async stripe(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const rawBody = rawBodyOf(request);

    if (signature === undefined) {
      throw new AppError('VALIDATION_FAILED', { message: 'Missing stripe-signature header.' });
    }

    const event = this.verify(rawBody, signature);

    const recorded = await this.inbox.recordStripe({
      id: event.id,
      type: event.type,
      ...(event.apiVersion === undefined ? {} : { apiVersion: event.apiVersion }),
      payload: event.payload,
    });

    // A redelivery. Stripe is told everything is fine and nothing else happens: the
    // first delivery already stored the event, and whatever it queued is authoritative.
    if (recorded.outcome === 'DUPLICATE') {
      this.logger.debug(`duplicate delivery of ${event.id}`);
      return { received: true };
    }

    await this.queue(recorded.rowId, event.id);

    return { received: true };
  }

  private verify(rawBody: Buffer, signature: string): ReturnType<PaymentProvider['verifyWebhook']> {
    try {
      return this.payments.verifyWebhook(rawBody, signature);
    } catch (error) {
      // A 400 with nothing stored. An unverified body is not evidence of anything, and
      // storing it would let anyone fill the inbox.
      this.logger.warn(
        `rejected webhook: ${error instanceof Error ? error.message : String(error)}`,
      );

      // VALIDATION_FAILED rather than a code of its own. The consumer here is Stripe,
      // which only reads the status, and a 400 is what makes it stop retrying a body it
      // cannot sign correctly. Adding a public error code widens the contract every
      // browser client sees, for a machine that would not look at it.
      throw new AppError('VALIDATION_FAILED', {
        message: 'Signature verification failed.',
      });
    }
  }

  /**
   * Enqueue the processing job, but never fail the response over it.
   *
   * The event is already durably stored, so the inbox reconciler will re-enqueue it
   * within five minutes if this fails. Returning 500 instead would make Stripe retry —
   * and the retry would be a DUPLICATE that enqueues nothing, which is the one
   * combination that actually loses the event.
   */
  private async queue(rowId: string, eventId: string): Promise<void> {
    try {
      await this.enqueue.enqueue(
        JOB.STRIPE_EVENT,
        { stripeEventId: eventId },
        { jobId: inboxJobId(rowId) },
      );
    } catch (error) {
      this.logger.error(
        `stored ${eventId} but could not enqueue it; the inbox reconciler will retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
