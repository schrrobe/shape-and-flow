import { Inject, Injectable, Logger } from '@nestjs/common';

import { isAppError } from '../common/errors/app-error.js';
import { ENV } from '../config/env.schema.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { BookingFinancialsService } from '../payment/booking-financials.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { AppConfig } from '../config/env.schema.js';
import type { BookingFinancials } from '../payment/booking-financials.service.js';
import type { Prisma } from '../prisma/client.js';
import type { AppointmentData, CommonData } from '@shape-and-flow/booking-notification-templates';

/** Everything a notification about a booking needs, loaded once. */
export const BOOKING_FOR_NOTIFICATION = {
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
} as const;

/**
 * The booking, plus the money on its financial root.
 *
 * Not `booking.payments`: a rescheduled booking's payment stays on the row that was
 * paid, and a cancellation email that read this booking's own relation told the
 * customer nothing had been refunded because it could see nothing that was paid.
 */
export type BookingRow = Prisma.BookingGetPayload<{
  select: typeof BOOKING_FOR_NOTIFICATION;
}> & { financials: BookingFinancials };

/**
 * The booking fields every notification shares, built one way.
 *
 * Shared between the booking-event processor and the reminder service rather than copied,
 * because the copy that drifts is the one nobody reads: a reminder naming the service
 * differently from the confirmation for the same appointment is the kind of defect a
 * customer notices and a test does not.
 */
@Injectable()
export class BookingNotificationData {
  private readonly logger = new Logger('BookingNotificationData');

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly financials: BookingFinancialsService,
    @Inject(ENV) private readonly config: AppConfig,
  ) {}

  /**
   * The booking, or null when it has been deleted since the event was written.
   *
   * Takes an optional transaction client because a caller may be composing a message
   * about a booking it has just created and not yet committed — a reschedule
   * approval builds the replacement and announces it in one transaction, and a read
   * on a fresh connection would not see it.
   */
  async load(bookingId: string, tx?: Prisma.TransactionClient): Promise<BookingRow | null> {
    const booking = await (tx ?? this.prisma).booking.findFirst({
      where: { id: bookingId, organizationId: this.organizations.getOrganizationId() },
      select: BOOKING_FOR_NOTIFICATION,
    });

    if (booking === null) {
      this.logger.warn(`booking ${bookingId} no longer exists; no notification sent`);
      return null;
    }

    try {
      return { ...booking, financials: await this.financials.load(bookingId, tx) };
    } catch (error) {
      // The row can disappear between the two reads. That is the same harmless outcome
      // as finding no booking initially; every other financial failure must still retry.
      if (isAppError(error, 'NOT_FOUND')) {
        this.logger.warn(`booking ${bookingId} no longer exists; no notification sent`);
        return null;
      }

      throw error;
    }
  }

  /** The fields every appointment template shares. */
  appointmentData(booking: BookingRow): AppointmentData {
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

  commonData(): CommonData {
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
  manageUrl(token: string | undefined): string {
    const base = `${this.config.PUBLIC_WEB_ORIGIN}/manage`;
    return token === undefined ? base : `${base}#${token}`;
  }
}
