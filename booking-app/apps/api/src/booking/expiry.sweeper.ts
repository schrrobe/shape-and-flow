import { Inject, Injectable, Logger } from '@nestjs/common';

import { CLOCK } from '../domain/time/clock.js';
import { EnqueueService } from '../messaging/queues/enqueue.service.js';
import { JOB, jobIdFor } from '../messaging/queues/job-contracts.js';
import { Prisma } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { ExpiryService } from './expiry.service.js';

import type { Clock } from '../domain/time/clock.js';

/** Bounded so one tick cannot try to expire the whole table. */
const EXPIRY_SWEEP_BATCH = 200;

/**
 * How long an EXPIRING booking may sit before it is assumed stuck.
 *
 * Phase two normally completes in the time one Stripe call takes. Two minutes past that
 * means the worker died mid-saga, and the slot is being over-blocked for nothing.
 */
export const STUCK_EXPIRING_AFTER_MS = 2 * 60_000;

/**
 * The safety net under the per-booking expiry job.
 *
 * The delayed job is the primary mechanism and this exists because that job can be lost
 * — Redis flushed, a job removed after its retention window, a deploy that drops the
 * queue. Without a sweep, a lost job means a slot blocked until somebody notices by hand.
 *
 * Both halves matter. `sweepOverdue` catches reservations that never started expiring;
 * `sweepStuckExpiring` catches ones that started and never finished. The second is the
 * one that makes the intermediate EXPIRING status safe to depend on.
 */
@Injectable()
export class ExpirySweeper {
  private readonly logger = new Logger('ExpirySweeper');

  constructor(
    private readonly prisma: PrismaService,
    private readonly expiry: ExpiryService,
    private readonly enqueue: EnqueueService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Start phase one for every reservation whose time has passed.
   *
   * `FOR UPDATE SKIP LOCKED` so two workers sweeping at once split the work instead of
   * waiting on each other. Claimed inside a transaction that is then released — the row
   * is not held while `beginExpiry` takes its own lock, because that would deadlock with
   * itself.
   */
  async sweepOverdue(): Promise<number> {
    const now = this.clock.now();

    const due = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM bookings
      WHERE status = 'PENDING_PAYMENT' AND expires_at < ${now}
      ORDER BY expires_at
      FOR UPDATE SKIP LOCKED
      LIMIT ${EXPIRY_SWEEP_BATCH}
    `);

    let began = 0;

    for (const row of due) {
      // Each booking independently: one that fails must not stop the rest, and
      // beginExpiry re-checks everything under its own lock anyway.
      try {
        if ((await this.expiry.beginExpiry(row.id)) === 'BEGAN') began += 1;
      } catch (error) {
        this.logger.error(
          `could not begin expiry for ${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (began > 0) this.logger.log(`began expiry for ${String(began)} overdue reservations`);
    return began;
  }

  /**
   * Re-drive bookings stuck in EXPIRING.
   *
   * Re-enqueues rather than calling `completeExpiry` inline, so the retry and backoff
   * belong to BullMQ rather than being reimplemented here. The job id includes the
   * booking id only — not a timestamp — so repeated sweeps of the same stuck booking
   * collapse into one queued job.
   */
  async sweepStuckExpiring(): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - STUCK_EXPIRING_AFTER_MS);

    const stuck = await this.prisma.booking.findMany({
      where: { status: 'EXPIRING', updatedAt: { lt: cutoff } },
      orderBy: { updatedAt: 'asc' },
      take: EXPIRY_SWEEP_BATCH,
      select: { id: true, organizationId: true },
    });

    for (const booking of stuck) {
      await this.enqueue.enqueue(
        JOB.BOOKING_EXPIRY_REQUESTED,
        { organizationId: booking.organizationId, bookingId: booking.id },
        { jobId: jobIdFor('expiry', 'retry', booking.id) },
      );
    }

    if (stuck.length > 0) {
      this.logger.warn(`re-drove ${String(stuck.length)} bookings stuck in EXPIRING`);
    }

    return stuck.length;
  }
}
