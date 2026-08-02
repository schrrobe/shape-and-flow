import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK } from '../domain/time/clock.js';
import { EnqueueService } from '../messaging/queues/enqueue.service.js';
import { JOB, jobIdFor } from '../messaging/queues/job-contracts.js';
import { NotificationStatus } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { Clock } from '../domain/time/clock.js';

/**
 * How long a notification may stay PENDING before something is wrong.
 *
 * The send job is enqueued in the same transaction that creates the row, so fifteen
 * minutes means the job was lost, the worker is down, or every attempt is failing
 * transiently. All three want a human to know.
 */
export const NOTIFICATION_STALLED_AFTER_MS = 15 * 60_000;

/** Bounded, so one sweep cannot flood the queue after a long outage. */
const BATCH = 200;

/** Redact rather than delete at this age, keeping the delivery statistics. */
export const NOTIFICATION_REDACT_AFTER_DAYS = 90;

export interface NotificationHealth {
  pending: number;
  stalled: number;
  failed: number;
}

/**
 * Notices notifications that never went out, and forgets who they were sent to.
 *
 * Two jobs in one sweep because they are the same kind of housekeeping. Re-enqueueing is
 * safe by construction: `send` returns early for anything but PENDING, so re-driving a
 * row that has since gone out is a no-op.
 *
 * The redaction is the part worth explaining. A notification's *statistics* — how many
 * were delivered, how many bounced — stay useful for years, while the recipient address
 * and subject stop being needed as soon as anyone might have asked about that specific
 * message. So the identifying fields are cleared at ninety days and the row survives.
 */
@Injectable()
export class NotificationReconciler {
  private readonly logger = new Logger('NotificationReconciler');

  constructor(
    private readonly prisma: PrismaService,
    private readonly enqueue: EnqueueService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Counts only, for `/api/health/detail`. */
  async health(): Promise<NotificationHealth> {
    const cutoff = new Date(this.clock.now().getTime() - NOTIFICATION_STALLED_AFTER_MS);

    const [pending, stalled, failed] = await Promise.all([
      this.prisma.notification.count({ where: { status: NotificationStatus.PENDING } }),
      this.prisma.notification.count({
        where: { status: NotificationStatus.PENDING, createdAt: { lt: cutoff } },
      }),
      this.prisma.notification.count({ where: { status: NotificationStatus.FAILED } }),
    ]);

    return { pending, stalled, failed };
  }

  /** Re-enqueue what stalled. Returns how many were re-driven. */
  async runOnce(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - NOTIFICATION_STALLED_AFTER_MS);

    const stalled = await this.prisma.notification.findMany({
      where: { status: NotificationStatus.PENDING, createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: { id: true, organizationId: true },
    });

    for (const notification of stalled) {
      await this.enqueue.enqueue(
        JOB.NOTIFICATION_SEND,
        { organizationId: notification.organizationId, notificationId: notification.id },
        // Keyed on the notification, so repeated sweeps of the same stalled row collapse
        // into one queued job.
        { jobId: jobIdFor('notify', 'retry', notification.id) },
      );
    }

    if (stalled.length > 0) {
      this.logger.warn(`re-enqueued ${String(stalled.length)} stalled notifications`);
    }

    return stalled.length;
  }

  /**
   * Clear the recipient and subject of anything older than the redaction window.
   *
   * `updateMany` with a guard on the recipient, so a second run does not rewrite rows it
   * already handled — and so the count returned means "newly redacted".
   */
  async redactOld(): Promise<number> {
    const cutoff = new Date(
      this.clock.now().getTime() - NOTIFICATION_REDACT_AFTER_DAYS * 86_400_000,
    );

    const { count } = await this.prisma.notification.updateMany({
      where: { createdAt: { lt: cutoff }, recipient: { not: REDACTED } },
      data: { recipient: REDACTED, subject: null },
    });

    if (count > 0) this.logger.log(`redacted ${String(count)} notifications past 90 days`);
    return count;
  }
}

/** What a redacted recipient reads as. A marker, so the row is visibly not missing data. */
export const REDACTED = '[redacted]';
