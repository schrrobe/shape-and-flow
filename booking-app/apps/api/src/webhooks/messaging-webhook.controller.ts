import { Controller, Headers, HttpCode, Inject, Logger, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

import { AppError } from '../common/errors/app-error.js';
import { Public } from '../common/guards/public.decorator.js';
import { ENV } from '../config/env.schema.js';
import { CLOCK } from '../domain/time/clock.js';
import { inboxJobId } from '../messaging/inbox/inbox.reconciler.js';
import { InboxRecorder } from '../messaging/inbox/inbox.recorder.js';
import { EnqueueService } from '../messaging/queues/enqueue.service.js';
import { JOB } from '../messaging/queues/job-contracts.js';

import { verifySvix, verifyTwilio } from './messaging-signatures.js';
import { rawBodyOf } from './raw-body.js';

import type { AppConfig } from '../config/env.schema.js';
import type { Clock } from '../domain/time/clock.js';
import type { WebhookProvider } from '../prisma/client.js';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Delivery receipts from the messaging providers.
 *
 * Unthrottled and public for the same reasons as the Stripe route: a signature is the
 * gate, the sender has no session, and rate-limiting would let anyone delay real receipts
 * by flooding the endpoint.
 *
 * Both providers are handled in one controller because the shape is identical — verify,
 * record, enqueue, 200 — and only the signature scheme differs.
 */
@Controller('webhooks')
@Public()
@SkipThrottle()
export class MessagingWebhookController {
  private readonly logger = new Logger('MessagingWebhook');

  constructor(
    private readonly inbox: InboxRecorder,
    private readonly enqueue: EnqueueService,
    @Inject(ENV) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post('resend')
  @HttpCode(200)
  async resend(
    @Req() request: RawBodyRequest<Request>,
    @Headers('svix-signature') signature: string | undefined,
    @Headers('svix-id') svixId: string | undefined,
    @Headers('svix-timestamp') timestamp: string | undefined,
  ): Promise<{ received: true }> {
    const rawBody = rawBodyOf(request);

    // Resend signs through Svix: the id and timestamp are part of the signed payload, so
    // a missing one means the request cannot be verified rather than merely unsigned.
    if (signature === undefined || svixId === undefined || timestamp === undefined) {
      throw invalidSignature();
    }

    const secret = this.requireSecret(this.config.RESEND_WEBHOOK_SECRET);

    if (
      !verifySvix({
        secret,
        svixId,
        timestamp,
        body: rawBody.toString('utf8'),
        signatureHeader: signature,
        now: this.clock.now(),
      })
    ) {
      this.logger.warn('rejected a Resend webhook with an invalid signature');
      throw invalidSignature();
    }

    const event = JSON.parse(rawBody.toString('utf8')) as { type?: unknown };

    return await this.record('RESEND', svixId, readType(event.type), rawBody);
  }

  @Post('twilio')
  @HttpCode(200)
  async twilio(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-twilio-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const rawBody = rawBodyOf(request);

    if (signature === undefined) throw invalidSignature();

    const authToken = this.requireSecret(this.config.TWILIO_AUTH_TOKEN);

    // Twilio posts form-encoded, so the body is parsed here rather than as JSON — and the
    // parsed parameters are what the signature covers.
    const form = new URLSearchParams(rawBody.toString('utf8'));

    if (
      !verifyTwilio({
        authToken,
        // The URL Twilio was configured with, which is what it signed. Rebuilt from the
        // configured public origin rather than read from the request: `Host` and the
        // forwarded-proto headers are attacker-controlled, and a signature verified against
        // a URL the client chose verifies nothing.
        url: `${this.config.PUBLIC_API_ORIGIN}/api/webhooks/twilio`,
        params: Object.fromEntries(form.entries()),
        signature,
      })
    ) {
      this.logger.warn('rejected a Twilio webhook with an invalid signature');
      throw invalidSignature();
    }

    const messageSid = form.get('MessageSid');

    if (messageSid === null) throw invalidSignature();

    return await this.record(
      'TWILIO',
      // Twilio has no event id, so the message and its status together identify the
      // delivery: the same message reports `sent` and then `delivered`, and both are
      // distinct events we must not deduplicate into one.
      `${messageSid}:${form.get('MessageStatus') ?? 'unknown'}`,
      form.get('MessageStatus') ?? 'unknown',
      rawBody,
      Object.fromEntries(form.entries()),
    );
  }

  /**
   * The configured signing secret, or a 500.
   *
   * A missing secret is a configuration error rather than a reason to accept the request —
   * an endpoint that verifies nothing is worse than one that is switched off.
   */
  private requireSecret(secret: string | undefined): string {
    if (secret === undefined || secret.length === 0) {
      throw new AppError('INTERNAL_ERROR', {
        message: 'A messaging webhook arrived but no signing secret is configured.',
      });
    }

    return secret;
  }

  /**
   * Store the event and ask a worker to interpret it.
   *
   * The enqueue failure is swallowed for the same reason as in the Stripe route: the event
   * is already durable, the inbox reconciler will re-enqueue it, and a 500 here would make
   * the provider retry into a DUPLICATE that enqueues nothing.
   */
  private async record(
    provider: WebhookProvider,
    providerEventId: string,
    type: string,
    rawBody: Buffer,
    parsed?: Record<string, string>,
  ): Promise<{ received: true }> {
    const recorded = await this.inbox.recordMessaging(provider, {
      id: providerEventId,
      type,
      payload: parsed ?? (JSON.parse(rawBody.toString('utf8')) as unknown),
    });

    if (recorded.outcome === 'DUPLICATE') {
      this.logger.debug(`duplicate ${provider} delivery of ${providerEventId}`);
      return { received: true };
    }

    try {
      await this.enqueue.enqueue(
        JOB.MESSAGING_EVENT,
        { provider, providerEventId },
        { jobId: inboxJobId(recorded.rowId) },
      );
    } catch (error) {
      this.logger.error(
        `stored ${providerEventId} but could not enqueue it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return { received: true };
  }
}

function readType(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

function invalidSignature(): AppError {
  // VALIDATION_FAILED for the same reason the Stripe route uses it: the consumer is a
  // machine that reads only the status, and 400 is what stops it retrying.
  return new AppError('VALIDATION_FAILED', { message: 'Signature verification failed.' });
}
