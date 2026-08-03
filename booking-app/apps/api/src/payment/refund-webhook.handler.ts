import { Injectable, Logger } from '@nestjs/common';

import { RefundService } from './refund.service.js';

import type { RefundStatusValue } from '../providers/payment/payment-provider.js';

/**
 * Stripe refund events this application acts on.
 *
 * `refund.created` is the one that can arrive *before* the API response that created the
 * refund, which is why settlement has to be able to match on our own idempotency key.
 *
 * `charge.refunded` is deliberately not here. Stripe stopped auto-expanding `refunds.data`
 * on the Charge object in API version 2022-11-15, and from 2024-10-28 documents the
 * `refund.*` family as the way to follow a refund's lifecycle. Subscribing to the charge
 * event would mean receiving a charge with no refund inside it — which the previous code
 * did: it read `refunds.data`, found nothing, and settled nothing while looking handled.
 */
const REFUND_EVENT_TYPES = {
  REFUND_CREATED: 'refund.created',
  REFUND_UPDATED: 'refund.updated',
  REFUND_FAILED: 'refund.failed',
} as const;

/** The fields this reads out of a Stripe refund object. Narrowed, not trusted. */
interface RefundObjectShape {
  id?: unknown;
  status?: unknown;
  amount?: unknown;
  metadata?: unknown;
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
    // Every event in REFUND_EVENT_TYPES carries the Refund object itself, so there is no
    // per-type unwrapping left to do.
    const refund = (object ?? {}) as RefundObjectShape;

    const stripeRefundId = readString(refund.id);

    if (stripeRefundId === undefined) {
      this.logger.debug(`${type} carried no refund id; nothing to apply`);
      return;
    }

    // Our own key, read back out of the metadata we set when creating the refund. Without
    // it the lookup can only match on `stripeRefundId`, and the whole reason settlement
    // accepts a second handle is the case where the event beats the API response that
    // stores that id — so the fallback would exist and never be reachable.
    const idempotencyKey = readIdempotencyKey(refund.metadata);

    await this.refunds.applyProviderUpdate({
      stripeRefundId,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      status: normaliseStatus(refund.status),
      amountCents: typeof refund.amount === 'number' ? refund.amount : 0,
    });
  }
}

/** The idempotency key we stored on the provider's refund, if it is there. */
function readIdempotencyKey(metadata: unknown): string | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  return readString((metadata as Record<string, unknown>).idempotencyKey);
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
