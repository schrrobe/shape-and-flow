import { Inject, Injectable, Logger } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { withSerializationRetry } from '../common/prisma-errors/serialization-retry.js';
import { Money } from '../domain/money/money.js';
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

    await this.attach(booking, session.sessionId);

    return { checkoutUrl: session.url, sessionId: session.sessionId };
  }

  /**
   * Transaction two: name the session and open a pending payment.
   *
   * Short by design — no network call inside it — and safe to run twice on the same
   * pair. That matters because the caller retries: an attempt whose Checkout call
   * succeeded but whose attachment did not commit comes back with the very same
   * session id, and the provider's own idempotency key guarantees it. So the row lock
   * comes first, then both writes are conditional: the session id is set only if
   * absent, and the payment insert skips a duplicate rather than colliding on the
   * unique session column.
   *
   * A *different* session id on a booking that already has one is not a retry and is
   * refused. Two live Checkout sessions for one reservation is a customer who can pay
   * twice.
   *
   * Arming the expiry is no longer part of this. It commits with the reservation,
   * where it belongs: the hold exists from that moment, so its release has to as well.
   */
  private async attach(booking: Booking, sessionId: string): Promise<void> {
    // From the booking, not from the request context. The two must agree, and nothing here
    // checks that they do — so if the ambient context ever resolved a different
    // organization, the payment and outbox rows would land under the wrong tenant while
    // the booking row stayed under the right one.
    const { organizationId } = booking;

    await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          // Serialises two attempts at the same booking. Without it both could read a
          // null session id and both try to insert a payment.
          await tx.$queryRaw`SELECT id FROM bookings WHERE id = ${booking.id} FOR UPDATE`;

          const current = await tx.booking.findUniqueOrThrow({
            where: { id: booking.id },
            select: { stripeCheckoutSessionId: true },
          });

          if (
            current.stripeCheckoutSessionId !== null &&
            current.stripeCheckoutSessionId !== sessionId
          ) {
            throw new AppError('INTERNAL_ERROR', {
              message: 'Booking already has another Checkout session.',
            });
          }

          if (current.stripeCheckoutSessionId === null) {
            await tx.booking.update({
              where: { id: booking.id },
              data: { stripeCheckoutSessionId: sessionId },
            });
          }

          // A payment row from the moment there is something to pay, so a webhook
          // arriving before anyone reads this booking has a row to upsert onto.
          await tx.payment.createMany({
            skipDuplicates: true,
            data: [
              {
                organizationId,
                bookingId: booking.id,
                stripeCheckoutSessionId: sessionId,
                amountCents: booking.priceCentsSnapshot,
                currency: booking.currency,
                status: PaymentStatus.PENDING,
              },
            ],
          });

          // `skipDuplicates` hides a collision, so the row that survived is read back
          // and checked. A session id already attached to a different booking or a
          // different amount would otherwise pass silently.
          const payment = await tx.payment.findUniqueOrThrow({
            where: { stripeCheckoutSessionId: sessionId },
            select: { bookingId: true, amountCents: true, currency: true },
          });

          if (
            payment.bookingId !== booking.id ||
            payment.amountCents !== booking.priceCentsSnapshot ||
            payment.currency !== booking.currency
          ) {
            throw new AppError('INTERNAL_ERROR', {
              message: 'Checkout session is already attached to a different payment.',
            });
          }
        }),
      'attach-checkout-session',
    );

    this.logger.debug(`session ${sessionId} attached to booking ${booking.reference}`);
  }
}
