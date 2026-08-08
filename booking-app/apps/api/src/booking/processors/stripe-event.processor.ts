import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error.js';
import { CLOCK } from '../../domain/time/clock.js';
import { InboxRecorder } from '../../messaging/inbox/inbox.recorder.js';
import { OrganizationWebhookHandler } from '../../organization/organization-webhook.handler.js';
import { RefundWebhookHandler } from '../../payment/refund-webhook.handler.js';
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
  /** Unix seconds. When Stripe generated the event, which is close to when money moved. */
  created?: unknown;
  /**
   * The connected account this event was forwarded from, absent on a platform event.
   *
   * Read from the stored payload rather than threaded down from the HTTP layer, because
   * a job re-enqueued by the inbox reconciler has only the row to go on.
   */
  account?: unknown;
  data?: {
    object?: {
      id?: unknown;
      object?: unknown;
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

/** Stripe's `created`, in unix seconds, as an instant. Undefined when the field is absent. */
function eventTime(created: unknown): Date | undefined {
  return typeof created === 'number' && Number.isFinite(created)
    ? new Date(created * 1000)
    : undefined;
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
    private readonly refunds: RefundWebhookHandler,
    private readonly organizations: OrganizationWebhookHandler,
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
    const event = rawPayload as StripeEventShape;
    const object = event.data?.object ?? {};

    // Refund events are a separate concern: this class decides which booking an event is
    // about, and that one decides what a refund event means.
    if (this.refunds.handles(type)) {
      await this.refunds.handle(type, object);
      return;
    }

    // Same split as refunds: Connect account verification is a concern of the organization,
    // not the booking, so it is handed off rather than grown into this switch.
    if (this.organizations.handles(type)) {
      // The event time goes with it: `account.updated` snapshots are not delivered in
      // order, and the handler needs it to tell an older snapshot from a newer one.
      await this.organizations.handle(type, object, eventTime(event.created));
      return;
    }

    switch (type) {
      case HANDLED.COMPLETED:
      case HANDLED.ASYNC_SUCCEEDED:
        await this.confirmIfPaid(
          object,
          eventId,
          eventTime(event.created),
          readString(event.account),
        );
        return;

      case HANDLED.EXPIRED:
      case HANDLED.ASYNC_FAILED:
        await this.fail(object, eventId);
        return;

      // A PaymentIntent, not a Checkout Session: `object.id` is a `pi_…`, which no booking
      // or payment row is keyed on by session id. Resolved through the stored payment
      // instead, which is where the intent id was recorded on confirmation.
      case HANDLED.INTENT_FAILED:
        await this.failByPaymentIntent(object, eventId);
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
    eventCreatedAt: Date | undefined,
    stripeAccountId: string | undefined,
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

    // A paid Checkout Session always carries `amount_total`. Its absence is a broken
    // assumption, not a zero: `upsertPayment` would write `amountCents = 0`, and a payment
    // row worth nothing makes every later refund unrefundable while reporting the booking
    // as fully refunded. Throwing puts the job on BullMQ's retry and, eventually, in front
    // of an operator.
    if (typeof object.amount_total !== 'number') {
      throw new AppError('INTERNAL_ERROR', {
        message: `Paid session ${sessionId} carries no amount_total.`,
      });
    }

    const booking = await this.resolveBooking(sessionId, object.client_reference_id);

    const outcome = await this.confirmations.confirmPaid({
      bookingId: booking.id,
      sessionId,
      // Only consulted if the payment row still has to be created — the checkout path
      // normally wrote it, account and all, when it opened the session.
      ...(stripeAccountId === undefined ? {} : { stripeAccountId }),
      ...(readString(object.payment_intent) === undefined
        ? {}
        : { paymentIntentId: readString(object.payment_intent) }),
      ...(readString(object.latest_charge) === undefined
        ? {}
        : { chargeId: readString(object.latest_charge) }),
      amountTotalCents: object.amount_total,
      ...(readPaymentMethod(object.payment_method_types) === undefined
        ? {}
        : { paymentMethodType: readPaymentMethod(object.payment_method_types) }),
      // Stripe's own timestamp for the event, which is when the money moved. The local
      // clock is a fallback for a payload without one, and is by definition later.
      paidAt: eventCreatedAt ?? this.clock.now(),
      cause: { kind: 'WEBHOOK', reference: eventId },
    });

    if (outcome === 'PAID_AFTER_TERMINAL') {
      // Money for an appointment that no longer exists. There is no booking to confirm and
      // no customer-facing action that makes sense, so this is escalated rather than
      // handled: the office decides whether to refund or to re-book.
      this.logger.error(
        `payment.needs_manual_refund booking=${booking.id} session=${sessionId} event=${eventId}`,
      );
    }
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
   * Fail the booking behind a PaymentIntent.
   *
   * `payment_intent.payment_failed` carries a PaymentIntent, so `object.id` is a `pi_…`.
   * Treating it as a Checkout Session id — as the shared `fail` path does — looks up
   * `stripeCheckoutSessionId = pi_…`, finds nothing, and silently leaves the booking
   * waiting for a payment that already failed until the expiry saga releases it. The intent
   * id is recorded on the `Payment` row, which is the handle that does resolve.
   */
  private async failByPaymentIntent(
    object: NonNullable<NonNullable<StripeEventShape['data']>['object']>,
    eventId: string,
  ): Promise<void> {
    const paymentIntentId = readString(object.id);
    if (paymentIntentId === undefined) return;

    const payment = await this.prisma.payment.findUnique({
      where: { stripePaymentIntentId: paymentIntentId },
      select: { bookingId: true },
    });

    // Falls back to the booking id Stripe was given at session creation, for the case where
    // the intent failed before any payment row named it.
    const bookingId = payment?.bookingId ?? readString(object.client_reference_id);

    if (bookingId === undefined) {
      this.logger.debug(`no booking for payment intent ${paymentIntentId}; nothing to fail`);
      return;
    }

    await this.confirmations.markPaymentFailed({
      bookingId,
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
