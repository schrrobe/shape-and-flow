import { Inject, Injectable, Logger } from '@nestjs/common';

import { ENV } from '../../config/env.schema.js';
import { CLOCK } from '../../domain/time/clock.js';
import { Prisma } from '../../prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EnqueueService } from '../queues/enqueue.service.js';
import { isJobName, jobIdFor } from '../queues/job-contracts.js';

import type { AppConfig } from '../../config/env.schema.js';
import type { Clock } from '../../domain/time/clock.js';
import type { AnyJobPayload } from '../queues/enqueue.service.js';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

/**
 * Attempts after which the dispatcher stops trying.
 *
 * A row this far gone is not going to succeed by being retried again; leaving it
 * alone keeps the claim query small and hands the row to the reconciler, which is
 * the thing that shouts about it.
 */
export const OUTBOX_MAX_ATTEMPTS = 10;

/** Rows claimed per drain. Bounded so one drain cannot hold a transaction open for long. */
export const OUTBOX_BATCH_SIZE = 50;

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 3_600_000;

/** How often the worker drains. Short, because this delay is added to every notification. */
export const OUTBOX_DRAIN_INTERVAL_MS = 500;

/** Raw column names, because the claim needs SQL Prisma cannot express. */
interface ClaimedRow {
  id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
}

/** `30s · 2^attempts`, capped at an hour. */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

/**
 * Moves committed events onto queues.
 *
 * The claim uses `FOR UPDATE SKIP LOCKED`, which is the whole reason two workers
 * can drain concurrently: each takes rows the other has not locked, and neither
 * waits. Prisma has no way to express it, so this is one of the few places raw SQL
 * is right.
 *
 * The enqueue happens *inside* the claiming transaction, deliberately. If the
 * process dies after Redis has the job but before the row is marked, the next
 * drain re-enqueues with the same job id and BullMQ discards the duplicate. The
 * reverse order — mark, commit, then enqueue — loses the job outright on the same
 * crash, which is exactly the failure the outbox exists to prevent.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger('Outbox');

  constructor(
    // The root client, not the tenant-guarded one: the dispatcher scans every
    // organization by design, which is what the guard is built to reject.
    private readonly prisma: PrismaService,
    private readonly enqueueService: EnqueueService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Claim, enqueue and mark one batch. Returns how many rows were dispatched.
   *
   * "Now" is the injected clock rather than SQL `now()`, which took a wrong turn to
   * arrive at. Every timestamp this compares against is written by the
   * *application*: Prisma sends a client-generated value for `@default(now())`
   * rather than letting Postgres fill the column. Claiming with the database's
   * clock therefore compares two different clocks, and a row recorded milliseconds
   * ago can sit in the database's future — which showed up as a drain that
   * intermittently found nothing, because the Docker database's clock drifts
   * against the host's. One clock on both sides removes the whole class of problem,
   * and makes a fixed clock in a test agree with the rows the test wrote.
   */
  async drainOnce(): Promise<number> {
    const now = this.clock.now();

    return await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<ClaimedRow[]>(Prisma.sql`
          SELECT id, event_type, payload, attempts
          FROM outbox_events
          WHERE dispatched_at IS NULL
            AND available_at <= ${now}
            AND attempts < ${OUTBOX_MAX_ATTEMPTS}
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT ${OUTBOX_BATCH_SIZE}
        `);

        if (rows.length === 0) return 0;

        const dispatched: string[] = [];
        const failed: { id: string; attempts: number; error: string }[] = [];

        for (const row of rows) {
          try {
            await this.dispatch(row);
            dispatched.push(row.id);
          } catch (error) {
            failed.push({
              id: row.id,
              attempts: row.attempts,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (dispatched.length > 0) {
          await tx.outboxEvent.updateMany({
            where: { id: { in: dispatched } },
            data: { dispatchedAt: now },
          });
        }

        for (const failure of failed) {
          await tx.outboxEvent.update({
            where: { id: failure.id },
            data: {
              attempts: { increment: 1 },
              // Truncated: a driver error can carry a very long message, and the
              // column is for diagnosis, not for archiving stack traces.
              lastError: failure.error.slice(0, 1000),
              availableAt: new Date(now.getTime() + outboxBackoffMs(failure.attempts)),
            },
          });

          this.logger.warn(
            `outbox row ${failure.id} failed (attempt ${String(failure.attempts + 1)} of ${String(OUTBOX_MAX_ATTEMPTS)}): ${failure.error}`,
          );
        }

        return dispatched.length;
      },
      // Longer than Prisma's 5-second default, because the batch does Redis I/O
      // while holding its locks. Still bounded: a drain that cannot finish should
      // roll back and let the next one retry, not block the table indefinitely.
      { timeout: 20_000 },
    );
  }

  /**
   * Enqueue one claimed row.
   *
   * The job id is derived from the row id, so a redelivery is a BullMQ no-op. Note
   * the limit of that: deduplication only holds while the job still exists in
   * Redis, and completed jobs are removed after a day — a crash that leaves a row
   * unmarked for longer than that can enqueue a second time, which is why every
   * processor has to be idempotent regardless.
   */
  private async dispatch(row: ClaimedRow): Promise<void> {
    const { event_type: eventType } = row;

    if (!isJobName(eventType)) {
      // Recorded as a failure rather than thrown away: a row naming a job that no
      // longer exists is a deployment mistake, and it should end up in the
      // reconciler's exhausted count where somebody sees it.
      throw new Error(
        `Event type "${eventType}" is not a declared job. It was removed from JOB, or the row predates a rename.`,
      );
    }

    await this.enqueueService.enqueue(eventType, row.payload as AnyJobPayload, {
      jobId: jobIdFor('outbox', row.id),
    });
  }
}

/**
 * Runs the drain on an interval, in the worker process only.
 *
 * The API must not drain. Two reasons: a request-serving process should not be
 * holding row locks on a table every half second, and having exactly one kind of
 * process responsible makes "why did this job not run" a question with one place
 * to look. It is registered in both roles and starts in one, so the API logs that
 * it is not draining rather than saying nothing at all.
 */
@Injectable()
export class OutboxDispatcherScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Outbox');
  private timer: NodeJS.Timeout | null = null;

  /** The drain in progress, and the re-entrancy guard: non-null means one is running. */
  private current: Promise<void> | null = null;

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.APP_ROLE !== 'worker') {
      this.logger.log('dispatcher not started (api role); the worker drains the outbox');
      return;
    }

    this.timer = setInterval(() => {
      this.tick();
    }, OUTBOX_DRAIN_INTERVAL_MS);

    this.logger.log(`draining every ${String(OUTBOX_DRAIN_INTERVAL_MS)}ms`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // Wait out a drain in progress so its transaction commits, rather than having
    // the process exit mid-batch and leave rows locked until the connection drops.
    if (this.current !== null) await this.current;
  }

  private tick(): void {
    // A drain slower than the interval must not overlap itself: two drains from the
    // same process would compete for the same rows and double the lock traffic for
    // no gain.
    if (this.current !== null) return;

    this.current = this.drain().finally(() => {
      this.current = null;
    });
  }

  private async drain(): Promise<void> {
    try {
      const count = await this.dispatcher.drainOnce();
      if (count > 0) this.logger.debug(`dispatched ${String(count)}`);
    } catch (error) {
      // Swallowed on purpose: a failed drain is retried in 500ms, and an unhandled
      // rejection here would take the worker down over a transient database blip.
      this.logger.error(`drain failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
