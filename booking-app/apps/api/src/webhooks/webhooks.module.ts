import { Module } from '@nestjs/common';

import { BookingModule } from '../booking/booking.module.js';

import { StripeWebhookController } from './stripe-webhook.controller.js';

/**
 * Inbound provider events.
 *
 * No middleware here. The raw bytes come from Nest's `rawBody: true`, set where the
 * application is created — see src/webhooks/raw-body.ts for why a path-scoped raw
 * parser cannot work.
 */
@Module({
  imports: [BookingModule],
  controllers: [StripeWebhookController],
})
export class WebhooksModule {}
