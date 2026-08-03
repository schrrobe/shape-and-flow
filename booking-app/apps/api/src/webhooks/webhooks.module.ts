import { Module } from '@nestjs/common';

import { BookingModule } from '../booking/booking.module.js';
import { NotificationModule } from '../notification/notification.module.js';

import { MessagingWebhookController } from './messaging-webhook.controller.js';
import { StripeWebhookController } from './stripe-webhook.controller.js';

/**
 * Inbound provider events.
 *
 * No middleware here. The raw bytes come from Nest's `rawBody: true`, set where the
 * application is created — see src/webhooks/raw-body.ts for why a path-scoped raw
 * parser cannot work.
 */
@Module({
  imports: [BookingModule, NotificationModule],
  controllers: [StripeWebhookController, MessagingWebhookController],
})
export class WebhooksModule {}
