import { Inject, Injectable, Logger } from '@nestjs/common';
import { render } from '@shape-and-flow/booking-notification-templates';

import { AppError } from '../common/errors/app-error.js';
import { CLOCK } from '../domain/time/clock.js';
import { OutboxRecorder } from '../messaging/outbox/outbox.recorder.js';
import { JOB } from '../messaging/queues/job-contracts.js';
import { NotificationStatus } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EMAIL_PROVIDER } from '../providers/email/email-provider.js';
import { SMS_PROVIDER } from '../providers/sms/sms-provider.js';

import { dedupeKey } from './dedupe-key.js';
import { reviveDates } from './revive-dates.js';

import type { Clock } from '../domain/time/clock.js';
import type {
  Locale,
  NotificationChannel,
  NotificationKind,
  Prisma as PrismaTypes,
} from '../prisma/client.js';
import type { EmailProvider } from '../providers/email/email-provider.js';
import type { SmsProvider } from '../providers/sms/sms-provider.js';
import type { TemplateData } from '@shape-and-flow/booking-notification-templates';

export interface QueueInput<K extends NotificationKind = NotificationKind> {
  organizationId: string;
  kind: K;
  channel: NotificationChannel;
  locale: Locale;
  /** An email address or an E.164 number, depending on the channel. */
  recipient: string;
  bookingId?: string | undefined;
  customerId?: string | undefined;
  officeUserId?: string | undefined;
  /** The template's own data. Stored as JSON so the send is a pure render. */
  data: TemplateData[K];
  /** Distinguishes two notifications of the same kind about the same booking. */
  dedupeDiscriminator?: string | undefined;
  scheduledFor?: Date | undefined;
}

export type SendOutcome = 'SENT' | 'FAILED';

/**
 * Whether a provider failure is worth another attempt.
 *
 * The distinction is not cosmetic. Retrying an invalid address burns attempts and delays
 * the row reaching its final FAILED state, where somebody can see it; giving up on a 503
 * loses a reminder that would have gone through a minute later.
 *
 * Status codes rather than message matching: a 4xx means the provider understood us and
 * refused, a 5xx or a network error means it did not answer.
 */
function isRetryable(error: unknown): boolean {
  const status = (error as { status?: unknown }).status;

  if (typeof status === 'number') return status >= 500 || status === 429;

  // No status at all — a socket error, a timeout, a DNS failure. All worth retrying.
  return true;
}

/**
 * Turns an intention to contact somebody into exactly one message.
 *
 * Two mechanisms, and they solve different halves of the problem. The **dedupe key**
 * stops the same message being created twice, which is what makes the outbox's
 * at-least-once job delivery into effectively-once contact. The **PENDING row before the
 * provider call** stops a message being sent without a trace, so a crash mid-send leaves
 * something the reconciler can find.
 *
 * The template data is stored on the row rather than re-derived at send time. That keeps
 * the send a pure render — no database reads, nothing that can have changed underneath —
 * and it means a notification says what was true when it was queued, which is what a
 * customer reading it later expects.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('Notification');

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxRecorder,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Create the row, inside the caller's transaction.
   *
   * Takes the transaction client so the notification commits with whatever caused it: a
   * confirmation email queued for a booking that rolled back would be a message about
   * something that never happened.
   *
   * @returns `{ notificationId: null }` when an identical notification already exists.
   */
  async queue<K extends NotificationKind>(
    tx: PrismaTypes.TransactionClient,
    input: QueueInput<K>,
  ): Promise<{ notificationId: string | null }> {
    const key = dedupeKey(
      input.kind,
      input.channel,
      input.bookingId ?? null,
      input.dedupeDiscriminator,
    );

    // `createManyAndReturn` with `skipDuplicates` rather than create-and-catch. The
    // difference matters and cost a debugging session: three notifications are queued in
    // one transaction, and a unique violation aborts the *whole* PostgreSQL transaction —
    // Prisma does not wrap interactive-transaction statements in savepoints. Catching the
    // error would leave the next statement failing with "current transaction is aborted".
    // ON CONFLICT DO NOTHING never raises, so the transaction survives.
    const inserted = await tx.notification.createManyAndReturn({
      skipDuplicates: true,
      data: [
        {
          organizationId: input.organizationId,
          ...(input.bookingId === undefined ? {} : { bookingId: input.bookingId }),
          ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
          ...(input.officeUserId === undefined ? {} : { officeUserId: input.officeUserId }),
          kind: input.kind,
          channel: input.channel,
          locale: input.locale,
          recipient: input.recipient,
          status: NotificationStatus.PENDING,
          dedupeKey: key,
          ...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor }),
          // Serialised through JSON so Dates become ISO strings, which is what the row
          // can hold and what `send` parses back.
          payload: JSON.parse(JSON.stringify(input.data)) as PrismaTypes.InputJsonValue,
        },
      ],
      select: { id: true },
    });

    const notification = inserted[0];

    // Nothing inserted: this exact message already exists. A duplicate *job* is normal
    // and a duplicate *email* is not, so this is the expected path rather than an error.
    if (notification === undefined) {
      this.logger.debug(`already queued: ${key}`);
      return { notificationId: null };
    }

    await this.outbox.record(tx, {
      organizationId: input.organizationId,
      aggregateType: 'Notification',
      aggregateId: notification.id,
      eventType: JOB.NOTIFICATION_SEND,
      payload: { organizationId: input.organizationId, notificationId: notification.id },
    });

    return { notificationId: notification.id };
  }

  /**
   * Render and send one notification.
   *
   * Returns early for anything but PENDING, so a redelivered job does not send a second
   * copy of a message already on its way.
   */
  async send(notificationId: string): Promise<SendOutcome> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
        kind: true,
        channel: true,
        locale: true,
        recipient: true,
        status: true,
        payload: true,
      },
    });

    if (notification === null) {
      throw new AppError('NOT_FOUND', { message: 'Notification not found.' });
    }

    if (notification.status !== NotificationStatus.PENDING) {
      return notification.status === NotificationStatus.FAILED ? 'FAILED' : 'SENT';
    }

    const data = reviveDates(notification.payload) as TemplateData[NotificationKind];
    const rendered = render(notification.kind, notification.channel, notification.locale, data);

    try {
      const providerMessageId = await this.deliver(notification, rendered);

      await this.prisma.notification.update({
        where: { id: notification.id },
        data: {
          status: NotificationStatus.SENT,
          sentAt: this.clock.now(),
          providerMessageId,
          ...(rendered.subject === undefined ? {} : { subject: rendered.subject }),
        },
      });

      return 'SENT';
    } catch (error) {
      return await this.recordFailure(notification.id, error);
    }
  }

  private async deliver(
    notification: {
      kind: NotificationKind;
      channel: NotificationChannel;
      locale: Locale;
      recipient: string;
    },
    rendered: { subject?: string | undefined; text: string; html?: string | undefined },
  ): Promise<string> {
    if (notification.channel === 'SMS') {
      const result = await this.sms.send({
        to: notification.recipient,
        body: rendered.text,
        kind: notification.kind,
        locale: notification.locale,
      });

      return result.providerMessageId;
    }

    const result = await this.email.send({
      to: notification.recipient,
      subject: rendered.subject ?? '',
      text: rendered.text,
      ...(rendered.html === undefined ? {} : { html: rendered.html }),
      kind: notification.kind,
      locale: notification.locale,
    });

    return result.providerMessageId;
  }

  /**
   * Record what went wrong, and decide whether the caller should retry.
   *
   * A permanent failure settles the row so it stops being counted as in flight. A
   * transient one leaves it PENDING and rethrows, which is what makes BullMQ retry.
   */
  private async recordFailure(notificationId: string, error: unknown): Promise<SendOutcome> {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = isRetryable(error);

    await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        attempts: { increment: 1 },
        lastError: message.slice(0, 1000),
        ...(retryable ? {} : { status: NotificationStatus.FAILED, failedAt: this.clock.now() }),
      },
    });

    if (retryable) throw error;

    this.logger.warn(`notification ${notificationId} permanently failed: ${message}`);
    return 'FAILED';
  }

  /**
   * Apply a provider's delivery verdict.
   *
   * Matched by `providerMessageId`. An id we do not know is logged rather than raised: it
   * is a message somebody sent from the provider's own console, or one whose row has been
   * pruned, and neither is an error here.
   */
  async applyDeliveryStatus(input: {
    providerMessageId: string;
    delivered: boolean;
    error?: string | undefined;
  }): Promise<void> {
    const notification = await this.prisma.notification.findUnique({
      where: { providerMessageId: input.providerMessageId },
      select: { id: true, status: true },
    });

    if (notification === null) {
      this.logger.warn(`no notification for provider id ${input.providerMessageId}; ignoring`);
      return;
    }

    // DELIVERED and FAILED are both terminal. A provider that reports both — Twilio sends
    // `sent` then `delivered`, and occasionally a late failure — must not flip a row that
    // has already settled.
    if (
      notification.status === NotificationStatus.DELIVERED ||
      notification.status === NotificationStatus.FAILED
    ) {
      return;
    }

    const now = this.clock.now();

    await this.prisma.notification.update({
      where: { id: notification.id },
      data: input.delivered
        ? { status: NotificationStatus.DELIVERED, deliveredAt: now }
        : {
            status: NotificationStatus.FAILED,
            failedAt: now,
            ...(input.error === undefined ? {} : { lastError: input.error.slice(0, 1000) }),
          },
    });
  }
}
