import { Inject, Injectable, Logger } from '@nestjs/common';

import { ALL_EMPLOYEES, EmployeeScopeService } from '../auth/employee-scope.service.js';
import { AttendanceService } from '../booking/attendance.service.js';
import { CLOCK } from '../domain/time/clock.js';
import {
  addLocalDays,
  instantToLocalDate,
  wallClockToInstantOrThrow,
} from '../domain/time/local-time.js';
import { InboxReconciler } from '../messaging/inbox/inbox.reconciler.js';
import { OutboxReconciler } from '../messaging/outbox/outbox.reconciler.js';
import { QUEUE_REGISTRY } from '../messaging/queues/enqueue.service.js';
import { NotificationReconciler } from '../notification/notification.reconciler.js';
import { OrganizationContextService } from '../organization/organization-context.service.js';
import { Prisma } from '../prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

import { deriveDisplayStatus } from './display-status.js';

import type { VisibleEmployees } from '../auth/employee-scope.service.js';
import type { OfficeSession } from '../auth/session.store.js';
import type { Clock } from '../domain/time/clock.js';
import type { QueueRegistry } from '../messaging/queues/enqueue.service.js';
import type { OfficeDashboardResponse, OperationsHealth } from '@shape-and-flow/booking-contracts';

/** Statuses that put an appointment on today's list. */
const TODAY_STATUSES = ['CONFIRMED', 'COMPLETED', 'NO_SHOW'] as const;

/**
 * How far back the unpaid count looks.
 *
 * Bounded on purpose. Every other figure on this screen is a count over a fixed window, and
 * an unbounded scan of every confirmed booking a business has ever taken is a query whose
 * cost grows for a number that fits in a tile. Three months is past the point where an
 * unpaid appointment is still something the office chases — after that it is a write-off,
 * not a to-do.
 */
const UNPAID_LOOKBACK_DAYS = 90;

const APPOINTMENT_FIELDS = {
  id: true,
  reference: true,
  status: true,
  startsAt: true,
  endsAt: true,
  employeeId: true,
  serviceNameSnapshot: true,
  employee: { select: { displayName: true } },
  customer: { select: { firstName: true, lastName: true } },
  cancellationRequests: { where: { decision: 'PENDING' as const }, select: { id: true } },
  rescheduleRequests: { where: { decision: 'PENDING' as const }, select: { id: true } },
} as const;

/**
 * The morning screen.
 *
 * Two things here are worth stating. **"Today" is a local day**, resolved through the
 * time primitives rather than by taking a UTC date — in Berlin summer an appointment at
 * 23:30 is 21:30Z, and a UTC day boundary would file it under yesterday and drop it off
 * the list of the day it actually happens.
 *
 * **"Unpaid" is a comparison, not a flag.** A booking is unpaid until what has been
 * received — card payments and cash together — reaches the price it was sold at, so a
 * part payment still shows up as something to chase. There is no column for that, and no
 * way to express the comparison in Prisma's query API without loading every confirmed
 * booking and its payments, so it is one raw statement.
 */
@Injectable()
export class DashboardService {
  private readonly logger = new Logger('Dashboard');

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizations: OrganizationContextService,
    private readonly scope: EmployeeScopeService,
    private readonly outbox: OutboxReconciler,
    private readonly inbox: InboxReconciler,
    private readonly notifications: NotificationReconciler,
    private readonly attendance: AttendanceService,
    @Inject(QUEUE_REGISTRY) private readonly queues: QueueRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async load(session: OfficeSession): Promise<OfficeDashboardResponse> {
    const organization = this.organizations.get();
    const zone = organization.timezone;
    const organizationId = session.organizationId;
    const visible = this.scope.visibleEmployeeIds(session);
    const employees = visible === ALL_EMPLOYEES ? {} : { employeeId: { in: visible } };

    const now = this.clock.now();
    const todayDate = instantToLocalDate(now, zone);
    const startOfToday = wallClockToInstantOrThrow(todayDate, 0, zone);
    const startOfTomorrow = wallClockToInstantOrThrow(addLocalDays(todayDate, 1, zone), 0, zone);
    const endOfWeek = wallClockToInstantOrThrow(addLocalDays(todayDate, 8, zone), 0, zone);
    const unpaidSince = wallClockToInstantOrThrow(
      addLocalDays(todayDate, -UNPAID_LOOKBACK_DAYS, zone),
      0,
      zone,
    );

    const [today, next7DaysCount, pendingCancellations, pendingReschedules, money, operations] =
      await Promise.all([
        this.prisma.booking.findMany({
          where: {
            organizationId,
            ...employees,
            status: { in: [...TODAY_STATUSES] },
            startsAt: { gte: startOfToday, lt: startOfTomorrow },
          },
          select: APPOINTMENT_FIELDS,
          orderBy: { startsAt: 'asc' },
        }),
        this.prisma.booking.count({
          where: {
            organizationId,
            ...employees,
            status: 'CONFIRMED',
            startsAt: { gte: startOfTomorrow, lt: endOfWeek },
          },
        }),
        this.prisma.cancellationRequest.count({
          where: { organizationId, decision: 'PENDING', booking: employees },
        }),
        this.prisma.rescheduleRequest.count({
          where: { organizationId, decision: 'PENDING', booking: employees },
        }),
        this.moneyFigures(organizationId, visible, {
          startOfToday,
          startOfTomorrow,
          unpaidSince,
        }),
        this.operations(),
      ]);

    return {
      today: today.map((booking) => ({
        id: booking.id,
        reference: booking.reference,
        startsAt: booking.startsAt.toISOString(),
        endsAt: booking.endsAt.toISOString(),
        employeeId: booking.employeeId,
        employeeName: booking.employee.displayName,
        serviceName: booking.serviceNameSnapshot,
        customerName: `${booking.customer.firstName} ${booking.customer.lastName}`,
        displayStatus: deriveDisplayStatus(booking, {
          cancellation: booking.cancellationRequests.length > 0,
          reschedule: booking.rescheduleRequests.length > 0,
        }),
      })),
      next7DaysCount,
      pendingCancellationRequests: pendingCancellations,
      pendingRescheduleRequests: pendingReschedules,
      unpaidConfirmedBookings: money.unpaidConfirmedBookings,
      todayRevenue: { amountCents: money.todayRevenueCents, currency: organization.currency },
      operations,
    };
  }

  /**
   * Today's takings and the count of bookings still owing, in one statement.
   *
   * Raw SQL, and deliberately so. The unpaid comparison is per booking against a sum
   * across two tables, which Prisma's query API cannot express — the alternative is
   * loading every confirmed booking with its payments and comparing in JavaScript, which
   * is a query whose cost grows with the business for a number that fits in a tile.
   *
   * The cent arithmetic lives in SQL rather than in a `Money`, which is the one place
   * the domain's ban does not reach. It is a sum of same-currency integer columns, which
   * is the case `Money` exists to protect and not one it can help with here.
   *
   * Both figures carry the caller's employee scope, like every other tile on the screen.
   * Revenue across the whole business is the last thing an EMPLOYEE session should be
   * handed, and the scope has to reach the payment rows through their booking, because
   * neither payment table carries an employee column.
   */
  private async moneyFigures(
    organizationId: string,
    visible: VisibleEmployees,
    window: { startOfToday: Date; startOfTomorrow: Date; unpaidSince: Date },
  ): Promise<{ todayRevenueCents: number; unpaidConfirmedBookings: number }> {
    const { startOfToday, startOfTomorrow, unpaidSince } = window;

    // `b` is the bookings row in whichever subquery this is spliced into. Empty for an
    // unscoped role, so the statement has one shape rather than two.
    const employees =
      visible === ALL_EMPLOYEES
        ? Prisma.empty
        : Prisma.sql`AND b.employee_id IN (${Prisma.join(visible)})`;

    const rows = await this.prisma.$queryRaw<
      { today_revenue_cents: bigint; unpaid_confirmed_bookings: bigint }[]
    >(Prisma.sql`
      SELECT
        (
          COALESCE((
            SELECT SUM(p.amount_cents) FROM payments p
            JOIN bookings b ON b.id = p.booking_id
            WHERE p.organization_id = ${organizationId}
              AND p.status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')
              AND p.paid_at >= ${startOfToday} AND p.paid_at < ${startOfTomorrow}
              ${employees}
          ), 0)
          +
          COALESCE((
            SELECT SUM(m.amount_cents) FROM manual_payments m
            JOIN bookings b ON b.id = m.booking_id
            WHERE m.organization_id = ${organizationId}
              AND m.paid_at >= ${startOfToday} AND m.paid_at < ${startOfTomorrow}
              ${employees}
          ), 0)
        ) AS today_revenue_cents,
        (
          SELECT COUNT(*) FROM bookings b
          WHERE b.organization_id = ${organizationId}
            AND b.status = 'CONFIRMED'
            AND b.starts_at >= ${unpaidSince}
            ${employees}
            AND (
              COALESCE((
                SELECT SUM(p.amount_cents) FROM payments p
                WHERE p.booking_id = b.id
                  AND p.status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED')
              ), 0)
              +
              COALESCE((
                SELECT SUM(m.amount_cents) FROM manual_payments m WHERE m.booking_id = b.id
              ), 0)
            ) < b.price_cents_snapshot
        ) AS unpaid_confirmed_bookings
    `);

    const row = rows[0];

    return {
      // `SUM` and `COUNT` come back as bigint. Safe to narrow: both are bounded by the
      // number of rows a single business produces.
      todayRevenueCents: Number(row?.today_revenue_cents ?? 0),
      unpaidConfirmedBookings: Number(row?.unpaid_confirmed_bookings ?? 0),
    };
  }

  /**
   * What is wrong with the machinery.
   *
   * Every figure comes from a component that already computes it for its own health
   * endpoint, rather than from queries restated here — two definitions of "stuck" that
   * disagree would be worse than none.
   *
   * A failure to read any of them degrades to `-1` rather than failing the whole
   * dashboard: the office's morning does not depend on Redis being reachable, and a page
   * that will not load is a worse answer than a tile that says it could not count.
   */
  private async operations(): Promise<OperationsHealth> {
    const [outbox, inbox, notifications, overdue, failedJobs] = await Promise.all([
      this.safely(() => this.outbox.health()),
      this.safely(() => this.inbox.health()),
      this.safely(() => this.notifications.health()),
      this.safely(() => this.attendance.reportStaleCompletions()),
      this.safely(async () => {
        const counts = await Promise.all(
          Object.values(this.queues).map(async (queue) => await queue.getFailedCount()),
        );
        return counts.reduce((total, count) => total + count, 0);
      }),
    ]);

    return {
      failedJobs: failedJobs ?? -1,
      // Stalled, not pending: a row waiting its turn is the system working.
      stuckOutboxRows: outbox === null ? -1 : outbox.stalled + outbox.exhausted,
      pendingNotifications: notifications === null ? -1 : notifications.pending,
      unprocessedWebhooks: inbox === null ? -1 : inbox.stripe.pending + inbox.messaging.pending,
      overdueCompletions: overdue?.count ?? -1,
    };
  }

  private async safely<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      this.logger.warn(
        `an operations figure could not be read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
