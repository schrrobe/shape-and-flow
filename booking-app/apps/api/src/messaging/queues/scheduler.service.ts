import { Injectable, Logger } from '@nestjs/common';

import { EnqueueService } from './enqueue.service.js';
import { JOB, QUEUE } from './job-contracts.js';

import type { JobName } from './job-contracts.js';

/** The business timezone, so a nightly job runs at 03:00 local across DST changes. */
const SCHEDULE_ZONE = 'Europe/Berlin';

interface Cadence {
  job: JobName;
  /** Milliseconds between runs, for the frequent sweeps. */
  every?: number;
  /** A cron pattern in `SCHEDULE_ZONE`, for the nightly ones. */
  pattern?: string;
}

/**
 * The maintenance schedule.
 *
 * The frequent ones are recovery paths: a lost job, a crashed worker, a Redis flush. Their
 * cadence is a bound on how long a customer waits for something that should already have
 * happened — a reservation that is over but still blocks the slot, a confirmation email
 * still queued — which is why the two expiry sweeps are the fastest.
 *
 * The nightly ones are housekeeping and are staggered rather than all at 03:00: they compete
 * for the same database, and three sweeps starting together turn a quiet minute into a spike
 * for no benefit.
 */
export const SCHEDULE: readonly Cadence[] = [
  { job: JOB.SWEEP_EXPIRED_RESERVATIONS, every: 60_000 },
  { job: JOB.SWEEP_STUCK_EXPIRING, every: 60_000 },
  { job: JOB.SWEEP_INBOX, every: 2 * 60_000 },
  { job: JOB.SWEEP_OUTBOX, every: 5 * 60_000 },
  { job: JOB.SWEEP_NOTIFICATIONS, every: 5 * 60_000 },
  { job: JOB.SWEEP_REMINDERS, pattern: '0 3 * * *' },
  { job: JOB.SWEEP_IDEMPOTENCY_KEYS, pattern: '15 3 * * *' },
  { job: JOB.SWEEP_RETENTION, pattern: '30 3 * * *' },
];

/**
 * Installs the repeatable maintenance jobs.
 *
 * `upsertJobScheduler` rather than `add`: the scheduler id is the identity, so installing the
 * same schedule on every worker start updates one row instead of accumulating a duplicate
 * per deploy. That matters because every worker replica runs this — the alternative, electing
 * one to do it, adds a coordination problem to solve a problem BullMQ already solved.
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger('Scheduler');

  constructor(private readonly enqueue: EnqueueService) {}

  /** Upsert every entry in `SCHEDULE`. Idempotent. */
  async install(): Promise<void> {
    const queue = this.enqueue.queue(QUEUE.MAINTENANCE);

    for (const cadence of SCHEDULE) {
      await queue.upsertJobScheduler(
        cadence.job,
        cadence.every === undefined
          ? { pattern: cadence.pattern ?? '', tz: SCHEDULE_ZONE }
          : { every: cadence.every },
        // The job name has to be set explicitly: the scheduler id defaults to it, but the
        // router dispatches on the *job* name, and a job named after the scheduler id by
        // accident would be routed nowhere.
        { name: cadence.job, data: {} },
      );
    }

    this.logger.log(`installed ${String(SCHEDULE.length)} repeatable maintenance jobs`);
  }

  /** What is installed, for the start-up log line and the bootstrap test. */
  async installed(): Promise<{ name: string; every?: number; pattern?: string }[]> {
    const schedulers = await this.enqueue.queue(QUEUE.MAINTENANCE).getJobSchedulers();

    return schedulers.map((scheduler) => ({
      name: scheduler.name,
      ...(scheduler.every === undefined ? {} : { every: scheduler.every }),
      ...(scheduler.pattern === undefined ? {} : { pattern: scheduler.pattern }),
    }));
  }
}
