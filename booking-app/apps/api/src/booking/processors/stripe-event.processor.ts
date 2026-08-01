import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error.js';
import { CLOCK } from '../../domain/time/clock.js';
import { InboxRecorder } from '../../messaging/inbox/inbox.recorder.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BookingConfirmationService } from '../booking-confirmation.service.js';

import type { Clock } from '../../domain/time/clock.js';
import type { InboxRef } from '../../messaging/inbox/inbox.recorder.js';
import type { JobPayload } from '../../messaging/queues/job-contracts.js';
import type { JOB } from '../../messaging/queues/job-contracts.js';

/**
 * Event types this application acts on.
 *
 * Everything else is stored, marked processed and forgotten. That is not laziness:
 * Stripe sends dozens of types, an unhandled one left unprocessed would be re-enqueued
 * by the reconciler every two minutes forever, and the inbox row is the audit trail
 * either way.
 */
const HANDLED = {
  COMPLETED: 'checkout.session.completed',
  ASYNC_SUCCEEDED: 'checkout.session.async_payment_succeeded',
  ASYNC_FAILED: 'checkout.session.async_payment_failed',
  EXPIRED: 'checkout.session.expired',
  INTENT_FAILED: 'payment_intent.payment_failed',
} as const;

/** The subset of a Stripe event payload this reads. Narrowed rather than trusted. */
interface StripeEventShape {
  data?: {
    object?: {
      id?: unknown;
      client_reference_id?: unknown;
      payment_status?: unknown;
      amount_total?: unknown;
      payment_intent?: unknown;
      latest_charge?: unknown;
      last_payment_error?: { code?: unknown; message?: unknown };
      payment_method_types?: unknown;
      metadata?: unknown;
    };
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Turns a stored Stripe event into a booking decision.
 *
 * Reads the event from the inbox rather than from the job payload, which carries only
 * an id. That means a re-enqueued job always sees the event as it was received, and the
 * payload cannot be tampered with in transit through Redis.
 *
 * The booking is resolved from the session id, and the organization from the booking.
 * Never from event metadata: metadata is whatever was set when the session was created,
 * and treating it as authoritative would let a forged-but-signed event from a
 * compromised account name any tenant it liked.
 */
@Injectable()
export class StripeEventProcessor {
  private readonly logger = new Logger('StripeEvent');

  constructor(
    private readonly prisma: PrismaService,
    private readonly inbox: InboxRecorder,
    private readonly confirmations: BookingConfirmationService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async handle(payload: JobPayload<typeof JOB.STRIPE_EVENT>): Promise<void> {
    const ref: InboxRef = { kind: 'stripe', stripeEventId: payload.stripeEventId };

    const event = await this.prisma.stripeWebhookEvent.findUnique({
      where: { stripeEventId: payload.stripeEventId },
      select: { type: true, payload: true, processedAt: true },
    });

    if (event === null) {
      // Pruned by retention, or the job outlived its row. Nothing to do, and throwing
      // would have BullMQ retry forever.
      this.logger.warn(`event ${payload.stripeEventId} is not in the inbox; ignoring`);
      return;
    }

    // The cheap guard. Confirmation is idempotent anyway, but there is no reason to
    // re-run it for an event already handled.
    if (event.processedAt !== null) {
      this.logger.debug(`event ${payload.stripeEventId} already processed`);
      return;
    }

    try {
      await this.dispatch(event.type, event.payload, payload.stripeEventId);
      await this.inbox.markProcessed(ref);
    } catch (error) {
      // Recorded and rethrown: the row carries the reason for an operator, and the throw
      // is what makes BullMQ retry with backoff.
      await this.inbox.markFailed(ref, error);
      throw error;
    }
  }

  private async dispatch(type: string, rawPayload: unknown, eventId: string): Promise<void> {
    const object = (rawPayload as StripeEventShape).data?.object ?? {};

    switch (type) {
      case HANDLED.COMPLETED:
      case HANDLED.ASYNC_SUCCEEDED:
        await this.confirmIfPaid(object, eventId);
        return;

      case HANDLED.EXPIRED:
      case HANDLED.ASYNC_FAILED:
      case HANDLED.INTENT_FAILED:
        await this.fail(object, eventId);
        return;

      default:
        this.logger.debug(`no handler for ${type}; stored and marked processed`);
    }
  }

  /**
   * Confirm, but only on evidence of payment.
   *
   * `payment_status` is the field that says money moved. A completed session with
   * `unpaid` means the customer reached the end of an asynchronous method that has not
   * settled — confirming there would give away an appointment for nothing.
   */
  private async confirmIfPaid(
    object: NonNullable<NonNullable<StripeEventShape['data']>['object']>,
    eventId: string,
  ): Promise<void> {
    const sessionId = readString(object.id);
    if (sessionId === undefined) {
      throw new AppError('INTERNAL_ERROR', { message: 'Session event carries no session id.' });
    }

    if (object.payment_status !== 'paid') {
      this.logger.warn(
        `session ${sessionId} completed with payment_status=${String(object.payment_status)}; not confirming`,
      );
      return;
    }

    const booking = await this.resolveBooking(sessionId, object.client_reference_id);

    await this.confirmations.confirmPaid({
      bookingId: booking.id,
      sessionId,
      ...(readString(object.payment_intent) === undefined
        ? {}
        : { paymentIntentId: readString(object.payment_intent) }),
      ...(readString(object.latest_charge) === undefined
        ? {}
        : { chargeId: readString(object.latest_charge) }),
      amountTotalCents: typeof object.amount_total === 'number' ? object.amount_total : 0,
      ...(readPaymentMethod(object.payment_method_types) === undefined
        ? {}
        : { paymentMethodType: readPaymentMethod(object.payment_method_types) }),
      paidAt: this.clock.now(),
      cause: { kind: 'WEBHOOK', reference: eventId },
    });
  }

  private async fail(
    object: NonNullable<NonNullable<StripeEventShape['data']>['object']>,
    eventId: string,
  ): Promise<void> {
    const sessionId = readString(object.id);
    if (sessionId === undefined) return;

    const booking = await this.findBooking(sessionId, object.client_reference_id);

    // A session that expired for a booking already confirmed or already released is
    // ordinary. `markPaymentFailed` no-ops on anything but PENDING_PAYMENT.
    if (booking === null) {
      this.logger.debug(`no booking for session ${sessionId}; nothing to fail`);
      return;
    }

    await this.confirmations.markPaymentFailed({
      bookingId: booking.id,
      ...(readString(object.last_payment_error?.code) === undefined
        ? {}
        : { failureCode: readString(object.last_payment_error?.code) }),
      ...(readString(object.last_payment_error?.message) === undefined
        ? {}
        : { failureMessage: readString(object.last_payment_error?.message) }),
      cause: { kind: 'WEBHOOK', reference: eventId },
    });
  }

  /**
   * Find the booking this event is about.
   *
   * By session id first, then by `client_reference_id` — which is always the booking id.
   * That fallback exists for one specific failure: the session was created but the
   * process died before the id reached the database, so no row names it.
   */
  private async findBooking(
    sessionId: string,
    clientReferenceId: unknown,
  ): Promise<{ id: string } | null> {
    const bySession = await this.prisma.booking.findUnique({
      where: { stripeCheckoutSessionId: sessionId },
      select: { id: true },
    });

    if (bySession !== null) return bySession;

    const bookingId = readString(clientReferenceId);
    if (bookingId === undefined) return null;

    return await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true },
    });
  }

  private async resolveBooking(
    sessionId: string,
    clientReferenceId: unknown,
  ): Promise<{ id: string }> {
    const booking = await this.findBooking(sessionId, clientReferenceId);

    if (booking === null) {
      // Thrown rather than swallowed: a paid session with no booking is money taken for
      // nothing, and it has to reach somebody. The retry and then the poisoned report
      // are what make that happen.
      throw new AppError('NOT_FOUND', {
        message: `Paid session ${sessionId} matches no booking.`,
      });
    }

    return booking;
  }
}

/** Stripe reports a list; Phase 1 restricts Checkout to card, so the first is the one. */
function readPaymentMethod(value: unknown): string | undefined {
  return Array.isArray(value) ? readString(value[0]) : readString(value);
}
