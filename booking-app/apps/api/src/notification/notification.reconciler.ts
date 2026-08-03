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
const NOTIFICATION_REDACT_AFTER_DAYS = 90;

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

    // SENDING counts as in flight, and as stalled once it is past the window: a claimed row
    // whose worker died is exactly the thing this figure exists to surface.
    const inFlight = [NotificationStatus.PENDING, NotificationStatus.SENDING];

    const [pending, stalled, failed] = await Promise.all([
      this.prisma.notification.count({ where: { status: { in: inFlight } } }),
      this.prisma.notification.count({
        where: { status: { in: inFlight }, createdAt: { lt: cutoff } },
      }),
      this.prisma.notification.count({ where: { status: NotificationStatus.FAILED } }),
    ]);

    return { pending, stalled, failed };
  }

  /** Re-enqueue what stalled. Returns how many were re-driven. */
  async runOnce(): Promise<number> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - NOTIFICATION_STALLED_AFTER_MS);

    // One bucket per stall window. Collapsing repeated sweeps of the same row into one job is
    // the point of a stable id — but BullMQ also refuses that id *later*, so a row that
    // stalls a second time after its first re-drive finished would never be picked up again.
    // The bucket keeps the collapsing inside one window and releases it in the next.
    const bucket = Math.floor(now.getTime() / NOTIFICATION_STALLED_AFTER_MS);

    const stalled = await this.prisma.notification.findMany({
      // SENDING as well as PENDING: a worker that claimed a row and then died leaves it
      // there, and nothing else would ever come back for it.
      where: {
        status: { in: [NotificationStatus.PENDING, NotificationStatus.SENDING] },
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: { id: true, organizationId: true, status: true },
    });

    // Released back to PENDING before re-enqueueing. Left as SENDING, `send` would fail to
    // claim them and report success without having sent anything.
    const abandoned = stalled
      .filter((notification) => notification.status === NotificationStatus.SENDING)
      .map((notification) => notification.id);

    if (abandoned.length > 0) {
      await this.prisma.notification.updateMany({
        where: { id: { in: abandoned }, status: NotificationStatus.SENDING },
        data: { status: NotificationStatus.PENDING },
      });
    }

    for (const notification of stalled) {
      await this.enqueue.enqueue(
        JOB.NOTIFICATION_SEND,
        { organizationId: notification.organizationId, notificationId: notification.id },
        // Keyed on the notification and the window, so repeated sweeps collapse into one
        // queued job without blocking a re-drive in the next window.
        { jobId: jobIdFor('notify', 'retry', notification.id, String(bucket)) },
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
