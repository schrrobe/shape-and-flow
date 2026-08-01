import { Module } from '@nestjs/common';

import { BookingNotificationData } from './booking-notification-data.service.js';
import { NotificationReconciler } from './notification.reconciler.js';
import { NotificationService } from './notification.service.js';
import { BookingEventProcessor } from './processors/booking-event.processor.js';
import { MessagingEventProcessor } from './processors/messaging-event.processor.js';
import { NotificationSendProcessor } from './processors/notification-send.processor.js';
import { ReminderProcessor } from './processors/reminder.processor.js';
import { ReminderReconciler } from './reminder.reconciler.js';
import { ReminderService } from './reminder.service.js';

/**
 * Contacting people.
 *
 * Separate from BookingModule because the two fail differently: a booking either happens
 * or does not, while a notification is a provider conversation that may need retries and
 * whose failure must never roll back the thing it was announcing.
 */
@Module({
  providers: [
    NotificationService,
    NotificationReconciler,
    NotificationSendProcessor,
    BookingNotificationData,
    BookingEventProcessor,
    MessagingEventProcessor,
    ReminderService,
    ReminderProcessor,
    ReminderReconciler,
  ],
  exports: [
    NotificationService,
    NotificationReconciler,
    NotificationSendProcessor,
    BookingNotificationData,
    BookingEventProcessor,
    MessagingEventProcessor,
    ReminderService,
    ReminderProcessor,
    ReminderReconciler,
  ],
})
export class NotificationModule {}
