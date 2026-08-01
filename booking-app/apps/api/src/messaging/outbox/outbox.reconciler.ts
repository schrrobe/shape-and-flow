import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK } from '../../domain/time/clock.js';
import { PrismaService } from '../../prisma/prisma.service.js';

import { OUTBOX_MAX_ATTEMPTS } from './outbox.dispatcher.js';

import type { Clock } from '../../domain/time/clock.js';
import type { Prisma } from '../../prisma/client.js';

/**
 * A row undispatched for longer than this is not "in flight", it is stuck.
 *
 * The dispatcher runs every 500ms, so five minutes is three orders of magnitude
 * beyond normal. A row that old means the worker is down, the row keeps failing, or
 * its `availableAt` was set further out than anyone intended.
 */
export const OUTBOX_STALLED_AFTER_MS = 5 * 60_000;

/**
 * How long a dispatched row is kept.
 *
 * Long enough to answer "was the confirmation actually queued" about a booking
 * somebody is still arguing about, short enough that the table stays small.
 */
export const OUTBOX_RETENTION_DAYS = 14;

/** How many ids a log line names before it becomes noise. */
const SAMPLE_LIMIT = 20;

export interface OutboxHealth {
  /** Undispatched and still being attempted. */
  pending: number;
  /** Undispatched for longer than {@link OUTBOX_STALLED_AFTER_MS}. */
  stalled: number;
  /** Past {@link OUTBOX_MAX_ATTEMPTS}; the dispatcher will never claim these again. */
  exhausted: number;
  /** Age of the oldest undispatched row, or null when there is none. */
  oldestPendingAgeSeconds: number | null;
}

/** Undispatched, still under the attempt limit. */
const pendingWhere: Prisma.OutboxEventWhereInput = {
  dispatchedAt: null,
  attempts: { lt: OUTBOX_MAX_ATTEMPTS },
};

/** Undispatched and past the attempt limit — abandoned by the dispatcher. */
const exhaustedWhere: Prisma.OutboxEventWhereInput = {
  dispatchedAt: null,
  attempts: { gte: OUTBOX_MAX_ATTEMPTS },
};

/** Pending, and old enough that something is wrong. */
function stalledWhere(now: Date): Prisma.OutboxEventWhereInput {
  return { ...pendingWhere, createdAt: { lt: new Date(now.getTime() - OUTBOX_STALLED_AFTER_MS) } };
}

/**
 * Notices what the dispatcher cannot.
 *
 * The dispatcher only ever sees rows it can claim, so the two failure modes that
 * matter — a row that keeps failing, and a row nothing is trying any more — are
 * invisible from inside it. This counts both, says so at `error` level with enough
 * ids to start an investigation, and reclaims space from rows already delivered.
 *
 * Runs as the `sweep.outbox` maintenance job. Until the worker process exists it is
 * callable directly, and {@link health} is what `/api/health/detail` will report.
 */
@Injectable()
export class OutboxReconciler {
  private readonly logger = new Logger('OutboxReconciler');

  constructor(
    // The root client: this scans and prunes across every organization, which is
    // what the tenant guard is designed to refuse.
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Counts only. Safe to call from a health endpoint on any schedule.
   *
   * The injected clock, matching the dispatcher — see the note on `drainOnce` for
   * why the database's own clock is the wrong one to compare these rows against.
   */
  async health(): Promise<OutboxHealth> {
    const now = this.clock.now();

    const [pending, stalled, exhausted, oldest] = await Promise.all([
      this.prisma.outboxEvent.count({ where: pendingWhere }),
      this.prisma.outboxEvent.count({ where: stalledWhere(now) }),
      this.prisma.outboxEvent.count({ where: exhaustedWhere }),
      this.prisma.outboxEvent.findFirst({
        where: { dispatchedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    return {
      pending,
      stalled,
      exhausted,
      oldestPendingAgeSeconds:
        oldest === null ? null : Math.floor((now.getTime() - oldest.createdAt.getTime()) / 1000),
    };
  }

  /**
   * Report the stuck rows and prune the delivered ones.
   *
   * @returns the same counts as {@link health}, plus how many rows were deleted.
   */
  async reconcile(): Promise<OutboxHealth & { deleted: number }> {
    const now = this.clock.now();
    const health = await this.health();

    if (health.stalled > 0) await this.report('stalled', stalledWhere(now));
    if (health.exhausted > 0) await this.report('exhausted', exhaustedWhere);

    const deleted = await this.prune(now);

    if (health.stalled === 0 && health.exhausted === 0) {
      this.logger.debug(
        `outbox healthy: ${String(health.pending)} pending, ${String(deleted)} pruned`,
      );
    }

    return { ...health, deleted };
  }

  /** Name a bounded sample of the offending rows, so the log line is actionable. */
  private async report(label: string, where: Prisma.OutboxEventWhereInput): Promise<void> {
    const rows = await this.prisma.outboxEvent.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: SAMPLE_LIMIT,
      select: { eventType: true, aggregateType: true, aggregateId: true, attempts: true },
    });

    const sample = rows
      .map(
        (row) =>
          `${row.eventType}(${row.aggregateType}:${row.aggregateId}, ${String(row.attempts)}x)`,
      )
      .join(', ');

    this.logger.error(`${String(rows.length)} ${label} outbox rows — ${sample}`);
  }

  /** Delete rows delivered longer ago than the retention window. */
  private async prune(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - OUTBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000);

    const { count } = await this.prisma.outboxEvent.deleteMany({
      where: { dispatchedAt: { not: null, lt: cutoff } },
    });

    return count;
  }
}
