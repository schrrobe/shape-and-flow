import { z } from 'zod';

import { displayStatusSchema } from '../enums.js';
import { cuidSchema, isoInstantSchema, moneySchema } from '../primitives.js';

/**
 * The first screen the office sees each morning.
 *
 * Every figure here is a count or a total — nothing that needs a second call to be
 * useful — and the appointment list is today's only. A dashboard that grows with the
 * business is a dashboard that gets slower every month.
 */

export const dashboardAppointmentSchema = z.object({
  id: cuidSchema,
  reference: z.string(),
  startsAt: isoInstantSchema,
  endsAt: isoInstantSchema,
  employeeId: cuidSchema,
  employeeName: z.string(),
  serviceName: z.string(),
  customerName: z.string(),
  displayStatus: displayStatusSchema,
});

/**
 * What is wrong with the machinery, in numbers an operator can act on.
 *
 * On the dashboard rather than in a separate admin screen, because the person who would
 * notice "no confirmation emails went out this morning" is the person opening this page —
 * not somebody watching a metrics dashboard the business does not have.
 */
export const operationsHealthSchema = z.object({
  /** Jobs BullMQ has given up on. */
  failedJobs: z.number().int(),
  /** Outbox rows that should have been dispatched by now and were not. */
  stuckOutboxRows: z.number().int(),
  /** Notifications still waiting to be sent. */
  pendingNotifications: z.number().int(),
  /** Provider webhooks received and not yet processed. */
  unprocessedWebhooks: z.number().int(),
  /** Appointments that ended long ago and were never completed or marked no-show. */
  overdueCompletions: z.number().int(),
});

export const officeDashboardResponseSchema = z.object({
  /** Today in the organization's timezone, not in UTC. */
  today: z.array(dashboardAppointmentSchema),
  next7DaysCount: z.number().int(),
  pendingCancellationRequests: z.number().int(),
  pendingRescheduleRequests: z.number().int(),
  /** Confirmed bookings whose payments do not yet cover the price they were sold at. */
  unpaidConfirmedBookings: z.number().int(),
  /** What was actually received today, card and cash together. */
  todayRevenue: moneySchema,
  operations: operationsHealthSchema,
});

export type OfficeDashboardResponse = z.infer<typeof officeDashboardResponseSchema>;
export type OperationsHealth = z.infer<typeof operationsHealthSchema>;
