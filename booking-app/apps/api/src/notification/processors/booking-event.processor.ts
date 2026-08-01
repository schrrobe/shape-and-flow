import { Inject, Injectable, Logger } from '@nestjs/common';

import { withSerializationRetry } from '../../common/prisma-errors/serialization-retry.js';
import { ENV } from '../../config/env.schema.js';
import { Money } from '../../domain/money/money.js';
import { OrganizationContextService } from '../../organization/organization-context.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NotificationService } from '../notification.service.js';

import type { AppConfig } from '../../config/env.schema.js';
import type { Prisma } from '../../prisma/client.js';
import type { AppointmentData, CommonData } from '@shape-and-flow/booking-notification-templates';

/** Everything a notification about a booking needs, loaded once. */
const BOOKING_FOR_NOTIFICATION = {
  id: true,
  organizationId: true,
  reference: true,
  serviceNameSnapshot: true,
  startsAt: true,
  endsAt: true,
  priceCentsSnapshot: true,
  currency: true,
  locale: true,
  customerNote: true,
  status: true,
  employee: { select: { displayName: true } },
  customer: {
    select: { id: true, firstName: true, lastName: true, email: true, phone: true },
  },
  payments: { select: { status: true, amountCents: true, refundedAmountCents: true } },
} as const;

type BookingRow = Prisma.BookingGetPayload<{ select: typeof BOOKING_FOR_NOTIFICATION }>;

/**
 * Turns a booking event into the messages it implies.
 *
 * One transaction per event, so a customer email and an office email either both exist or
 * neither does — a confirmed booking the office never hears about is worse than one
 * nobody is told about at all.
 *
 * Dedupe does the idempotency work rather than a status check here. Processing
 * `booking.confirmed` twice runs this twice; the second run's `queue` calls hit the unique
 * index and return null, so the customer gets one email. That is what turns the outbox's
 * at-least-once job delivery into effectively-once contact.
 */
@Injectable()
export class BookingEventProcessor {
  private readonly logger = new Logger('BookingEvent');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly organizations: OrganizationContextService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  /** `booking.confirmed` — the customer's confirmation, and the office's copy. */
  async confirmed(payload: {
    organizationId: string;
    bookingId: string;
    managementToken?: string | undefined;
  }): Promise<void> {
    const booking = await this.load(payload.bookingId);
    if (booking === null) return;

    const settings = this.organizations.getSettings();

    await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const appointment = this.appointmentData(booking);

          await this.notifications.queue(tx, {
            organizationId: booking.organizationId,
            kind: 'BOOKING_CONFIRMATION',
            channel: 'EMAIL',
            locale: booking.locale,
            recipient: booking.customer.email,
            bookingId: booking.id,
            customerId: booking.customer.id,
            data: {
              ...appointment,
              manageUrl: this.manageUrl(payload.managementToken),
              freeCancellationUntil:
                settings.freeCancellationHours > 0
                  ? new Date(
                      booking.startsAt.getTime() - settings.freeCancellationHours * 3_600_000,
                    )
                  : null,
            },
          });

          // SMS only when the business has turned it on and the customer gave a number.
          // Sending to a missing number is a provider error; sending when it is switched
          // off is a bill the business did not agree to.
          if (settings.smsRemindersEnabled && booking.customer.phone !== null) {
            await this.notifications.queue(tx, {
              organizationId: booking.organizationId,
              kind: 'BOOKING_CONFIRMATION',
              channel: 'SMS',
              locale: booking.locale,
              recipient: booking.customer.phone,
              bookingId: booking.id,
              customerId: booking.customer.id,
              data: {
                ...appointment,
                manageUrl: this.manageUrl(payload.managementToken),
                freeCancellationUntil: null,
              },
            });
          }

          await this.notifications.queue(tx, {
            organizationId: booking.organizationId,
            kind: 'OFFICE_NEW_BOOKING',
            channel: 'EMAIL',
            // The office reads in the organization's own language, not the customer's.
            locale: this.organizations.get().defaultLocale,
            recipient: settings.officeNotificationEmail,
            bookingId: booking.id,
            data: {
              ...appointment,
              customerName: `${booking.customer.firstName} ${booking.customer.lastName}`,
              customerEmail: booking.customer.email,
              customerPhone: booking.customer.phone,
              customerNote: booking.customerNote,
            },
          });
        }),
      'notify-booking-confirmed',
    );
  }

  /** `booking.canceled` — who cancelled decides which template. */
  async canceled(payload: { organizationId: string; bookingId: string }): Promise<void> {
    const booking = await this.load(payload.bookingId);
    if (booking === null) return;

    const byBusiness = booking.status === 'CANCELED_BY_BUSINESS';
    const refunded = await this.refundedTotal(booking.id, booking.currency);

    await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          const appointment = this.appointmentData(booking);

          if (byBusiness) {
            await this.notifications.queue(tx, {
              organizationId: booking.organizationId,
              kind: 'BOOKING_CANCELED_BY_BUSINESS',
              channel: 'EMAIL',
              locale: booking.locale,
              recipient: booking.customer.email,
              bookingId: booking.id,
              customerId: booking.customer.id,
              data: {
                ...appointment,
                reason: 'siehe Nachricht',
                refundedCents: refunded.amountCents,
              },
            });
            return;
          }

          await this.notifications.queue(tx, {
            organizationId: booking.organizationId,
            kind: 'BOOKING_CANCELED_BY_CUSTOMER',
            channel: 'EMAIL',
            locale: booking.locale,
            recipient: booking.customer.email,
            bookingId: booking.id,
            customerId: booking.customer.id,
            data: {
              ...appointment,
              refundedCents: refunded.amountCents,
              // What was kept is what was paid minus what went back, and both numbers are
              // read from the rows rather than recomputed from the policy.
              retainedCents: this.paidTotal(booking).minus(refunded).amountCents,
            },
          });
        }),
      'notify-booking-canceled',
    );
  }

  /** `booking.rescheduled` — the new time, and a link that works. */
  async rescheduled(payload: {
    organizationId: string;
    bookingId: string;
    previousBookingId: string;
    managementToken?: string | undefined;
  }): Promise<void> {
    const booking = await this.load(payload.bookingId);
    const previous = await this.load(payload.previousBookingId);
    if (booking === null || previous === null) return;

    await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          await this.notifications.queue(tx, {
            organizationId: booking.organizationId,
            kind: 'BOOKING_RESCHEDULED',
            channel: 'EMAIL',
            locale: booking.locale,
            recipient: booking.customer.email,
            bookingId: booking.id,
            customerId: booking.customer.id,
            data: {
              ...this.appointmentData(booking),
              manageUrl: this.manageUrl(payload.managementToken),
              previousStartsAt: previous.startsAt,
            },
          });
        }),
      'notify-booking-rescheduled',
    );
  }

  /** `refund.succeeded` — the money is on its way back. */
  async refundSucceeded(payload: { organizationId: string; refundId: string }): Promise<void> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: payload.refundId },
      select: { id: true, bookingId: true, amountCents: true },
    });

    if (refund === null) return;

    const booking = await this.load(refund.bookingId);
    if (booking === null) return;

    await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          await this.notifications.queue(tx, {
            organizationId: booking.organizationId,
            kind: 'REFUND_ISSUED',
            channel: 'EMAIL',
            locale: booking.locale,
            recipient: booking.customer.email,
            bookingId: booking.id,
            customerId: booking.customer.id,
            // The refund id, so two partial refunds on one booking each get a message.
            dedupeDiscriminator: refund.id,
            data: { ...this.appointmentData(booking), refundedCents: refund.amountCents },
          });
        }),
      'notify-refund-succeeded',
    );
  }

  /** `booking.payment_failed` — nothing was charged, and the slot is gone. */
  async paymentFailed(payload: { organizationId: string; bookingId: string }): Promise<void> {
    const booking = await this.load(payload.bookingId);
    if (booking === null) return;

    await withSerializationRetry(
      () =>
        this.prisma.$transaction(async (tx) => {
          await this.notifications.queue(tx, {
            organizationId: booking.organizationId,
            kind: 'BOOKING_CANCELED_BY_BUSINESS',
            channel: 'EMAIL',
            locale: booking.locale,
            recipient: booking.customer.email,
            bookingId: booking.id,
            customerId: booking.customer.id,
            data: {
              ...this.appointmentData(booking),
              reason: 'Die Zahlung konnte nicht abgeschlossen werden',
              refundedCents: 0,
            },
          });
        }),
      'notify-payment-failed',
    );
  }

  /** The fields every appointment template shares. */
  private appointmentData(booking: BookingRow): AppointmentData {
    return {
      ...this.commonData(),
      reference: booking.reference,
      serviceName: booking.serviceNameSnapshot,
      employeeName: booking.employee.displayName,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      priceCents: booking.priceCentsSnapshot,
      currency: booking.currency,
      customerFirstName: booking.customer.firstName,
    };
  }

  private commonData(): CommonData {
    const organization = this.organizations.get();

    return {
      businessName: organization.name,
      businessPhone: organization.contactPhone,
      addressLine: `${organization.addressLine1}, ${organization.postalCode} ${organization.city}`,
      businessEmail: organization.contactEmail,
    };
  }

  /**
   * The management link.
   *
   * The token goes in the fragment, after `#`, so it never reaches a server log, a proxy
   * access log, or a `Referer` header — a fragment is not sent with the request. Without a
   * token the customer gets the booking page and has to find their email again, which is
   * the right failure: a link that half works is worse than one that is absent.
   */
  private manageUrl(token: string | undefined): string {
    const base = `${this.config.PUBLIC_WEB_ORIGIN}/manage`;
    return token === undefined ? base : `${base}#${token}`;
  }

  /** What actually arrived. Through Money, because the cent ban is right about this. */
  private paidTotal(booking: BookingRow): Money {
    return Money.sum(
      booking.payments
        .filter((payment) => payment.status !== 'PENDING' && payment.status !== 'FAILED')
        .map((payment) => Money.fromCents(payment.amountCents, booking.currency)),
      booking.currency,
    );
  }

  private async refundedTotal(bookingId: string, currency: string): Promise<Money> {
    const sum = await this.prisma.refund.aggregate({
      where: { bookingId, status: 'SUCCEEDED' },
      _sum: { amountCents: true },
    });

    return Money.fromCents(sum._sum.amountCents ?? 0, currency);
  }

  /** The booking, or null when it has been deleted since the event was written. */
  private async load(bookingId: string): Promise<BookingRow | null> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: BOOKING_FOR_NOTIFICATION,
    });

    if (booking === null) {
      this.logger.warn(`booking ${bookingId} no longer exists; no notification sent`);
    }

    return booking;
  }
}
