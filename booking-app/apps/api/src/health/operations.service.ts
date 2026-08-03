import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK } from '../domain/time/clock.js';
import { InboxReconciler } from '../messaging/inbox/inbox.reconciler.js';
import { OutboxReconciler } from '../messaging/outbox/outbox.reconciler.js';
import { QUEUE_REGISTRY } from '../messaging/queues/enqueue.service.js';
import { QUEUES } from '../messaging/queues/job-contracts.js';
import { NotificationReconciler } from '../notification/notification.reconciler.js';
import { BookingStatus } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { Clock } from '../domain/time/clock.js';
import type { QueueRegistry } from '../messaging/queues/enqueue.service.js';
import type { QueueName } from '../messaging/queues/job-contracts.js';

/**
 * How long a snapshot is reused.
 *
 * The office dashboard polls this while somebody has it open, and every figure here
 * costs a database round trip or a Redis call. Ten seconds is far below the interval
 * at which any of these numbers means something, and far above the interval at which
 * a polling browser could turn a diagnostic into a load source.
 */
export const OPERATIONS_CACHE_MS = 10_000;

/** What one queue is carrying. */
export interface QueueDepth {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

/**
 * The counters `/api/health/detail` reports.
 *
 * A figure that could not be read is `-1` rather than absent: an operator reading a
 * missing key cannot tell "zero" from "we could not look", and the whole point of
 * this endpoint is to be readable during an incident.
 */
export interface OperationsSnapshot {
  /** Per queue, empty when Redis could not be reached. */
  queues: Partial<Record<QueueName, QueueDepth>>;
  failedJobs: number;
  stuckOutboxRows: number;
  unprocessedWebhooks: number;
  pendingNotifications: number;
  /** How long the oldest EXPIRING booking has sat in that state. Null when none is. */
  oldestExpiringBookingAgeSeconds: number | null;
}

/**
 * Everything an operator needs to answer "is the machinery moving?".
 *
 * Every figure comes from the component that already owns the definition — the two
 * reconcilers, the notification reconciler, BullMQ itself — rather than from queries
 * restated here. Two definitions of "stuck" that disagree would be worse than one
 * that is occasionally wrong.
 *
 * These count what is *stuck*, using each component's own staleness window: an outbox
 * row undispatched for five minutes, a webhook unprocessed for five, a notification
 * pending for fifteen. The office dashboard's tiles count what is *outstanding*,
 * which is the question somebody opening the dashboard is asking. The difference is
 * deliberate; both read from the same `health()` methods.
 */
@Injectable()
export class OperationsService {
  private readonly logger = new Logger('Operations');

  private cached: { at: number; snapshot: OperationsSnapshot } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxReconciler,
    private readonly inbox: InboxReconciler,
    private readonly notifications: NotificationReconciler,
    @Inject(QUEUE_REGISTRY) private readonly queues: QueueRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async snapshot(): Promise<OperationsSnapshot> {
    const now = this.clock.now().getTime();

    if (this.cached !== null && now - this.cached.at < OPERATIONS_CACHE_MS) {
      return this.cached.snapshot;
    }

    const snapshot = await this.collect();
    this.cached = { at: now, snapshot };

    return snapshot;
  }

  private async collect(): Promise<OperationsSnapshot> {
    const [queues, outbox, inbox, notifications, oldestExpiring] = await Promise.all([
      this.safely(() => this.queueDepths()),
      this.safely(() => this.outbox.health()),
      this.safely(() => this.inbox.health()),
      this.safely(() => this.notifications.health()),
      this.safely(() => this.oldestExpiring()),
    ]);

    return {
      queues: queues ?? {},
      failedJobs:
        queues === null
          ? -1
          : Object.values(queues).reduce((total, depth) => total + depth.failed, 0),
      stuckOutboxRows: outbox === null ? -1 : outbox.stalled + outbox.exhausted,
      unprocessedWebhooks:
        inbox === null
          ? -1
          : inbox.stripe.stalled +
            inbox.stripe.poisoned +
            inbox.messaging.stalled +
            inbox.messaging.poisoned,
      pendingNotifications: notifications === null ? -1 : notifications.stalled,
      // `-1` and `null` mean different things here: one is "we could not look", the
      // other is "there is nothing in that state". Which is why the read below
      // wraps its answer rather than returning a bare `null` that `safely` would
      // make indistinguishable from a failure.
      oldestExpiringBookingAgeSeconds: oldestExpiring === null ? -1 : oldestExpiring.ageSeconds,
    };
  }

  private async queueDepths(): Promise<Record<QueueName, QueueDepth>> {
    const entries = await Promise.all(
      QUEUES.map(async (name) => {
        const counts = await this.queues[name].getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
        );

        return [
          name,
          {
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
          },
        ] as const;
      }),
    );

    return Object.fromEntries(entries) as Record<QueueName, QueueDepth>;
  }

  /**
   * How long the oldest EXPIRING booking has been in that state.
   *
   * Measured from `updatedAt`, which is when the two-phase saga moved it there. A
   * booking that has been EXPIRING for more than a few seconds means the saga's
   * second phase never ran — the case `sweep.stuck_expiring` exists for, and the one
   * an operator wants to see rising.
   */
  private async oldestExpiring(): Promise<{ ageSeconds: number | null }> {
    const oldest = await this.prisma.booking.findFirst({
      where: { status: BookingStatus.EXPIRING },
      orderBy: { updatedAt: 'asc' },
      select: { updatedAt: true },
    });

    if (oldest === null) return { ageSeconds: null };

    return {
      ageSeconds: Math.max(
        0,
        Math.floor((this.clock.now().getTime() - oldest.updatedAt.getTime()) / 1000),
      ),
    };
  }

  /**
   * Read one figure, or none.
   *
   * A health endpoint that fails because one of its own counters could not be read
   * is the endpoint failing at the moment it is needed. `null` becomes `-1` in the
   * response, which says "not counted" without pretending to be a count.
   */
  private async safely<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      this.logger.warn(
        `an operations figure could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
