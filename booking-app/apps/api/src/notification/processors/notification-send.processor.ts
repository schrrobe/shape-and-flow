import { Injectable, Logger } from '@nestjs/common';

import { NotificationService } from '../notification.service.js';

import type { JOB, JobPayload } from '../../messaging/queues/job-contracts.js';

/**
 * Sends one queued notification.
 *
 * Thin because `send` already guards itself: it returns early for a row that is not
 * PENDING, so a redelivered job cannot send a second copy. A transient provider failure
 * propagates, which is what makes BullMQ retry.
 */
@Injectable()
export class NotificationSendProcessor {
  private readonly logger = new Logger('NotificationSend');

  constructor(private readonly notifications: NotificationService) {}

  async handle(payload: JobPayload<typeof JOB.NOTIFICATION_SEND>): Promise<void> {
    const outcome = await this.notifications.send(payload.notificationId);
    this.logger.debug(`notification ${payload.notificationId} ${outcome}`);
  }
}
