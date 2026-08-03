import { Injectable, Logger } from '@nestjs/common';

import { ReminderService } from '../reminder.service.js';

import type { JobPayload } from '../../messaging/queues/job-contracts.js';
import type { JOB } from '../../messaging/queues/job-contracts.js';

/**
 * Runs the two reminder jobs.
 *
 * Thin on purpose: every decision about whether a reminder should still go out lives in
 * `ReminderService.fire`, where it can be tested without a queue. What belongs here is the
 * distinction between a job that failed and one that correctly did nothing — a skipped
 * reminder must not be retried, so it returns rather than throws.
 */
@Injectable()
export class ReminderProcessor {
  private readonly logger = new Logger('ReminderProcessor');

  constructor(private readonly reminders: ReminderService) {}

  /** `reminder.schedule` — enqueue the delayed jobs for one booking. */
  async schedule(payload: JobPayload<(typeof JOB)['REMINDER_SCHEDULE']>): Promise<void> {
    const { scheduled, skipped } = await this.reminders.schedule(payload.bookingId);

    this.logger.debug(
      `scheduled ${String(scheduled)} reminders for ${payload.bookingId} (${String(skipped)} past due)`,
    );
  }

  /** `reminder.send` — send it, unless the appointment has moved or gone. */
  async send(payload: JobPayload<(typeof JOB)['REMINDER_SEND']>): Promise<void> {
    const outcome = await this.reminders.fire({
      bookingId: payload.bookingId,
      offsetMinutes: payload.offsetMinutes,
      expectedStartsAtEpochSeconds: payload.expectedStartsAtEpochSeconds,
    });

    if (outcome === 'SKIPPED') {
      this.logger.debug(`reminder for ${payload.bookingId} no longer applies`);
    }
  }
}
