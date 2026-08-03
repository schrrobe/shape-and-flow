import { Inject, Injectable, Logger } from '@nestjs/common';

import { isUniqueViolation } from '../../common/prisma-errors/prisma-errors.js';
import { CLOCK } from '../../domain/time/clock.js';
import { PrismaService } from '../../prisma/prisma.service.js';

import type { Clock } from '../../domain/time/clock.js';
import type { Prisma, WebhookProvider } from '../../prisma/client.js';

/**
 * How a stored event is addressed.
 *
 * A discriminated union rather than the plan's `(kind, providerEventId)` pair,
 * because a messaging event is keyed on `(provider, providerEventId)` — the same
 * id can legitimately arrive from Resend and from Twilio. The pair version makes
 * that call impossible to write correctly, and this one makes it impossible to
 * write incorrectly.
 */
export type InboxRef =
  | { kind: 'stripe'; stripeEventId: string }
  | { kind: 'messaging'; provider: WebhookProvider; providerEventId: string };

export type RecordOutcome =
  { outcome: 'RECORDED'; rowId: string } | { outcome: 'DUPLICATE'; rowId: null };

/** Truncated so a provider's verbose error cannot fill the column. */
const MAX_ERROR_LENGTH = 1000;

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
}

/**
 * Durably records an inbound webhook before anything acts on it.
 *
 * Providers retry. Stripe will deliver the same event again if our response is
 * slow, a 500, or lost, and the second delivery must not confirm a booking twice.
 * So the row is written first, keyed on the provider's own event id, and the unique
 * constraint is what makes the second delivery a no-op — not a check in
 * application code, which would race against a concurrent delivery of the same
 * event.
 *
 * The insert is attempted and the violation caught, rather than checked for first,
 * for exactly that reason: two deliveries arriving together would both pass a
 * check-then-insert and both proceed.
 */
@Injectable()
export class InboxRecorder {
  private readonly logger = new Logger('Inbox');

  constructor(
    // The root client, deliberately. An inbound webhook has no organization yet —
    // the tenant is resolved afterwards, from the booking the event refers to — so
    // there is nothing for the tenant guard to scope by, and the filter that makes
    // these queries safe is the provider's event id. Both tables have a nullable
    // organizationId for the same reason and are excluded from ORG_SCOPED_MODELS.
    private readonly prisma: PrismaService,
    // The application's clock, matching the outbox: `receivedAt` is written by
    // Prisma's client-side `@default(now())`, so the timestamps on these rows are
    // application timestamps and must be compared against an application clock.
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async recordStripe(event: {
    id: string;
    type: string;
    apiVersion?: string;
    payload: unknown;
  }): Promise<RecordOutcome> {
    try {
      const row = await this.prisma.stripeWebhookEvent.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          ...(event.apiVersion === undefined ? {} : { apiVersion: event.apiVersion }),
          payload: event.payload as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      return { outcome: 'RECORDED', rowId: row.id };
    } catch (error) {
      if (!isUniqueViolation(error, 'stripeEventId')) throw error;

      this.logger.debug(`stripe event ${event.id} already recorded`);
      return { outcome: 'DUPLICATE', rowId: null };
    }
  }

  async recordMessaging(
    provider: WebhookProvider,
    event: { id: string; type: string; payload: unknown },
  ): Promise<RecordOutcome> {
    try {
      const row = await this.prisma.messagingWebhookEvent.create({
        data: {
          provider,
          providerEventId: event.id,
          type: event.type,
          payload: event.payload as Prisma.InputJsonValue,
        },
        select: { id: true },
      });

      return { outcome: 'RECORDED', rowId: row.id };
    } catch (error) {
      if (!isUniqueViolation(error, 'providerEventId')) throw error;

      this.logger.debug(`${provider} event ${event.id} already recorded`);
      return { outcome: 'DUPLICATE', rowId: null };
    }
  }

  /**
   * Mark an event handled.
   *
   * `where` includes `processedAt: null`, so calling this twice leaves the first
   * timestamp in place. That matters because the timestamp is evidence of when the
   * event was actually acted on, and a redelivery should not rewrite history.
   *
   * An event of a type nothing handles is also marked processed. It genuinely has
   * been dealt with — by being ignored — and leaving it unprocessed would have the
   * reconciler re-enqueue it every two minutes forever. The `type` column already
   * records what it was.
   */
  async markProcessed(ref: InboxRef): Promise<void> {
    const at = this.clock.now();

    if (ref.kind === 'stripe') {
      await this.prisma.stripeWebhookEvent.updateMany({
        where: { stripeEventId: ref.stripeEventId, processedAt: null },
        data: { processedAt: at },
      });
      return;
    }

    await this.prisma.messagingWebhookEvent.updateMany({
      where: {
        provider: ref.provider,
        providerEventId: ref.providerEventId,
        processedAt: null,
      },
      data: { processedAt: at },
    });
  }

  /**
   * Record a failed attempt, leaving the event unprocessed so it is retried.
   *
   * `attempts` is incremented in the database rather than read and written back, so
   * two workers failing the same event concurrently cannot lose a count.
   */
  async markFailed(ref: InboxRef, error: unknown): Promise<void> {
    const lastError = describe(error);

    if (ref.kind === 'stripe') {
      await this.prisma.stripeWebhookEvent.updateMany({
        where: { stripeEventId: ref.stripeEventId },
        data: { attempts: { increment: 1 }, lastError },
      });
      return;
    }

    await this.prisma.messagingWebhookEvent.updateMany({
      where: { provider: ref.provider, providerEventId: ref.providerEventId },
      data: { attempts: { increment: 1 }, lastError },
    });
  }
}
