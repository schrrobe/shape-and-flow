import { Module } from '@nestjs/common';

import { PaymentModule } from '../payment/payment.module.js';

import { BookingNotificationData } from './booking-notification-data.service.js';
import { NotificationReconciler } from './notification.reconciler.js';
import { NotificationService } from './notification.service.js';
import { BookingEventProcessor } from './processors/booking-event.processor.js';
import { MessagingEventProcessor } from './processors/messaging-event.processor.js';
import { NotificationSendProcessor } from './processors/notification-send.processor.js';
import { ReminderProcessor } from './processors/reminder.processor.js';
import { ReminderReconciler } from './reminder.reconciler.js';
import { ReminderService } from './reminder.service.js';
import { RequestNotificationService } from './request-notification.service.js';

/**
 * Contacting people.
 *
 * Separate from BookingModule because the two fail differently: a booking either happens
 * or does not, while a notification is a provider conversation that may need retries and
 * whose failure must never roll back the thing it was announcing.
 */
@Module({
  // For `BookingFinancialsService`: a message about a rescheduled booking has to name
  // the money on the row that was paid. One direction only — nothing in PaymentModule
  // composes a notification.
  imports: [PaymentModule],
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
    RequestNotificationService,
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
    RequestNotificationService,
  ],
})
export class NotificationModule {}
