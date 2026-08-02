import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';

import { CLOCK } from '../domain/time/clock.js';
import { EnqueueService } from '../messaging/queues/enqueue.service.js';
import { JOB, QUEUE } from '../messaging/queues/job-contracts.js';
import { BookingStatus, NotificationStatus } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { dedupeKey } from './dedupe-key.js';
import { ReminderService, reminderJobId } from './reminder.service.js';

import type { Clock } from '../domain/time/clock.js';

/**
 * How far ahead the sweep rebuilds.
 *
 * Forty-eight hours rather than everything, because it runs nightly: any appointment that
 * reaches a 24-hour reminder before the next sweep is inside this window. Rebuilding months
 * of reminders every night would put thousands of delayed jobs back into Redis to prove the
 * same thing.
 */
const REMINDER_HORIZON_MS = 48 * 3_600_000;

/** Bounded, so a sweep after a long Redis outage cannot flood the queue. */
const BATCH = 500;

/**
 * Puts reminders back after Redis has lost them.
 *
 * The delayed set is the one piece of state that is not in PostgreSQL, and a `FLUSHALL`, a
 * failed failover or an eviction takes it with no trace. Everything needed to rebuild it is
 * in the database: which bookings are confirmed, when they start, and — through the
 * notification rows — which reminders have already gone out.
 *
 * Two checks before re-enqueueing, and the second is the one that matters. A missing job is
 * not enough: a reminder that already *sent* has no job left either, so re-enqueueing on
 * that alone would send every reminder a second time every night.
 */
@Injectable()
export class ReminderReconciler {
  private readonly logger = new Logger('ReminderReconciler');

  constructor(
    private readonly prisma: PrismaService,
    private readonly reminders: ReminderService,
    private readonly enqueue: EnqueueService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Re-enqueue every reminder that should exist and does not. Returns how many. */
  async runOnce(): Promise<number> {
    const now = this.clock.now();
    const horizon = new Date(now.getTime() + REMINDER_HORIZON_MS);

    const bookings = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.CONFIRMED,
        startsAt: { gt: now, lte: horizon },
      },
      orderBy: { startsAt: 'asc' },
      take: BATCH,
      select: { id: true, organizationId: true, startsAt: true },
    });

    if (bookings.length === 0) return 0;

    const queue = this.enqueue.queue(QUEUE.NOTIFICATION);
    const offsets = this.reminders.offsets();

    // One query for the whole batch. A per-booking round trip would make the nightly sweep
    // scale with the number of appointments rather than with the number of gaps.
    const alreadySent = new Set(
      (
        await this.prisma.notification.findMany({
          where: {
            bookingId: { in: bookings.map((booking) => booking.id) },
            kind: 'REMINDER_24H',
            status: { not: NotificationStatus.PENDING },
          },
          select: { dedupeKey: true },
        })
      ).map((row) => row.dedupeKey),
    );

    let requeued = 0;

    for (const booking of bookings) {
      for (const offsetMinutes of offsets) {
        const delay = booking.startsAt.getTime() - offsetMinutes * 60_000 - now.getTime();
        if (delay <= 0) continue;

        const sentKey = dedupeKey(
          'REMINDER_24H',
          'EMAIL',
          booking.id,
          this.reminders.reminderDedupeDiscriminator(offsetMinutes, booking.startsAt),
        );

        if (alreadySent.has(sentKey)) continue;

        const jobId = reminderJobId(offsetMinutes, booking.id, booking.startsAt);
        if ((await queue.getJob(jobId)) !== undefined) continue;

        await this.enqueue.enqueue(
          JOB.REMINDER_SEND,
          {
            organizationId: booking.organizationId,
            bookingId: booking.id,
            offsetMinutes,
            expectedStartsAtEpochSeconds: Math.floor(booking.startsAt.getTime() / 1000),
          },
          { jobId, delay },
        );

        requeued += 1;
      }
    }

    if (requeued > 0) {
      this.logger.warn(`rebuilt ${String(requeued)} missing reminders`);
    }

    return requeued;
  }
}
