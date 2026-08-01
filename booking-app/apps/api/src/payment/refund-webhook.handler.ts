import { Injectable, Logger } from '@nestjs/common';

import { RefundService } from './refund.service.js';

import type { RefundStatusValue } from '../providers/payment/payment-provider.js';

/**
 * Stripe refund events this application acts on.
 *
 * `charge.refunded` is the one that can arrive *before* the API response that created the
 * refund, which is why settlement has to be able to match on our own idempotency key.
 */
export const REFUND_EVENT_TYPES = {
  CHARGE_REFUNDED: 'charge.refunded',
  REFUND_UPDATED: 'refund.updated',
  REFUND_FAILED: 'refund.failed',
} as const;

/** The fields this reads out of a Stripe refund object. Narrowed, not trusted. */
interface RefundObjectShape {
  id?: unknown;
  status?: unknown;
  amount?: unknown;
  metadata?: unknown;
  refunds?: { data?: unknown[] };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Translates a refund webhook into a settlement.
 *
 * Kept apart from the Stripe event processor so the two concerns stay separable: that one
 * decides which booking an event is about, this one decides what a refund event means.
 */
@Injectable()
export class RefundWebhookHandler {
  private readonly logger = new Logger('RefundWebhook');

  constructor(private readonly refunds: RefundService) {}

  /** True when this handler owns the event type. */
  handles(type: string): boolean {
    return (Object.values(REFUND_EVENT_TYPES) as string[]).includes(type);
  }

  async handle(type: string, object: unknown): Promise<void> {
    const refunds = this.refundObjectsFrom(type, object);

    if (refunds.length === 0) {
      this.logger.debug(`${type} carried no refund object; nothing to apply`);
      return;
    }

    for (const refund of refunds) {
      const stripeRefundId = readString(refund.id);
      if (stripeRefundId === undefined) continue;

      await this.refunds.applyProviderUpdate({
        stripeRefundId,
        status: normaliseStatus(refund.status),
        amountCents: typeof refund.amount === 'number' ? refund.amount : 0,
      });
    }
  }

  /**
   * Where the refund objects live, which differs by event type.
   *
   * `charge.refunded` sends the *charge*, with its refunds nested; the refund events send
   * the refund itself. Handling both here keeps the difference in one place.
   */
  private refundObjectsFrom(type: string, object: unknown): RefundObjectShape[] {
    const shape = (object ?? {}) as RefundObjectShape;

    if (type !== REFUND_EVENT_TYPES.CHARGE_REFUNDED) return [shape];

    const nested = shape.refunds?.data;
    return Array.isArray(nested) ? (nested as RefundObjectShape[]) : [];
  }
}

/**
 * Narrow Stripe's refund status, biased towards not claiming success.
 *
 * An unrecognised value becomes `pending`, never `succeeded`: settling a refund we do not
 * understand would tell the accounting that money went back when it may not have.
 */
function normaliseStatus(value: unknown): RefundStatusValue {
  switch (value) {
    case 'succeeded':
    case 'failed':
    case 'canceled':
    case 'pending':
      return value;
    default:
      return 'pending';
  }
}
