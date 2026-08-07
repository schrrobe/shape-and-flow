import { Body, Controller, Get, Headers, Inject, Logger, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { createBookingRequestSchema } from '@shape-and-flow/booking-contracts';

import { BookingCheckoutService } from '../booking/booking-checkout.service.js';
import { ReservationService } from '../booking/reservation.service.js';
import { AppError } from '../common/errors/app-error.js';
import { Public } from '../common/guards/public.decorator.js';
import { ENV } from '../config/env.schema.js';
import { Idempotent } from '../messaging/idempotency/idempotent.decorator.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { AppConfig } from '../config/env.schema.js';
import type {
  BookingBySessionResponse,
  CreateBookingResponse,
} from '@shape-and-flow/booking-contracts';

/**
 * Ten bookings an hour per IP.
 *
 * Each attempt reserves a slot for five minutes, so an unthrottled loop could hold a
 * whole day's calendar hostage without paying for anything.
 */
const CREATE_LIMIT = { default: { limit: 10, ttl: 3_600_000 } };

/** Reading a booking back is cheap and the landing page polls it. */
const READ_LIMIT = { default: { limit: 120, ttl: 60_000 } };

@Controller('public')
@Public()
export class PublicBookingsController {
  private readonly logger = new Logger('Bookings');

  constructor(
    private readonly reservations: ReservationService,
    private readonly checkout: BookingCheckoutService,
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  /**
   * Reserve a slot and open the payment page.
   *
   * `@Idempotent` is what makes this safe to retry, and it is doing more than
   * deduplication here: the stored response contains the Checkout URL, so a customer
   * who reloads mid-payment is returned to the session they already started instead of
   * a second one they could also pay into. The key is the only thing that will hand
   * that URL out again.
   */
  @Post('bookings')
  @Idempotent('booking.create')
  @Throttle(CREATE_LIMIT)
  async create(
    @Body() rawBody: unknown,
    @Headers('idempotency-key') idempotencyKey: string,
  ): Promise<CreateBookingResponse> {
    const body = createBookingRequestSchema.parse(rawBody);

    this.assertAllowedRedirect(body.successUrl);
    this.assertAllowedRedirect(body.cancelUrl);

    const organization = this.organizations.get();
    if (organization.stripeAccountId !== null && !organization.stripeChargesEnabled) {
      throw new AppError('ORGANIZATION_ONBOARDING_INCOMPLETE', {
        message: 'This organizer has not finished setting up payments yet.',
      });
    }

    // Resume first. An attempt that reserved and then failed at the provider left a
    // hold this key names; reserving again would ask for a slot the customer is
    // already holding and be refused SLOT_UNAVAILABLE by their own first attempt.
    const { booking, employee, price } =
      (await this.reservations.resume(idempotencyKey)) ??
      (await this.reservations.reserve({
        serviceId: body.serviceId,
        employeeId: body.employeeId ?? null,
        startsAt: new Date(body.startsAt),
        customer: { ...body.customer, locale: body.locale },
        locale: body.locale,
        idempotencyKey,
        ...(body.customerNote === undefined ? {} : { customerNote: body.customerNote }),
      }));

    const session = await this.openCheckout(booking, body, idempotencyKey);

    if (booking.expiresAt === null) {
      throw new AppError('INTERNAL_ERROR', { message: 'Reservation has no expiry.' });
    }

    return {
      bookingId: booking.id,
      reference: booking.reference,
      status: booking.status,
      employeeId: employee.id,
      employeeDisplayName: employee.displayName,
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      price: price.toJSON(),
      expiresAt: booking.expiresAt.toISOString(),
      checkoutUrl: session.checkoutUrl,
    };
  }

  /**
   * Post-Checkout landing poll.
   *
   * Reachable by anyone holding a session id, so it carries no customer data and no
   * management token — `managementUrlIssued` says whether the email's link exists
   * without being the link.
   */
  @Get('bookings/by-session/:checkoutSessionId')
  @Throttle(READ_LIMIT)
  async bySession(
    @Param('checkoutSessionId') sessionId: string,
  ): Promise<BookingBySessionResponse> {
    const organizationId = this.organizations.getOrganizationId();

    const booking = await this.prisma.booking.findFirst({
      where: { organizationId, stripeCheckoutSessionId: sessionId },
      select: {
        reference: true,
        status: true,
        startsAt: true,
        endsAt: true,
        serviceNameSnapshot: true,
        priceCentsSnapshot: true,
        currency: true,
        employee: { select: { displayName: true } },
        // A count, not the tokens: whether a link exists is safe to say, the link is
        // not.
        _count: { select: { managementTokens: true } },
      },
    });

    if (booking === null) {
      throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
    }

    return {
      reference: booking.reference,
      status: booking.status,
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      employeeDisplayName: booking.employee.displayName,
      serviceName: booking.serviceNameSnapshot,
      price: { amountCents: booking.priceCentsSnapshot, currency: booking.currency },
      managementUrlIssued: booking._count.managementTokens > 0,
    };
  }

  /**
   * Refuse a redirect target outside our own front end.
   *
   * Stripe will send the customer wherever these point after payment, so an
   * unchecked value is an open redirect with our domain's credibility attached to it.
   * Origin comparison, not prefix matching: `https://evil.com/?x=https://ours.com`
   * passes a naive `startsWith`.
   */
  private assertAllowedRedirect(url: string): void {
    const allowed = new URL(this.config.PUBLIC_WEB_ORIGIN).origin;

    let candidate: URL;
    try {
      candidate = new URL(url);
    } catch {
      throw new AppError('VALIDATION_FAILED', {
        message: 'successUrl and cancelUrl must be absolute URLs.',
      });
    }

    if (candidate.origin !== allowed) {
      throw new AppError('VALIDATION_FAILED', {
        message: `successUrl and cancelUrl must point at ${allowed}.`,
        details: { allowedOrigin: allowed },
      });
    }
  }

  /**
   * Open the session, turning a provider failure into a 502 rather than a 500.
   *
   * The distinction is not cosmetic. The reservation has committed by this point, so
   * the honest report is "we held your slot but could not reach the payment provider"
   * — and 502 says that. The idempotency interceptor abandons the key on any failure,
   * so the customer's retry genuinely retries; the orphaned reservation expires on its
   * own five minutes later.
   */
  private async openCheckout(
    booking: Awaited<ReturnType<ReservationService['reserve']>>['booking'],
    body: { successUrl: string; cancelUrl: string; customer: { email: string } },
    idempotencyKey: string,
  ): Promise<{ checkoutUrl: string }> {
    try {
      return await this.checkout.createSessionForReservation(
        booking,
        { successUrl: body.successUrl, cancelUrl: body.cancelUrl },
        body.customer.email,
        idempotencyKey,
      );
    } catch (error) {
      // Logged with the booking id, because the orphan is otherwise only findable by
      // scanning for reservations with no session.
      this.logger.error(
        `checkout session failed for booking ${booking.id} (${booking.reference}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      throw new AppError('INTERNAL_ERROR', {
        status: 502,
        message: 'The payment provider is unavailable. Your slot was not charged; please retry.',
        cause: error,
      });
    }
  }
}
