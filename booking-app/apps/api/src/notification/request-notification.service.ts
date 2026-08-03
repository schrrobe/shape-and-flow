import { Injectable } from '@nestjs/common';

import { OrganizationContextService } from '../organization/organization-context.service.js';

import { BookingNotificationData } from './booking-notification-data.service.js';
import { NotificationService } from './notification.service.js';

import type { BookingRow } from './booking-notification-data.service.js';
import type { Prisma } from '../prisma/client.js';

/**
 * The messages a cancellation or reschedule request implies, composed properly.
 *
 * Both request services used to record a `notification.send` outbox event whose
 * payload carried the *request* id in the `notificationId` field. No notification row
 * ever existed, so every one of those jobs failed looking one up: the customer was
 * never told their request had arrived, the office was never told it was waiting, and
 * a rejected request said nothing at all. The rows are the whole mechanism — dedupe,
 * the frozen payload, the reconciler — so composing them is not optional garnish.
 *
 * `NotificationService` stays the only writer of rows and jobs. This sits above it and
 * knows which kinds a request produces, which is the part the two request services
 * should not each be reimplementing.
 *
 * Every method takes the caller's transaction. A message about a decision that rolls
 * back is a message about something that did not happen.
 */
@Injectable()
export class RequestNotificationService {
  constructor(
    private readonly notifications: NotificationService,
    private readonly bookingData: BookingNotificationData,
    private readonly organizations: OrganizationContextService,
  ) {}

  /** A cancellation request has arrived: tell the customer, and tell the office. */
  async queueCancellationReceived(
    tx: Prisma.TransactionClient,
    input: {
      requestId: string;
      bookingId: string;
      suggestedRetainedCents: number;
      reason: string | null;
    },
  ): Promise<void> {
    const booking = await this.bookingData.load(input.bookingId, tx);
    if (booking === null) return;

    const appointment = this.bookingData.appointmentData(booking);

    await this.notifications.queue(tx, {
      organizationId: booking.organizationId,
      bookingId: booking.id,
      customerId: booking.customer.id,
      kind: 'CANCELLATION_REQUEST_RECEIVED',
      channel: 'EMAIL',
      locale: booking.locale,
      recipient: booking.customer.email,
      dedupeDiscriminator: `${input.requestId}:customer`,
      data: { ...appointment, suggestedRetainedCents: input.suggestedRetainedCents },
    });

    await this.notifications.queue(tx, {
      organizationId: booking.organizationId,
      bookingId: booking.id,
      kind: 'OFFICE_CANCELLATION_REQUEST',
      channel: 'EMAIL',
      ...this.officeAddressing(),
      dedupeDiscriminator: `${input.requestId}:office`,
      data: {
        ...appointment,
        customerName: customerName(booking),
        suggestedRetainedCents: input.suggestedRetainedCents,
        reason: input.reason,
      },
    });
  }

  /**
   * A reschedule request has arrived: tell the customer it is pending.
   *
   * No office copy, because there is no office reschedule kind — the request queue in
   * the office screens is where these are seen. Adding one would mean an enum value, a
   * migration and two templates, which is a change of scope rather than a fix.
   */
  async queueRescheduleReceived(
    tx: Prisma.TransactionClient,
    input: { requestId: string; bookingId: string; requestedStartsAt: Date },
  ): Promise<void> {
    const booking = await this.bookingData.load(input.bookingId, tx);
    if (booking === null) return;

    await this.notifications.queue(tx, {
      organizationId: booking.organizationId,
      bookingId: booking.id,
      customerId: booking.customer.id,
      kind: 'RESCHEDULE_REQUEST_RECEIVED',
      channel: 'EMAIL',
      locale: booking.locale,
      recipient: booking.customer.email,
      dedupeDiscriminator: `${input.requestId}:customer`,
      data: {
        ...this.bookingData.appointmentData(booking),
        requestedStartsAt: input.requestedStartsAt,
      },
    });
  }

  /** The office has decided a cancellation request, either way. */
  async queueCancellationDecided(
    tx: Prisma.TransactionClient,
    input: {
      requestId: string;
      bookingId: string;
      approved: boolean;
      retainedCents: number;
      refundedCents: number;
      note: string | null;
    },
  ): Promise<void> {
    const booking = await this.bookingData.load(input.bookingId, tx);
    if (booking === null) return;

    await this.notifications.queue(tx, {
      organizationId: booking.organizationId,
      bookingId: booking.id,
      customerId: booking.customer.id,
      kind: 'CANCELLATION_REQUEST_DECIDED',
      channel: 'EMAIL',
      locale: booking.locale,
      recipient: booking.customer.email,
      dedupeDiscriminator: `${input.requestId}:decision`,
      data: {
        ...this.bookingData.appointmentData(booking),
        approved: input.approved,
        retainedCents: input.retainedCents,
        refundedCents: input.refundedCents,
        note: input.note,
      },
    });
  }

  /**
   * The office has decided a reschedule request, either way.
   *
   * On approval `bookingId` is the replacement — the appointment the customer now has
   * — and the rotated management token makes the link in the message work. On
   * rejection there is no new booking and no new token, so there is no link: `null`
   * rather than a bare `/manage`, which would open a page that cannot find them.
   */
  async queueRescheduleDecided(
    tx: Prisma.TransactionClient,
    input: {
      requestId: string;
      bookingId: string;
      approved: boolean;
      managementToken?: string | undefined;
      note: string | null;
    },
  ): Promise<void> {
    const booking = await this.bookingData.load(input.bookingId, tx);
    if (booking === null) return;

    await this.notifications.queue(tx, {
      organizationId: booking.organizationId,
      bookingId: booking.id,
      customerId: booking.customer.id,
      kind: 'RESCHEDULE_REQUEST_DECIDED',
      channel: 'EMAIL',
      locale: booking.locale,
      recipient: booking.customer.email,
      dedupeDiscriminator: `${input.requestId}:decision`,
      data: {
        ...this.bookingData.appointmentData(booking),
        approved: input.approved,
        manageUrl: input.approved ? this.bookingData.manageUrl(input.managementToken) : null,
        note: input.note,
      },
    });
  }

  /**
   * Where an office message goes, and in which language.
   *
   * The organization's own locale, not the customer's — the same rule the new-booking
   * notification follows, and for the same reason: the office reads its own mail.
   */
  private officeAddressing(): { locale: 'de' | 'en'; recipient: string } {
    return {
      locale: this.organizations.get().defaultLocale,
      recipient: this.organizations.getSettings().officeNotificationEmail,
    };
  }
}

function customerName(booking: BookingRow): string {
  return `${booking.customer.firstName} ${booking.customer.lastName}`;
}
