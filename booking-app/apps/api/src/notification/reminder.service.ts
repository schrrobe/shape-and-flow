import { Inject, Injectable, Logger } from '@nestjs/common';

import { withSerializationRetry } from '../common/prisma-errors/serialization-retry.js';
import { CLOCK } from '../domain/time/clock.js';
import { ManagementTokenService } from '../manage/management-token.service.js';
import { EnqueueService } from '../messaging/queues/enqueue.service.js';
import { JOB, QUEUE, jobIdFor } from '../messaging/queues/job-contracts.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { BookingStatus } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { BookingNotificationData } from './booking-notification-data.service.js';
import { NotificationService } from './notification.service.js';

import type { Clock } from '../domain/time/clock.js';

export interface FireInput {
  bookingId: string;
  offsetMinutes: number;
  expectedStartsAtEpochSeconds: number;
}

export type FireOutcome = 'SENT' | 'SKIPPED';

/** Epoch *seconds*, which is what the job id and the payload both carry. */
function startsAtEpochSeconds(startsAt: Date): number {
  return Math.floor(startsAt.getTime() / 1000);
}

/**
 * The job id for one reminder.
 *
 * The appointment time is part of the id, and that is the whole trick. BullMQ silently
 * ignores an `add` whose job id already exists, so an id keyed only on the booking would
 * make the reminder for a *rescheduled* appointment vanish: the old job is still sitting in
 * the delayed set under that id. With the time in the id, a moved booking gets a new job,
 * and the stale one skips itself at fire time because the time no longer matches.
 *
 * Note the separator. The plan writes this id with colons; BullMQ reserves `:` as its key
 * separator and rejects it, so `jobIdFor` joins with `-`. The shape is otherwise the
 * plan's: `reminder-<offsetMinutes>-<bookingId>-<startsAtEpochSeconds>`.
 */
export function reminderJobId(offsetMinutes: number, bookingId: string, startsAt: Date): string {
  return jobIdFor('reminder', offsetMinutes, bookingId, startsAtEpochSeconds(startsAt));
}

/**
 * Schedules, cancels and fires appointment reminders.
 *
 * Two layers of correctness, because a delayed job is the least trustworthy thing in the
 * system: it lives in Redis for days, and anything can happen to the booking in the
 * meantime. The **job id** carries the appointment time so a reschedule cannot be
 * swallowed, and **`fire` re-reads the booking** and refuses unless it is still CONFIRMED
 * and still starts when the job was created for. That second check is what makes removal
 * best-effort rather than load-bearing: a reminder for a cancelled appointment is a phone
 * call to the office, so it must be impossible even if the job survives.
 */
@Injectable()
export class ReminderService {
  private readonly logger = new Logger('Reminder');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly organizations: OrganizationContextService,
    private readonly data: BookingNotificationData,
    private readonly tokens: ManagementTokenService,
    private readonly enqueue: EnqueueService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Enqueue a delayed job per configured offset.
   *
   * A non-positive delay is skipped rather than fired immediately. Somebody booking
   * tomorrow morning has not earned a "your appointment is in 24 hours" message that
   * arrives while they are still on the confirmation page.
   */
  async schedule(bookingId: string): Promise<{ scheduled: number; skipped: number }> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, organizationId: true, startsAt: true, status: true },
    });

    if (booking === null || booking.status !== BookingStatus.CONFIRMED) {
      this.logger.debug(`no reminders for ${bookingId}: not a confirmed booking`);
      return { scheduled: 0, skipped: 0 };
    }

    const now = this.clock.now().getTime();
    let scheduled = 0;
    let skipped = 0;

    for (const offsetMinutes of this.offsets()) {
      const delay = booking.startsAt.getTime() - offsetMinutes * 60_000 - now;

      if (delay <= 0) {
        skipped += 1;
        continue;
      }

      await this.enqueue.enqueue(
        JOB.REMINDER_SEND,
        {
          organizationId: booking.organizationId,
          bookingId: booking.id,
          offsetMinutes,
          expectedStartsAtEpochSeconds: startsAtEpochSeconds(booking.startsAt),
        },
        { jobId: reminderJobId(offsetMinutes, booking.id, booking.startsAt), delay },
      );

      scheduled += 1;
    }

    this.logger.debug(
      `reminders for ${bookingId}: ${String(scheduled)} scheduled, ${String(skipped)} skipped`,
    );

    return { scheduled, skipped };
  }

  /**
   * Remove the delayed jobs for a booking. Best-effort, on purpose.
   *
   * Every failure here is swallowed and logged at debug: the job may already have run, been
   * removed by a previous cancellation, or vanished with a flushed Redis. None of that is
   * worth failing a cancellation the customer just asked for, because `fire` re-validates
   * and would skip anyway. This exists to keep the delayed set tidy, not to prevent a wrong
   * message.
   */
  async cancelFor(bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { startsAt: true },
    });

    if (booking === null) return;

    const queue = this.enqueue.queue(QUEUE.NOTIFICATION);

    for (const offsetMinutes of this.offsets()) {
      const jobId = reminderJobId(offsetMinutes, bookingId, booking.startsAt);

      try {
        const job = await queue.getJob(jobId);
        await job?.remove();
      } catch (error) {
        this.logger.debug(
          `could not remove reminder ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Send one reminder, if the appointment it describes still exists as described.
   *
   * Both guards matter and they catch different things. The status check catches a booking
   * that was cancelled, completed or expired since the job was created. The time check
   * catches a *rescheduled* one, whose new job is already in the queue under a different
   * id — without it the customer would get a reminder for a time they no longer have.
   */
  async fire(input: FireInput): Promise<FireOutcome> {
    const booking = await this.data.load(input.bookingId);

    if (booking === null) return 'SKIPPED';

    if (booking.status !== BookingStatus.CONFIRMED) {
      this.logger.debug(`reminder skipped: ${input.bookingId} is ${booking.status}`);
      return 'SKIPPED';
    }

    if (startsAtEpochSeconds(booking.startsAt) !== input.expectedStartsAtEpochSeconds) {
      this.logger.debug(`reminder skipped: ${input.bookingId} no longer starts at that time`);
      return 'SKIPPED';
    }

    const settings = this.organizations.getSettings();

    // Distinct per offset as well as per time. Keying on the time alone — as the plan's
    // step describes — would make a 2-hour reminder dedupe into the 24-hour one already
    // sent for the same appointment, so a business configuring two offsets would silently
    // get one.
    const discriminator = `${String(input.offsetMinutes)}-${String(input.expectedStartsAtEpochSeconds)}`;

    await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          // A fresh token, minted inside the transaction that queues the message. The
          // plaintext from confirmation exists only once and is long gone by now, and a
          // reminder is exactly when somebody wants to cancel or move an appointment — a
          // link that cannot authenticate would send them hunting for an old email.
          const { token } = await this.tokens.issue(
            tx,
            booking.id,
            booking.organizationId,
            booking.endsAt,
          );

          const appointment = {
            ...this.data.appointmentData(booking),
            manageUrl: this.data.manageUrl(token),
          };

          await this.notifications.queue(tx, {
            organizationId: booking.organizationId,
            kind: 'REMINDER_24H',
            channel: 'EMAIL',
            locale: booking.locale,
            recipient: booking.customer.email,
            bookingId: booking.id,
            customerId: booking.customer.id,
            dedupeDiscriminator: discriminator,
            data: appointment,
          });

          if (settings.smsRemindersEnabled && booking.customer.phone !== null) {
            await this.notifications.queue(tx, {
              organizationId: booking.organizationId,
              kind: 'REMINDER_24H',
              channel: 'SMS',
              locale: booking.locale,
              recipient: booking.customer.phone,
              bookingId: booking.id,
              customerId: booking.customer.id,
              dedupeDiscriminator: discriminator,
              data: appointment,
            });
          }
        }),
      'reminder-fire',
    );

    return 'SENT';
  }

  /** The dedupe key a fired reminder would carry, for the reconciler to look for. */
  reminderDedupeDiscriminator(offsetMinutes: number, startsAt: Date): string {
    return `${String(offsetMinutes)}-${String(startsAtEpochSeconds(startsAt))}`;
  }

  /** Configured offsets, longest first, so the earliest reminder is scheduled first. */
  offsets(): number[] {
    return [...this.organizations.getSettings().reminderOffsetsMinutes].sort((a, b) => b - a);
  }
}
