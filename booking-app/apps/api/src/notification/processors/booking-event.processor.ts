import { Injectable } from '@nestjs/common';

import { withSerializationRetry } from '../../common/prisma-errors/serialization-retry.js';
import { Money } from '../../domain/money/money.js';
import { receivedFrom } from '../../office/received.js';
import { OrganizationContextService } from '../../organization/organization-context.service.js';
import { runWithOrganization } from '../../organization/tenant-context.store.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BookingNotificationData } from '../booking-notification-data.service.js';
import { NotificationService } from '../notification.service.js';
import { ReminderService } from '../reminder.service.js';

import type { BookingRow } from '../booking-notification-data.service.js';

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
 *
 * Every handler opens its own tenant scope with `runWithOrganization` before doing anything
 * else. `data.load` and `reminders.schedule`/`cancelFor` both read the ALS-scoped
 * organization rather than take one as an argument, so a worker that never opened a scope
 * would silently serve the bootstrap default organization instead of the one the job is
 * actually about — see `ExpiryProcessor` for the same pattern.
 */
@Injectable()
export class BookingEventProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly organizations: OrganizationContextService,
    private readonly data: BookingNotificationData,
    private readonly reminders: ReminderService,
  ) {}

  /** `booking.confirmed` — the customer's confirmation, and the office's copy. */
  async confirmed(payload: {
    organizationId: string;
    bookingId: string;
    managementToken?: string | undefined;
  }): Promise<void> {
    // Opened before the first read: `data.load` and `getSettings` both resolve the ALS
    // tenant, and with no scope open here they would silently serve the bootstrap
    // default organization instead of the one that owns this booking.
    await runWithOrganization(payload.organizationId, this.prisma, async () => {
      const booking = await this.data.load(payload.bookingId);
      if (booking === null) return;

      const settings = this.organizations.getSettings();

      await withSerializationRetry(
        () =>
          this.prisma.$transaction(async (tx) => {
            const appointment = this.data.appointmentData(booking);

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
                manageUrl: this.data.manageUrl(payload.managementToken),
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
            // off is a bill the business did not agree to. Gated on
            // `smsConfirmationsEnabled` rather than the reminder flag: those are two
            // decisions, and a business may want either one without the other.
            if (settings.smsConfirmationsEnabled && booking.customer.phone !== null) {
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
                  manageUrl: this.data.manageUrl(payload.managementToken),
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

      // After the transaction, not inside it. A delayed job is not transactional, and
      // enqueueing one for a booking whose confirmation then rolled back would leave a
      // reminder for an appointment nobody has. `fire` re-validates, so the worst case of
      // enqueueing and then crashing is a job that skips itself.
      await this.reminders.schedule(booking.id);
    });
  }

  /**
   * `booking.canceled` — who cancelled decides which template.
   *
   * `customerNotificationAlreadyQueued` is set by a transaction that already composed a
   * customer message about this cancellation — a decided cancellation request, which
   * names the retained amount and the office's note. Sending the generic one as well
   * would be two emails about one decision, the second saying less than the first.
   */
  async canceled(payload: {
    organizationId: string;
    bookingId: string;
    customerNotificationAlreadyQueued?: boolean | undefined;
  }): Promise<void> {
    // Opened before the early-return branch too: `reminders.cancelFor` resolves the ALS
    // tenant on its own, so skipping the scope there would cancel reminders against the
    // bootstrap default organization rather than this job's.
    await runWithOrganization(payload.organizationId, this.prisma, async () => {
      if (payload.customerNotificationAlreadyQueued === true) {
        await this.reminders.cancelFor(payload.bookingId);
        return;
      }

      const booking = await this.data.load(payload.bookingId);
      if (booking === null) return;

      const byBusiness = booking.status === 'CANCELED_BY_BUSINESS';
      const refunded = this.promisedRefunds(booking);

      await withSerializationRetry(
        () =>
          this.prisma.$transaction(async (tx) => {
            const appointment = this.data.appointmentData(booking);

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
                  // A code, resolved by the template in the customer's locale. A German
                  // sentence here would reach an English-speaking customer untranslated.
                  reasonCode: 'SEE_MESSAGE',
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

      await this.reminders.cancelFor(booking.id);
    });
  }

  /** `booking.rescheduled` — the new time, and a link that works. */
  async rescheduled(payload: {
    organizationId: string;
    bookingId: string;
    previousBookingId: string;
    managementToken?: string | undefined;
    customerNotificationAlreadyQueued?: boolean | undefined;
  }): Promise<void> {
    // Both bookings belong to the same organization — a reschedule cannot move a booking
    // across tenants — so one scope covers both loads below.
    await runWithOrganization(payload.organizationId, this.prisma, async () => {
      const booking = await this.data.load(payload.bookingId);
      const previous = await this.data.load(payload.previousBookingId);
      if (booking === null || previous === null) return;

      // An approved reschedule request already told the customer, with the office's note.
      // The reminder work below still has to happen either way.
      if (payload.customerNotificationAlreadyQueued !== true) {
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
                  ...this.data.appointmentData(booking),
                  manageUrl: this.data.manageUrl(payload.managementToken),
                  previousStartsAt: previous.startsAt,
                },
              });
            }),
          'notify-booking-rescheduled',
        );
      }

      // The old booking's jobs are keyed on its own id and time, so they need removing
      // separately — and the new booking needs its own. Either way `fire` would refuse the
      // stale one: a reschedule replaces the booking row, so the old id is no longer
      // CONFIRMED.
      await this.reminders.cancelFor(previous.id);
      await this.reminders.schedule(booking.id);
    });
  }

  /** `refund.succeeded` — the money is on its way back. */
  async refundSucceeded(payload: { organizationId: string; refundId: string }): Promise<void> {
    // The refund lookup itself needs no scope — it is a lookup by its own id — but
    // `data.load` right after it does, so the scope opens before either read.
    await runWithOrganization(payload.organizationId, this.prisma, async () => {
      const refund = await this.prisma.refund.findUnique({
        where: { id: payload.refundId },
        select: { id: true, bookingId: true, amountCents: true },
      });

      if (refund === null) return;

      const booking = await this.data.load(refund.bookingId);
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
              data: { ...this.data.appointmentData(booking), refundedCents: refund.amountCents },
            });
          }),
        'notify-refund-succeeded',
      );
    });
  }

  /** `booking.payment_failed` — nothing was charged, and the slot is gone. */
  async paymentFailed(payload: { organizationId: string; bookingId: string }): Promise<void> {
    await runWithOrganization(payload.organizationId, this.prisma, async () => {
      const booking = await this.data.load(payload.bookingId);
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
                ...this.data.appointmentData(booking),
                reasonCode: 'PAYMENT_FAILED',
                refundedCents: 0,
              },
            });
          }),
        'notify-payment-failed',
      );

      await this.reminders.cancelFor(booking.id);
    });
  }

  /**
   * What actually arrived, from the booking's financial root.
   *
   * Cash counts too: a customer who paid at the desk and then cancelled is owed that
   * money back, and a message that ignored it would name the wrong retained amount.
   */
  private paidTotal(booking: BookingRow): Money {
    return receivedFrom(booking.financials, booking.currency);
  }

  /** Money already returned or reserved as part of the cancellation promise. */
  private promisedRefunds(booking: BookingRow): Money {
    return Money.sum(
      booking.financials.refunds
        .filter((refund) => refund.status === 'PENDING' || refund.status === 'SUCCEEDED')
        .map((refund) => Money.fromCents(refund.amountCents, booking.currency)),
      booking.currency,
    );
  }
}
