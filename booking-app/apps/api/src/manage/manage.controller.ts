import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { manageAvailabilityQuerySchema } from '@shape-and-flow/booking-contracts';

import { AppError } from '../common/errors/app-error.js';
import { generateAvailability } from '../domain/availability/engine.js';
import { Money } from '../domain/money/money.js';
import { computeSuggestedRetainedAmount } from '../domain/pricing/cancellation-fee.js';
import { CLOCK } from '../domain/time/clock.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AvailabilitySnapshotService } from '../public/availability-snapshot.service.js';

import { ManagedBooking, ManagementToken } from './management-token.guard.js';

import type { ResolvedToken } from './management-token.service.js';
import type { Clock } from '../domain/time/clock.js';
import type { BookingStatus, PaymentStatus } from '../prisma/client.js';
import type {
  AvailabilityResponse,
  DisplayStatus,
  ManageBookingResponse,
} from '@shape-and-flow/booking-contracts';

/**
 * Thirty requests a minute per IP.
 *
 * The limit is on failures as much as successes: a token is 256 bits and unguessable,
 * but an unthrottled endpoint invites someone to try anyway, and the attempt should cost
 * something.
 */
const MANAGE_LIMIT = { default: { limit: 30, ttl: 60_000 } };

/**
 * The columns the customer's own view is built from.
 *
 * Named explicitly. `include: { booking: true }` here would put the customer id, the
 * employee id, the Stripe session and the organization id into a response that anyone
 * holding a link from an old email can read.
 */
const BOOKING_VIEW = {
  reference: true,
  status: true,
  startsAt: true,
  endsAt: true,
  serviceNameSnapshot: true,
  durationMinutesSnapshot: true,
  priceCentsSnapshot: true,
  currency: true,
  customerNote: true,
  serviceId: true,
  employeeId: true,
  employee: { select: { displayName: true } },
  payments: { select: { status: true, amountCents: true, refundedAmountCents: true } },
  cancellationRequests: { where: { decision: 'PENDING' as const }, select: { id: true } },
  rescheduleRequests: { where: { decision: 'PENDING' as const }, select: { id: true } },
} as const;

@Controller('manage')
@ManagementToken()
@Throttle(MANAGE_LIMIT)
export class ManageController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly snapshots: AvailabilitySnapshotService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * `GET /manage/booking`.
   *
   * No id in the path — the token is the selector. That is what makes it impossible to
   * aim a valid token at somebody else's appointment.
   */
  @Get('booking')
  async booking(@ManagedBooking() managed: ResolvedToken): Promise<ManageBookingResponse> {
    const booking = await this.load(managed);
    const settings = this.organizations.getSettings();
    const now = this.clock.now();

    const paid = this.paidTotal(booking.payments, booking.currency);
    const refunded = this.refundedTotal(booking.payments, booking.currency);

    const policy = computeSuggestedRetainedAmount({
      paid,
      startsAt: booking.startsAt,
      now,
      settings: {
        freeCancellationHours: settings.freeCancellationHours,
        cancellationFeePolicy: settings.cancellationFeePolicy,
        cancellationFeeAmountCents: settings.cancellationFeeAmountCents,
        cancellationFeePercent: settings.cancellationFeePercent,
      },
    });

    return {
      reference: booking.reference,
      status: booking.status,
      displayStatus: this.displayStatus(booking),
      startsAt: booking.startsAt.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      timezone: this.organizations.getTimezone(),
      serviceName: booking.serviceNameSnapshot,
      durationMinutes: booking.durationMinutesSnapshot,
      employeeDisplayName: booking.employee.displayName,
      price: { amountCents: booking.priceCentsSnapshot, currency: booking.currency },
      paid: paid.toJSON(),
      refunded: refunded.toJSON(),
      customerNote: booking.customerNote,
      cancellationPolicy: {
        feePolicy: settings.cancellationFeePolicy,
        // From the pricing module, which is what `feeApplies` is decided by. Recomputing
        // the boundary here would give the customer a countdown that can disagree with the
        // fee they are actually charged.
        freeUntil: policy.freeUntil.toISOString(),
        feeApplies: policy.feeApplies,
        suggestedRetained: policy.suggestedRetained.toJSON(),
        suggestedRefund: policy.suggestedRefund.toJSON(),
        cancellable: booking.status === 'CONFIRMED' && booking.startsAt > now,
      },
    };
  }

  /**
   * `GET /manage/availability`.
   *
   * The service is the booking's own — no `serviceId` parameter, because offering one
   * would let a reschedule quietly change what was bought and paid for.
   */
  @Get('availability')
  async availability(
    @ManagedBooking() managed: ResolvedToken,
    @Query() rawQuery: unknown,
  ): Promise<AvailabilityResponse> {
    const query = manageAvailabilityQuerySchema.parse(rawQuery);
    const booking = await this.load(managed);

    const snapshot = await this.snapshots.load({
      serviceId: booking.serviceId,
      from: query.from,
      to: query.to,
    });

    const result = generateAvailability(snapshot, query.from, query.to);

    return {
      serviceId: booking.serviceId,
      timezone: snapshot.zone,
      days: result.days.map((day) => ({
        date: day.date,
        slots: day.slots.map((slot) => ({
          startsAt: slot.startsAt.toISOString(),
          endsAt: slot.endsAt.toISOString(),
          employeeIds: slot.employeeIds,
        })),
      })),
    };
  }

  /**
   * Load the booking the token points at.
   *
   * Scoped by the organization the token itself carries, not by the ambient context. The
   * two are the same today; keeping the token's own value is what makes this correct when
   * a second organization exists.
   */
  private async load(managed: ResolvedToken): Promise<ManagedBookingRow> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: managed.bookingId, organizationId: managed.organizationId },
      select: BOOKING_VIEW,
    });

    if (booking === null) {
      throw new AppError('NOT_FOUND', { message: 'Booking not found.' });
    }

    return booking;
  }

  /**
   * What to show instead of the stored status.
   *
   * An open request means the customer is waiting for an answer; saying "confirmed"
   * would be true of the row and misleading to the person reading it.
   */
  private displayStatus(booking: ManagedBookingRow): DisplayStatus {
    if (booking.cancellationRequests.length > 0) return 'CANCELLATION_REQUESTED';
    if (booking.rescheduleRequests.length > 0) return 'RESCHEDULE_REQUESTED';
    return booking.status;
  }

  /** What has actually settled. A pending payment has not been received. */
  private paidTotal(payments: readonly PaymentRow[], currency: string): Money {
    // A refunded payment was still received: `paid` is what arrived, and `refunded` is
    // what went back. Subtracting here would make both numbers say the same thing.
    return Money.sum(
      settledOnly(payments).map((payment) => Money.fromCents(payment.amountCents, currency)),
      currency,
    );
  }

  private refundedTotal(payments: readonly PaymentRow[], currency: string): Money {
    // The same filter as `paidTotal`, so the two numbers describe the same set of rows.
    // Summing every row would let a PENDING or FAILED payment carrying a non-zero refunded
    // amount report a refund larger than the payment it came from.
    return Money.sum(
      settledOnly(payments).map((payment) =>
        Money.fromCents(payment.refundedAmountCents, currency),
      ),
      currency,
    );
  }
}

const SETTLED: PaymentStatus[] = ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/** The payments that represent money actually received. */
function settledOnly(payments: readonly PaymentRow[]): readonly PaymentRow[] {
  return payments.filter((payment) => SETTLED.includes(payment.status));
}

interface PaymentRow {
  status: PaymentStatus;
  amountCents: number;
  refundedAmountCents: number;
}

interface ManagedBookingRow {
  reference: string;
  status: BookingStatus;
  startsAt: Date;
  endsAt: Date;
  serviceNameSnapshot: string;
  durationMinutesSnapshot: number;
  priceCentsSnapshot: number;
  currency: string;
  customerNote: string | null;
  serviceId: string;
  employeeId: string;
  employee: { displayName: string };
  payments: PaymentRow[];
  cancellationRequests: { id: string }[];
  rescheduleRequests: { id: string }[];
}
