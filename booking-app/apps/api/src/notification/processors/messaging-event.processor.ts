import { Injectable, Logger } from '@nestjs/common';

import { InboxRecorder } from '../../messaging/inbox/inbox.recorder.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationService } from '../notification.service.js';

import type { InboxRef } from '../../messaging/inbox/inbox.recorder.js';
import type { JOB, JobPayload } from '../../messaging/queues/job-contracts.js';
import type { WebhookProvider } from '../../prisma/client.js';

/**
 * Resend event types that carry a verdict.
 *
 * `email.sent` is deliberately absent: it says the provider accepted the message, which
 * the API response already told us. Only delivery and its failures change what we know.
 */
const RESEND_DELIVERED = 'email.delivered';
const RESEND_FAILURES = new Set(['email.bounced', 'email.failed']);

/**
 * A complaint is not a delivery failure.
 *
 * `email.complained` means the message arrived and the recipient pressed "spam". Recording it
 * as FAILED would say the confirmation never reached the customer — it did — and would inflate
 * the reconciler's failure count with something no retry can fix. The verdict stays
 * delivered; the complaint is kept in `lastError` so it is visible to whoever looks.
 */
const RESEND_COMPLAINED = 'email.complained';

/** Twilio's terminal statuses. Anything else is still in flight. */
const TWILIO_DELIVERED = 'delivered';
const TWILIO_FAILURES = new Set(['undelivered', 'failed']);

interface EventShape {
  type?: unknown;
  data?: { email_id?: unknown; id?: unknown };
  MessageSid?: unknown;
  MessageStatus?: unknown;
  ErrorCode?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Turns a stored messaging webhook into a delivery verdict.
 *
 * Reads the event from the inbox rather than the job payload, for the same reason the
 * Stripe processor does: a re-enqueued job sees the event exactly as received.
 *
 * A status for a `providerMessageId` we do not know is a warning, not an error. It is a
 * message somebody sent from the provider's console, or one whose row has been pruned by
 * retention — throwing would have BullMQ retry something that will never resolve.
 */
@Injectable()
export class MessagingEventProcessor {
  private readonly logger = new Logger('MessagingEvent');

  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: InboxRecorder,
    private readonly notifications: NotificationService,
  ) {}

  async handle(payload: JobPayload<typeof JOB.MESSAGING_EVENT>): Promise<void> {
    const ref: InboxRef = {
      kind: 'messaging',
      provider: payload.provider,
      providerEventId: payload.providerEventId,
    };

    const event = await this.prisma.messagingWebhookEvent.findFirst({
      where: { provider: payload.provider, providerEventId: payload.providerEventId },
      select: { type: true, payload: true, processedAt: true },
    });

    if (event === null) {
      this.logger.warn(`messaging event ${payload.providerEventId} is not in the inbox; ignoring`);
      return;
    }

    if (event.processedAt !== null) return;

    try {
      await this.apply(payload.provider, event.payload);
      await this.inbox.markProcessed(ref);
    } catch (error) {
      await this.inbox.markFailed(ref, error);
      throw error;
    }
  }

  private async apply(provider: WebhookProvider, rawPayload: unknown): Promise<void> {
    const event = (rawPayload ?? {}) as EventShape;

    const verdict = provider === 'RESEND' ? this.readResend(event) : this.readTwilio(event);

    if (verdict === null) {
      this.logger.debug(`${provider} event carried no terminal verdict; nothing to apply`);
      return;
    }

    await this.notifications.applyDeliveryStatus(verdict);
  }

  private readResend(
    event: EventShape,
  ): { providerMessageId: string; delivered: boolean; error?: string } | null {
    const type = readString(event.type);
    const providerMessageId = readString(event.data?.email_id) ?? readString(event.data?.id);

    if (type === undefined || providerMessageId === undefined) return null;

    if (type === RESEND_DELIVERED) return { providerMessageId, delivered: true };

    // Delivered, and complained about. See the note on RESEND_COMPLAINED.
    if (type === RESEND_COMPLAINED) {
      return { providerMessageId, delivered: true, error: type };
    }

    if (RESEND_FAILURES.has(type)) return { providerMessageId, delivered: false, error: type };

    return null;
  }

  private readTwilio(
    event: EventShape,
  ): { providerMessageId: string; delivered: boolean; error?: string } | null {
    const providerMessageId = readString(event.MessageSid);
    const status = readString(event.MessageStatus);

    if (providerMessageId === undefined || status === undefined) return null;

    if (status === TWILIO_DELIVERED) return { providerMessageId, delivered: true };

    if (TWILIO_FAILURES.has(status)) {
      // Twilio sends `ErrorCode` as a JSON number on some transports and as a string on
      // others. Read as a string only, the numeric form is dropped — and the code is the one
      // field a support conversation with Twilio actually starts from.
      const code =
        typeof event.ErrorCode === 'number' ? String(event.ErrorCode) : readString(event.ErrorCode);

      return {
        providerMessageId,
        delivered: false,
        // The code is what a support conversation with Twilio starts from, so it belongs
        // in the message rather than only the status.
        error: code === undefined ? status : `${status} (${code})`,
      };
    }

    return null;
  }
}
