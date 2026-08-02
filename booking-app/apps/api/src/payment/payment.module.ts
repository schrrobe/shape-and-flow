import { Module } from '@nestjs/common';

import { AuditWriterModule } from '../booking/audit.module.js';

import { ManualPaymentService } from './manual-payment.service.js';
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
  imports: [AuditWriterModule],
  providers: [RefundService, RefundProcessor, RefundWebhookHandler, ManualPaymentService],
  exports: [RefundService, RefundProcessor, RefundWebhookHandler, ManualPaymentService],
})
export class PaymentModule {}
