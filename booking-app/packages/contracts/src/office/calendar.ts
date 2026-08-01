import { z } from 'zod';

import {
  bookingOriginSchema,
  bookingStatusSchema,
  displayStatusSchema,
  weekdaySchema,
} from '../enums.js';
import { cuidSchema, isoInstantSchema, localDateSchema, moneySchema } from '../primitives.js';

/**
 * The office calendar.
 *
 * A bounded window rather than a page. Paginating a calendar is a worse interface than
 * refusing a range nobody meant to ask for, so the range is capped and everything inside
 * it comes back at once — which is also what lets the client draw a week without a second
 * call per employee.
 */

/** The widest range the calendar will answer, in days. Two months plus a little. */
export const MAX_CALENDAR_RANGE_DAYS = 62;

/** Days between two `YYYY-MM-DD` strings, inclusive of both ends. */
function inclusiveDaySpan(from: string, to: string): number {
  const parse = (value: string): number => {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1);
  };

  return (parse(to) - parse(from)) / 86_400_000 + 1;
}

export const officeCalendarQuerySchema = z
  .object({
    from: localDateSchema,
    to: localDateSchema,
    /** Absent means every employee the caller may see, which the session decides. */
    employeeId: cuidSchema.optional(),
    /**
     * Include bookings that no longer hold their slot.
     *
     * Off by default, because a calendar showing expired and cancelled appointments
     * beside live ones is how somebody double-books a slot they thought was taken.
     */
    includeInactive: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .refine((query) => query.from <= query.to, {
    message: 'from must not be after to',
    path: ['from'],
  })
  .refine((query) => inclusiveDaySpan(query.from, query.to) <= MAX_CALENDAR_RANGE_DAYS, {
    message: `the range must not exceed ${String(MAX_CALENDAR_RANGE_DAYS)} days`,
    path: ['to'],
  });

export type OfficeCalendarQuery = z.infer<typeof officeCalendarQuerySchema>;

/**
 * One appointment, as the office sees it.
 *
 * `blockStartsAt`/`blockEndsAt` are the span the slot actually occupies — the
 * appointment plus its cleanup buffer — and they are separate from `startsAt`/`endsAt`
 * because the calendar has to draw both: the customer's hour, and the reason the next
 * hour is unavailable.
 */
export const calendarBookingSchema = z.object({
  id: cuidSchema,
  reference: z.string(),
  /** The stored status. */
  status: bookingStatusSchema,
  /** What to show, which differs while a request is open. See `displayStatus`. */
  displayStatus: displayStatusSchema,
  startsAt: isoInstantSchema,
  endsAt: isoInstantSchema,
  blockStartsAt: isoInstantSchema,
  blockEndsAt: isoInstantSchema,
  employeeId: cuidSchema,
  serviceId: cuidSchema,
  serviceName: z.string(),
  customerName: z.string(),
  origin: bookingOriginSchema,
  price: moneySchema,
});

export const calendarBlockedTimeSchema = z.object({
  id: cuidSchema,
  employeeId: cuidSchema,
  startsAt: isoInstantSchema,
  endsAt: isoInstantSchema,
  reason: z.string().nullable(),
});

export const calendarTimeOffSchema = z.object({
  id: cuidSchema,
  employeeId: cuidSchema,
  /** Inclusive local dates: the employee is away for the whole of `endDate`. */
  startDate: localDateSchema,
  endDate: localDateSchema,
  reason: z.string().nullable(),
});

export const calendarClosedDaySchema = z.object({
  date: localDateSchema,
  reason: z.string().nullable(),
});

/**
 * The recurring shape of a week, with breaks nested.
 *
 * Sent as the rule rather than as materialised days: expanding a two-month range into
 * per-day envelopes would multiply the payload for information the client can draw from
 * seven rows per employee.
 */
export const calendarWorkingHoursSchema = z.object({
  employeeId: cuidSchema,
  // The shared enum, not a copy: `enum-drift.spec.ts` cross-checks that one against
  // Prisma, and a second literal list here would be outside its reach.
  weekday: weekdaySchema,
  startMinute: z.number().int(),
  endMinute: z.number().int(),
  breaks: z.array(
    z.object({
      startMinute: z.number().int(),
      endMinute: z.number().int(),
      label: z.string().nullable(),
    }),
  ),
});

export const officeCalendarResponseSchema = z.object({
  bookings: z.array(calendarBookingSchema),
  blockedTimes: z.array(calendarBlockedTimeSchema),
  timeOff: z.array(calendarTimeOffSchema),
  closedDays: z.array(calendarClosedDaySchema),
  workingHours: z.array(calendarWorkingHoursSchema),
});

export type OfficeCalendarResponse = z.infer<typeof officeCalendarResponseSchema>;
export type CalendarBooking = z.infer<typeof calendarBookingSchema>;
