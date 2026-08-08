import { Inject, Injectable, Logger } from '@nestjs/common';

import { withSerializationRetry } from '../common/prisma-errors/serialization-retry.js';
import { CLOCK } from '../domain/time/clock.js';
import { OutboxRecorder } from '../messaging/outbox/outbox.recorder.js';
import { JOB } from '../messaging/queues/job-contracts.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { BookingStatus, Prisma } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { accountOfRecordedPayment, PAYMENT_PROVIDER } from '../providers/payment/payment-provider.js';

import { BookingConfirmationService } from './booking-confirmation.service.js';
import { assertTransition } from './booking-status.machine.js';

import type { Clock } from '../domain/time/clock.js';
import type { PaymentProvider } from '../providers/payment/payment-provider.js';

export type BeginExpiryOutcome = 'BEGAN' | 'NOT_DUE' | 'NOT_APPLICABLE';
export type CompleteExpiryOutcome = 'EXPIRED' | 'CONFIRMED' | 'NOT_APPLICABLE';

/**
 * Releases an unpaid slot, but only once Stripe agrees nobody can still pay for it.
 *
 * The naive version — "expiresAt has passed, so free the slot" — has a race that costs
 * real money. The customer may be on Stripe's payment page at that exact moment. Free
 * the slot and their payment succeeds into a booking somebody else now holds; refuse to
 * free it and an abandoned checkout blocks the calendar forever.
 *
 * So it is two phases, with a persisted status between them:
 *
 *  1. `PENDING_PAYMENT → EXPIRING`. The slot **stays blocked** — EXPIRING is in the
 *     blocking set — and an outbox row asks for phase two.
 *  2. Ask Stripe to expire the session. Only its answer decides: expired means release,
 *     already-complete-and-paid means confirm instead.
 *
 * The intermediate status is what makes a crash safe. A process that dies mid-saga
 * leaves a booking that is still blocking and still visibly mid-expiry, which the
 * sweeper re-drives. Failure over-blocks a slot rather than double-booking one, and
 * that is the direction to fail in.
 */
@Injectable()
export class ExpiryService {
  private readonly logger = new Logger('Expiry');

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly confirmations: BookingConfirmationService,
    private readonly outbox: OutboxRecorder,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Phase one: claim the expiry without releasing anything.
   *
   * Guarded on both the status and the due time, inside the lock, so a delayed job that
   * fires early or twice cannot move a booking it has no business moving.
   */
  async beginExpiry(bookingId: string): Promise<BeginExpiryOutcome> {
    return await withSerializationRetry(async () => {
      const now = this.clock.now();

      return await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          { id: string; status: BookingStatus; expires_at: Date | null }[]
        >(
          Prisma.sql`SELECT id, status, expires_at FROM bookings WHERE id = ${bookingId} FOR UPDATE`,
        );

        const current = locked[0];
        if (current === undefined) return 'NOT_APPLICABLE';

        // Already confirmed, already expired, already anything else. The job is late,
        // which is normal and not an error.
        if (current.status !== BookingStatus.PENDING_PAYMENT) return 'NOT_APPLICABLE';

        if (current.expires_at === null || current.expires_at > now) return 'NOT_DUE';

        const booking = await tx.booking.findUniqueOrThrow({
          where: { id: bookingId },
          select: { organizationId: true },
        });

        assertTransition(current.status, BookingStatus.EXPIRING);

        // expiresAt is deliberately left in place: the CHECK constraint requires it to
        // be non-null while EXPIRING, and the sweeper uses it.
        await tx.booking.update({
          where: { id: bookingId },
          data: { status: BookingStatus.EXPIRING },
        });

        await tx.bookingStatusHistory.create({
          data: {
            organizationId: booking.organizationId,
            bookingId,
            fromStatus: current.status,
            toStatus: BookingStatus.EXPIRING,
            actorType: 'SYSTEM',
            reason: 'reservation lapsed',
          },
        });

        await this.outbox.record(tx, {
          organizationId: booking.organizationId,
          aggregateType: 'Booking',
          aggregateId: bookingId,
          eventType: JOB.BOOKING_EXPIRY_REQUESTED,
          payload: { organizationId: booking.organizationId, bookingId },
        });

        return 'BEGAN';
      });
    }, 'begin-expiry');
  }

  /**
   * Phase two: ask Stripe, then settle.
   *
   * The provider call happens outside any transaction — deliberately, and asserted by a
   * test. A transaction spanning it would hold the booking's row locks for as long as
   * Stripe takes, on the exact row a paying customer's webhook needs.
   *
   * Any thrown error propagates. That leaves the booking EXPIRING and the slot blocked,
   * which is correct: without Stripe's answer we do not know whether the customer paid,
   * and releasing on a guess is the one outcome that cannot be undone.
   */
  async completeExpiry(bookingId: string): Promise<CompleteExpiryOutcome> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, stripeCheckoutSessionId: true, organizationId: true },
    });

    if (booking === null) return 'NOT_APPLICABLE';

    if (booking.status === BookingStatus.CONFIRMED) return 'CONFIRMED';
    if (booking.status === BookingStatus.EXPIRED) return 'EXPIRED';
    if (booking.status !== BookingStatus.EXPIRING) return 'NOT_APPLICABLE';

    // No session was ever attached — Stripe failed, or the process died between
    // creating the session and recording it. There is nothing to ask, and nothing
    // anyone could have paid into.
    if (booking.stripeCheckoutSessionId === null) {
      this.logger.debug(`booking ${bookingId} has no session; expiring directly`);
      return await this.release(bookingId, 'no checkout session');
    }

    // Resolved from the booking's own organization rather than from ambient context. A
    // worker has no request to resolve a tenant from, and expiring a session against the
    // wrong Stripe account is not a mistake Stripe can undo.
    const organization = this.organizations.require(booking.organizationId);

    const result = await this.payments.expireCheckoutSession(
      {
        organizationId: organization.id,
        stripeAccountId: await this.accountOfSession(booking.stripeCheckoutSessionId),
      },
      booking.stripeCheckoutSessionId,
    );

    if (result.outcome === 'EXPIRED') {
      return await this.release(bookingId, 'checkout session expired');
    }

    // The customer paid while this job was in flight. Modelled as a result rather than
    // an error precisely so this branch is explicit.
    if (result.paymentStatus === 'paid') {
      return await this.confirmInstead(
        bookingId,
        booking.stripeCheckoutSessionId,
        booking.organizationId,
      );
    }

    // Complete but not paid: an asynchronous payment method slipped past the card-only
    // restriction, which is worth knowing about. The slot is released — nothing has
    // settled and nothing is going to.
    this.logger.warn(
      `session ${booking.stripeCheckoutSessionId} is complete but ${result.paymentStatus}; releasing the slot`,
    );

    return await this.release(bookingId, `session complete but ${result.paymentStatus}`);
  }

  /** EXPIRING → EXPIRED, releasing the slot. */
  private async release(bookingId: string, reason: string): Promise<'EXPIRED'> {
    await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<{ status: BookingStatus }[]>(
            Prisma.sql`SELECT status FROM bookings WHERE id = ${bookingId} FOR UPDATE`,
          );

          const current = locked[0];

          // Re-checked under the lock: the webhook may have confirmed this booking
          // while we were talking to Stripe, and it wins.
          if (current?.status !== BookingStatus.EXPIRING) return;

          const booking = await tx.booking.findUniqueOrThrow({
            where: { id: bookingId },
            select: { organizationId: true },
          });

          assertTransition(current.status, BookingStatus.EXPIRED);

          await tx.booking.update({
            where: { id: bookingId },
            // Cleared now: the CHECK constraint allows expiresAt only while pending or
            // expiring, and this is where the slot is actually released.
            data: { status: BookingStatus.EXPIRED, expiresAt: null },
          });

          await tx.bookingStatusHistory.create({
            data: {
              organizationId: booking.organizationId,
              bookingId,
              fromStatus: current.status,
              toStatus: BookingStatus.EXPIRED,
              actorType: 'SYSTEM',
              reason,
            },
          });
        }),
      'release-expiry',
    );

    return 'EXPIRED';
  }

  /**
   * The customer paid after all.
   *
   * Delegated to the same confirmation service the webhook uses, so both paths produce
   * one payment, one management token and one history row no matter which arrives first.
   */
  private async confirmInstead(
    bookingId: string,
    sessionId: string,
    organizationId: string,
  ): Promise<'CONFIRMED'> {
    const organization = this.organizations.require(organizationId);
    const stripeAccountId = await this.accountOfSession(sessionId);

    const session = await this.payments.retrieveCheckoutSession(
      { organizationId: organization.id, stripeAccountId },
      sessionId,
    );

    this.logger.log(`booking ${bookingId} was paid during expiry; confirming instead`);

    await this.confirmations.confirmPaid({
      bookingId,
      sessionId,
      ...(stripeAccountId === undefined ? {} : { stripeAccountId }),
      ...(session.paymentIntentId === undefined
        ? {}
        : { paymentIntentId: session.paymentIntentId }),
      ...(session.chargeId === undefined ? {} : { chargeId: session.chargeId }),
      amountTotalCents: session.amountTotalCents,
      ...(session.paymentMethodType === undefined
        ? {}
        : { paymentMethodType: session.paymentMethodType }),
      // Discovery time, not settlement time. A retrieved Checkout Session carries no
      // timestamp for when the payment cleared — its `created` is when the session was
      // opened, which is before payment — so there is nothing more accurate to use here.
      // The webhook path, which does see the event's own timestamp, uses that instead.
      paidAt: this.clock.now(),
      cause: { kind: 'EXPIRY_SAGA', reference: sessionId },
    });

    return 'CONFIRMED';
  }

  /**
   * The Stripe account this Checkout Session was opened on.
   *
   * Read from the payment row rather than from the organization, because the two can
   * disagree: an organization that completed Connect onboarding after this session was
   * created now resolves to its own account, while the session still only exists on the
   * platform account. Expiring or retrieving it against the wrong account is a 404 from
   * Stripe and a booking that never gets released.
   *
   * A missing row means the session was created but the transaction that records it did
   * not commit — nothing was ever payable, so the platform account is the only account
   * it could have been on.
   */
  private async accountOfSession(sessionId: string): Promise<string | undefined> {
    const payment = await this.prisma.payment.findUnique({
      where: { stripeCheckoutSessionId: sessionId },
      select: { stripeAccountId: true },
    });

    if (payment === null) {
      this.logger.warn(`no payment row for session ${sessionId}; assuming the platform account`);
      return undefined;
    }

    return accountOfRecordedPayment(payment);
  }
}
