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

  /**
   * @param eventCreatedAt Stripe's own timestamp for the event. Undefined only for a
   *   payload without one, which is treated as "no ordering information" and applied.
   */
  async handle(type: string, object: unknown, eventCreatedAt?: Date): Promise<void> {
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

    // `updateMany` with a time predicate, not `update`. Stripe does not order webhook
    // deliveries and the webhook queue runs several jobs at once, so an older snapshot of
    // this account can reach this line after a newer one. Applied unconditionally, that
    // older snapshot wins: an organizer that just became ready is switched back off, or —
    // worse — one that Stripe has just disabled is switched back on and takes money onto
    // an account that cannot settle it.
    //
    // `lte` rather than `lt`. Stripe's `created` has one-second resolution, and two
    // `account.updated` events for the same account in the same second are routine — for
    // example `card_payments` and `transfers` activating together at the end of Express
    // onboarding. With `lt`, the second event of such a pair matches neither branch of the
    // OR (its `created` equals, not exceeds, the row's `stripeAccountUpdatedAt`), so the
    // write is skipped, the organization is stuck wherever the first event left it, and a
    // dashboard resend of the same event replays the same `created` and is dropped again —
    // there is no recovery short of a manual UPDATE. `lte` accepts same-second events in
    // delivery order, which reintroduces the flapping the old comment was guarding against
    // when two same-second events genuinely disagree and arrive out of order — but that
    // flap self-heals the moment either event is redelivered, where the `lt` failure mode
    // does not heal at all. Ordering on (created, event id) would remove the flap too, but
    // needs the event id threaded through this call; not done here since `lte` alone fixes
    // the failure this guard exists to prevent.
    const { count } = await this.prisma.organization.updateMany({
      where: {
        stripeAccountId,
        ...(eventCreatedAt === undefined
          ? {}
          : {
              OR: [
                { stripeAccountUpdatedAt: null },
                { stripeAccountUpdatedAt: { lte: eventCreatedAt } },
              ],
            }),
      },
      data: {
        stripeDetailsSubmitted: account.details_submitted === true,
        stripeChargesEnabled: account.charges_enabled === true,
        ...(eventCreatedAt === undefined ? {} : { stripeAccountUpdatedAt: eventCreatedAt }),
      },
    });

    if (count === 0) {
      // Not an error, and deliberately not rethrown: a superseded snapshot is a normal
      // consequence of concurrent delivery, and failing the job would retry it forever
      // against a row that is already more current than the event. Logged at `warn`, not
      // `debug`: this is a payment-capability event (stripeChargesEnabled, potentially) that
      // was discarded rather than applied, and that is worth seeing in production logs by
      // default rather than only when someone happens to be looking with debug on.
      this.logger.warn(
        `${type} for ${stripeAccountId} is older than the stored state; ignoring`,
      );
    }
  }
}
