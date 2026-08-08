import { Injectable, Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';

import { CLOCK } from '../domain/time/clock.js';
import { EnqueueService } from '../messaging/queues/enqueue.service.js';
import { JOB, QUEUE } from '../messaging/queues/job-contracts.js';
import { runWithOrganization } from '../organization/tenant-context.store.js';
import { BookingStatus } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { dedupeKey } from './dedupe-key.js';
import { ReminderService, reminderJobId, startsAtEpochSeconds } from './reminder.service.js';

import type { Clock } from '../domain/time/clock.js';

interface ReconcilableBooking {
  id: string;
  organizationId: string;
  startsAt: Date;
}

/** One entry per organization, in the order the organizations first appear. */
function groupByOrganization(
  bookings: readonly ReconcilableBooking[],
): Map<string, ReconcilableBooking[]> {
  const groups = new Map<string, ReconcilableBooking[]>();

  for (const booking of bookings) {
    const group = groups.get(booking.organizationId);
    if (group === undefined) groups.set(booking.organizationId, [booking]);
    else group.push(booking);
  }

  return groups;
}

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

    const queue = this.enqueue.queue(QUEUE.NOTIFICATION);
    let requeued = 0;
    let cursor: string | undefined;

    while (requeued < BATCH) {
      const bookings = await this.prisma.booking.findMany({
        where: {
          status: BookingStatus.CONFIRMED,
          startsAt: { gt: now, lte: horizon },
        },
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: BATCH,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
        select: { id: true, organizationId: true, startsAt: true },
      });

      if (bookings.length === 0) break;

      // Any reminder row means this job already reached durable notification handling.
      // PENDING/SENDING rows are re-driven by SWEEP_NOTIFICATIONS, not by minting a fresh
      // token and trying the reminder job again.
      const alreadyHandled = new Set(
        (
          await this.prisma.notification.findMany({
            where: {
              bookingId: { in: bookings.map((booking) => booking.id) },
              kind: 'REMINDER_24H',
            },
            select: { dedupeKey: true },
          })
        ).map((row) => row.dedupeKey),
      );

      // Grouped by organization, and each group rebuilt inside its own tenant scope.
      // Reminder offsets are a per-tenant setting, so one list read outside any scope is
      // the bootstrap organization's list applied to everybody: tenants that configured
      // more offsets silently lose the extra reminders, and tenants that configured fewer
      // get reminders they never asked for.
      for (const [organizationId, group] of groupByOrganization(bookings)) {
        // Checked before the scope is opened, and returned from rather than broken out of
        // below: `runWithOrganization` costs a tenant scope and a settings read per group,
        // and a `break` in the innermost loop leaves the two loops above it — and every
        // remaining organization in this page — still running once the budget is spent.
        if (requeued >= BATCH) break;

        await runWithOrganization(organizationId, this.prisma, async () => {
          const offsets = this.reminders.offsets();

          for (const booking of group) {
            for (const offsetMinutes of offsets) {
              if (requeued >= BATCH) return;

              const delay = booking.startsAt.getTime() - offsetMinutes * 60_000 - now.getTime();
              if (delay <= 0) continue;

              const sentKey = dedupeKey(
                'REMINDER_24H',
                'EMAIL',
                booking.id,
                this.reminders.reminderDedupeDiscriminator(offsetMinutes, booking.startsAt),
              );

              if (alreadyHandled.has(sentKey)) continue;

              const jobId = reminderJobId(offsetMinutes, booking.id, booking.startsAt);
              if ((await queue.getJob(jobId)) !== undefined) continue;

              await this.enqueue.enqueue(
                JOB.REMINDER_SEND,
                {
                  organizationId: booking.organizationId,
                  bookingId: booking.id,
                  offsetMinutes,
                  expectedStartsAtEpochSeconds: startsAtEpochSeconds(booking.startsAt),
                },
                { jobId, delay },
              );

              requeued += 1;
            }
          }
        });
      }

      cursor = bookings.at(-1)?.id;
      if (bookings.length < BATCH || cursor === undefined) break;
    }

    if (requeued > 0) {
      this.logger.warn(`rebuilt ${String(requeued)} missing reminders`);
    }

    return requeued;
  }
}
