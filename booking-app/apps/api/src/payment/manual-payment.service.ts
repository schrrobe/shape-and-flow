import { Inject, Injectable } from '@nestjs/common';

import { AuditService } from '../booking/audit.service.js';
import { AppError } from '../common/errors/app-error.js';
import { Money } from '../domain/money/money.js';
import { CLOCK } from '../domain/time/clock.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

import type { Clock } from '../domain/time/clock.js';
import type {
  BookingManualPayment,
  CreateManualPaymentRequest,
} from '@shape-and-flow/booking-contracts';

/**
 * Money that did not come through Stripe.
 *
 * Cash at the desk, the studio's own card terminal, a bank transfer somebody matched by
 * hand. It is recorded rather than reconciled: nothing here talks to a payment provider,
 * and the row is a statement by a named office user that money arrived.
 *
 * Which is exactly why the **actor and the timestamp are not optional in the row**. A
 * ledger line nobody signed is one nobody can be asked about, and the office's own
 * unpaid-bookings tile is computed from these rows plus Stripe's.
 *
 * Idempotency is the route's job, through `@Idempotent('manual-payment.create')`. Without
 * it a retried request at a busy desk records the same fifty euros twice, and the second
 * one is indistinguishable from a real second payment.
 */
@Injectable()
export class ManualPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record(
    bookingId: string,
    officeUserId: string,
    input: CreateManualPaymentRequest,
  ): Promise<BookingManualPayment> {
    const organizationId = this.organizations.getOrganizationId();

    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, organizationId },
      select: { id: true, reference: true, currency: true, status: true },
    });

    if (booking === null) {
      throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
    }

    // A payment against a booking that never happened is almost always a mis-typed id,
    // and recording it would put money in the ledger against nothing. EXPIRED and
    // PAYMENT_FAILED are the two the office would reach for by accident, since both sit
    // beside live bookings in a search.
    if (booking.status === 'EXPIRED' || booking.status === 'PAYMENT_FAILED') {
      throw new AppError('INVALID_STATUS_TRANSITION', {
        message: 'That booking never took place, so money cannot be recorded against it.',
        details: { status: booking.status },
      });
    }

    // Through Money rather than as a bare integer, so the ESLint ban on raw cent
    // arithmetic has something to point at and the currency travels with the amount.
    const amount = Money.fromCents(input.amountCents, booking.currency);
    const paidAt = input.paidAt === undefined ? this.clock.now() : new Date(input.paidAt);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.manualPayment.create({
        data: {
          organizationId,
          bookingId: booking.id,
          amountCents: amount.amountCents,
          currency: amount.currency,
          method: input.method,
          paidAt,
          recordedByOfficeUserId: officeUserId,
          ...(input.note === undefined ? {} : { note: input.note }),
        },
      });

      // In the same transaction as the row it describes: an audit entry written outside
      // it can exist for a payment that rolled back.
      await this.audit.record(tx, {
        organizationId,
        officeUserId,
        action: 'MANUAL_PAYMENT_RECORDED',
        entityType: 'ManualPayment',
        entityId: created.id,
        summary:
          `${amount.toString()} ${input.method} recorded against ${booking.reference}` +
          (input.amountCents < 0 ? ' (correction)' : ''),
        after: {
          bookingId: booking.id,
          amountCents: created.amountCents,
          method: created.method,
          paidAt: created.paidAt.toISOString(),
          note: created.note,
        },
      });

      return created;
    });

    return {
      id: row.id,
      amount: { amountCents: row.amountCents, currency: row.currency },
      method: row.method,
      paidAt: row.paidAt.toISOString(),
      recordedByOfficeUserId: row.recordedByOfficeUserId,
      note: row.note,
    };
  }
}
