import { Module } from '@nestjs/common';

import { RefundProcessor } from './processors/refund.processor.js';
import { RefundWebhookHandler } from './refund-webhook.handler.js';
import { RefundService } from './refund.service.js';

/**
 * Money movement after the fact: refunds, and the events that settle them.
 *
 * Separate from BookingModule because the lifecycle that *decides* to refund and the
 * mechanism that *performs* one fail differently and are retried differently. A
 * cancellation is a business decision that either happens or does not; a refund is a
 * provider conversation that may need many attempts with the same idempotency key.
 */
@Module({
  providers: [RefundService, RefundProcessor, RefundWebhookHandler],
  exports: [RefundService, RefundProcessor, RefundWebhookHandler],
})
export class PaymentModule {}
