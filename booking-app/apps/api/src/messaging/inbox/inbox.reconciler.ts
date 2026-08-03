import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK } from '../../domain/time/clock.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EnqueueService } from '../queues/enqueue.service.js';
import { JOB, jobIdFor } from '../queues/job-contracts.js';

import type { Clock } from '../../domain/time/clock.js';

/**
 * How long an event may sit unprocessed before it is assumed lost.
 *
 * The gap this covers is real and unavoidable: the row commits to Postgres and the
 * job goes to Redis, and no transaction spans both. A crash in between leaves an
 * event that nothing will ever pick up. Five minutes is long enough that a
 * momentarily backed-up worker is not fought with, short enough that a customer who
 * has paid is not left waiting for a confirmation.
 */
export const INBOX_STALLED_AFTER_MS = 5 * 60_000;

/** Attempts after which an event is reported rather than retried again. */
export const INBOX_MAX_ATTEMPTS = 10;

/** Re-enqueued per run. Bounded so a backlog cannot flood the queue in one tick. */
export const INBOX_BATCH_SIZE = 100;

/**
 * Retention.
 *
 * Stripe events are kept far longer than messaging events because they are payment
 * evidence: "did Stripe tell us this session completed, and when" is a question
 * that gets asked months later. A delivery receipt for an email is not.
 */
export const INBOX_STRIPE_RETENTION_DAYS = 90;
export const INBOX_MESSAGING_RETENTION_DAYS = 30;

/** How many ids a log line names before it becomes noise. */
const SAMPLE_LIMIT = 20;

export interface InboxKindHealth {
  /** Unprocessed and still being retried. */
  pending: number;
  /** Unprocessed for longer than {@link INBOX_STALLED_AFTER_MS}. */
  stalled: number;
  /** Past {@link INBOX_MAX_ATTEMPTS}; no longer retried. */
  poisoned: number;
}

export interface InboxHealth {
  stripe: InboxKindHealth;
  messaging: InboxKindHealth;
}

export interface InboxRunResult {
  reenqueued: number;
  poisoned: number;
  deleted: number;
}

/**
 * Predicates shared by both tables.
 *
 * Left unannotated on purpose: the two models have distinct `WhereInput` types, and
 * an inferred literal is assignable to both — annotating with either one would make
 * it unusable for the other.
 */

/** Unprocessed, still under the attempt limit. */
const pendingWhere = { processedAt: null, attempts: { lt: INBOX_MAX_ATTEMPTS } };

/** Unprocessed and past the attempt limit. */
const poisonedWhere = { processedAt: null, attempts: { gte: INBOX_MAX_ATTEMPTS } };

/** Pending, and old enough that whatever should have processed it did not. */
function stalledWhere(now: Date) {
  return { ...pendingWhere, receivedAt: { lt: new Date(now.getTime() - INBOX_STALLED_AFTER_MS) } };
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * The job id for an inbox row.
 *
 * Derived from the row id, not from the provider's event id as the plan had it. Two
 * reasons: a provider id is not guaranteed to be key-safe — BullMQ rejects a colon —
 * and a row id is a cuid, so it is always valid and always unique. Deterministic
 * either way, which is what makes re-enqueueing an already-queued event a no-op.
 */
export function inboxJobId(rowId: string): string {
  return jobIdFor('inbox', rowId);
}

/**
 * Re-delivers webhook events that were recorded but never processed.
 *
 * This is the other half of the inbox. The recorder guarantees an event is not
 * acted on twice; this guarantees it is acted on at least once, by finding rows
 * that have been sitting unprocessed and putting them back on the queue.
 *
 * Runs as the `sweep.inbox` maintenance job every two minutes. The worker process
 * that schedules it arrives in stage 7; until then this is callable directly.
 */
@Injectable()
export class InboxReconciler {
  private readonly logger = new Logger('InboxReconciler');

  constructor(
    // The root client: an inbound event has no organization, and this scans across
    // all of them by design.
    private readonly prisma: PrismaService,
    private readonly enqueueService: EnqueueService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Counts only, for `/api/health/detail`. */
  async health(): Promise<InboxHealth> {
    const now = this.clock.now();
    const stalled = stalledWhere(now);

    const [
      stripePending,
      stripeStalled,
      stripePoisoned,
      messagingPending,
      messagingStalled,
      messagingPoisoned,
    ] = await Promise.all([
      this.prisma.stripeWebhookEvent.count({ where: pendingWhere }),
      this.prisma.stripeWebhookEvent.count({ where: stalled }),
      this.prisma.stripeWebhookEvent.count({ where: poisonedWhere }),
      this.prisma.messagingWebhookEvent.count({ where: pendingWhere }),
      this.prisma.messagingWebhookEvent.count({ where: stalled }),
      this.prisma.messagingWebhookEvent.count({ where: poisonedWhere }),
    ]);

    return {
      stripe: { pending: stripePending, stalled: stripeStalled, poisoned: stripePoisoned },
      messaging: {
        pending: messagingPending,
        stalled: messagingStalled,
        poisoned: messagingPoisoned,
      },
    };
  }

  /** Re-enqueue what is stalled, report what is poisoned, prune what is spent. */
  async runOnce(): Promise<InboxRunResult> {
    const now = this.clock.now();

    const reenqueued = (await this.reenqueueStripe(now)) + (await this.reenqueueMessaging(now));
    const poisoned = await this.reportPoisoned();
    const deleted = await this.prune(now);

    if (reenqueued > 0)
      this.logger.warn(`re-enqueued ${String(reenqueued)} stalled webhook events`);

    return { reenqueued, poisoned, deleted };
  }

  private async reenqueueStripe(now: Date): Promise<number> {
    const rows = await this.prisma.stripeWebhookEvent.findMany({
      where: stalledWhere(now),
      orderBy: { receivedAt: 'asc' },
      take: INBOX_BATCH_SIZE,
      select: { id: true, stripeEventId: true },
    });

    for (const row of rows) {
      await this.enqueueService.enqueue(
        JOB.STRIPE_EVENT,
        { stripeEventId: row.stripeEventId },
        { jobId: inboxJobId(row.id) },
      );
    }

    return rows.length;
  }

  private async reenqueueMessaging(now: Date): Promise<number> {
    const rows = await this.prisma.messagingWebhookEvent.findMany({
      where: stalledWhere(now),
      orderBy: { receivedAt: 'asc' },
      take: INBOX_BATCH_SIZE,
      select: { id: true, provider: true, providerEventId: true },
    });

    for (const row of rows) {
      await this.enqueueService.enqueue(
        JOB.MESSAGING_EVENT,
        { provider: row.provider, providerEventId: row.providerEventId },
        { jobId: inboxJobId(row.id) },
      );
    }

    return rows.length;
  }

  /**
   * Report events that have failed too many times.
   *
   * Not re-enqueued: an event that has failed ten times will fail again, and
   * retrying it forever buries the signal. Someone has to look at it, so it is
   * logged at `error` with the type and the id.
   */
  private async reportPoisoned(): Promise<number> {
    const [stripe, messaging, stripeTotal, messagingTotal] = await Promise.all([
      this.prisma.stripeWebhookEvent.findMany({
        where: poisonedWhere,
        orderBy: { receivedAt: 'asc' },
        take: SAMPLE_LIMIT,
        select: { stripeEventId: true, type: true, attempts: true, lastError: true },
      }),
      this.prisma.messagingWebhookEvent.findMany({
        where: poisonedWhere,
        orderBy: { receivedAt: 'asc' },
        take: SAMPLE_LIMIT,
        select: { provider: true, providerEventId: true, type: true, attempts: true },
      }),
      this.prisma.stripeWebhookEvent.count({ where: poisonedWhere }),
      this.prisma.messagingWebhookEvent.count({ where: poisonedWhere }),
    ]);

    for (const row of stripe) {
      this.logger.error(
        `poisoned stripe event ${row.stripeEventId} (${row.type}) after ${String(row.attempts)} attempts: ${row.lastError ?? 'no error recorded'}`,
      );
    }

    for (const row of messaging) {
      this.logger.error(
        `poisoned ${row.provider} event ${row.providerEventId} (${row.type}) after ${String(row.attempts)} attempts`,
      );
    }

    return stripeTotal + messagingTotal;
  }

  /** Delete processed events past their retention window. */
  private async prune(now: Date): Promise<number> {
    const [stripe, messaging] = await Promise.all([
      this.prisma.stripeWebhookEvent.deleteMany({
        where: {
          processedAt: { not: null, lt: daysBefore(now, INBOX_STRIPE_RETENTION_DAYS) },
        },
      }),
      this.prisma.messagingWebhookEvent.deleteMany({
        where: {
          processedAt: { not: null, lt: daysBefore(now, INBOX_MESSAGING_RETENTION_DAYS) },
        },
      }),
    ]);

    return stripe.count + messaging.count;
  }
}
