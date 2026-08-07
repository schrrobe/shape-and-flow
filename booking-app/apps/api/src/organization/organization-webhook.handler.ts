import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Stripe Connect account events this application acts on.
 *
 * `account.updated` is the only one Phase 1 cares about: it is how Stripe reports that
 * a merchant's onboarding — details submitted, charges enabled — has moved. There is no
 * synchronous signal for this; it only ever arrives through the webhook.
 */
const ACCOUNT_EVENT_TYPES = {
  UPDATED: 'account.updated',
} as const;

/** The fields this reads out of a Stripe Connect Account object. Narrowed, not trusted. */
interface AccountObjectShape {
  id?: unknown;
  details_submitted?: unknown;
  charges_enabled?: unknown;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Translates Stripe Connect's `account.updated` event into Organization's verification
 * flags.
 *
 * Kept apart from the Stripe event processor for the same reason `RefundWebhookHandler`
 * is: that class decides which booking (here, organization) an event is about, this one
 * decides what the event means.
 */
@Injectable()
export class OrganizationWebhookHandler {
  private readonly logger = new Logger('OrganizationWebhook');

  constructor(private readonly prisma: PrismaService) {}

  /** True when this handler owns the event type. */
  handles(type: string): boolean {
    return (Object.values(ACCOUNT_EVENT_TYPES) as string[]).includes(type);
  }

  async handle(type: string, object: unknown): Promise<void> {
    const account = (object ?? {}) as AccountObjectShape;
    const stripeAccountId = readString(account.id);

    if (stripeAccountId === undefined) {
      this.logger.debug(`${type} carried no account id; nothing to apply`);
      return;
    }

    // Looked up before writing, the same way RefundService.applyProviderUpdate resolves a
    // refund before settling it: every Organization column here is nullable/defaulted, and
    // an account id with no matching row (a stale account, a row pruned) is ordinary, not
    // exceptional. A bare `update` would throw Prisma's "record not found" and, through the
    // inbox's markFailed/retry path, put a harmless mismatch in front of an operator forever.
    const organization = await this.prisma.organization.findUnique({
      where: { stripeAccountId },
      select: { id: true },
    });

    if (organization === null) {
      this.logger.warn(`no organization matches stripe account ${stripeAccountId}; ignoring`);
      return;
    }

    await this.prisma.organization.update({
      where: { stripeAccountId },
      data: {
        stripeDetailsSubmitted: account.details_submitted === true,
        stripeChargesEnabled: account.charges_enabled === true,
      },
    });
  }
}
