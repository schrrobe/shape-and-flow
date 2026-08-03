import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { withSerializationRetry } from '../common/prisma-errors/serialization-retry.js';
import { Money } from '../domain/money/money.js';
import { OutboxRecorder } from '../messaging/outbox/outbox.recorder.js';
import { JOB } from '../messaging/queues/job-contracts.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PaymentStatus } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PAYMENT_PROVIDER } from '../providers/payment/payment-provider.js';

import type { Booking } from '../prisma/client.js';
import type { PaymentProvider } from '../providers/payment/payment-provider.js';

export interface CheckoutUrls {
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  checkoutUrl: string;
  sessionId: string;
}

/**
 * Opens the hosted payment page for a reservation, and records that it exists.
 *
 * The ordering here is the whole design. Creating a Checkout Session is a network
 * call to Stripe: it can hang, it can time out after succeeding, and it must
 * therefore never happen inside a database transaction — a transaction held open
 * across a third-party call holds the reservation's row locks for as long as Stripe
 * takes to answer.
 *
 * So: reserve (transaction one, already committed), call Stripe (no transaction),
 * then attach the result (transaction two). The gap between the call and the attach
 * is real and is handled rather than avoided — if the process dies there, the
 * session exists at Stripe but no local row names it, and the reservation simply
 * expires. `clientReferenceId` carries the booking id so a stray webhook can still
 * be correlated.
 */
@Injectable()
export class BookingCheckoutService {
  private readonly logger = new Logger('Checkout');

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly outbox: OutboxRecorder,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
  ) {}

  /**
   * Create the session and attach it to the booking.
   *
   * @param idempotencyKey the request's key, forwarded to the provider so a retried
   * creation returns the first session rather than opening a second one the customer
   * could pay twice into.
   */
  async createSessionForReservation(
    booking: Booking,
    urls: CheckoutUrls,
    customerEmail: string,
    idempotencyKey?: string,
  ): Promise<CheckoutResult> {
    const organization = this.organizations.get();

    if (booking.expiresAt === null) {
      throw new AppError('INTERNAL_ERROR', {
        message: 'A reservation without an expiry cannot open a checkout session.',
      });
    }

    const session = await this.payments.createCheckoutSession(
      {
        organizationId: organization.id,
        stripeAccountId: organization.stripeAccountId ?? undefined,
      },
      {
        bookingId: booking.id,
        // Always the booking id: the fallback correlation path when a session was
        // created but its id never reached the database.
        clientReferenceId: booking.id,
        amount: Money.fromCents(booking.priceCentsSnapshot, booking.currency),
        description: booking.serviceNameSnapshot,
        customerEmail,
        successUrl: urls.successUrl,
        cancelUrl: urls.cancelUrl,
        locale: booking.locale,
        expiresAt: booking.expiresAt,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
    );

    // `expiresAt` passed explicitly, so the guard above is what the type system carries
    // into `attach` rather than something it has to re-derive.
    await this.attach(booking, session.sessionId, booking.expiresAt);

    return { checkoutUrl: session.url, sessionId: session.sessionId };
  }

  /**
   * Transaction two: name the session, open a pending payment, arm the expiry.
   *
   * Short by design — no network call inside it. The outbox row is what schedules the
   * expiry job, so "the reservation exists" and "something will eventually release
   * it" commit together.
   */
  private async attach(booking: Booking, sessionId: string, expiresAt: Date): Promise<void> {
    // From the booking, not from the request context. The two must agree, and nothing here
    // checks that they do — so if the ambient context ever resolved a different
    // organization, the payment and outbox rows would land under the wrong tenant while
    // the booking row stayed under the right one.
    const { organizationId } = booking;

    await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          await tx.booking.update({
            where: { id: booking.id },
            data: { stripeCheckoutSessionId: sessionId },
          });

          // A payment row from the moment there is something to pay, so a webhook
          // arriving before anyone reads this booking has a row to upsert onto.
          await tx.payment.create({
            data: {
              organizationId,
              bookingId: booking.id,
              stripeCheckoutSessionId: sessionId,
              amountCents: booking.priceCentsSnapshot,
              currency: booking.currency,
              status: PaymentStatus.PENDING,
            },
          });

          // The delayed job that will start the expiry saga. Recorded rather than
          // enqueued directly, so a committed reservation always has a release
          // mechanism — an enqueue outside the transaction could be lost.
          await this.outbox.record(tx, {
            organizationId,
            aggregateType: 'Booking',
            aggregateId: booking.id,
            eventType: JOB.BOOKING_EXPIRY_REQUESTED,
            payload: { organizationId, bookingId: booking.id },
            // Due when the reservation lapses, not now. A non-nullable parameter rather
            // than a fallback: an outbox row without `availableAt` is due immediately, and
            // the expiry saga would release a reservation the customer is still paying for.
            availableAt: expiresAt,
          });
        }),
      'attach-checkout-session',
    );

    this.logger.debug(`session ${sessionId} attached to booking ${booking.reference}`);
  }
}
