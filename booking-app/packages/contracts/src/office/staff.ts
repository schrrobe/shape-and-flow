import { z } from 'zod';

import { availabilityExceptionKindSchema, timeOffStatusSchema, weekdaySchema } from '../enums.js';
import {
  booleanQuery,
  cuidSchema,
  isoInstantSchema,
  localDateSchema,
  minuteOfDaySchema,
} from '../primitives.js';

import { MAX_CALENDAR_RANGE_DAYS, inclusiveDaySpan } from './calendar.js';

/**
 * Staff and the shape of their availability.
 *
 * Everything an office can say about *when* somebody is free lives here, and it says it
 * in four different vocabularies on purpose:
 *
 *  - **Working hours** are a recurring weekly rule, in minutes from local midnight.
 *  - **Availability exceptions** replace one date's rule.
 *  - **Time off** is a run of whole local dates.
 *  - **Blocked time** is a span of instants on one day.
 *
 * A single "unavailability" type would have to be all four at once, and the collapse
 * would show up as a leave request that starts at 09:00 because somebody had to pick an
 * hour for a day.
 */

/* ── employees ────────────────────────────────────────────────────────────────── */

export const officeEmployeeSchema = z.object({
  id: cuidSchema,
  firstName: z.string(),
  lastName: z.string(),
  /** What a customer sees. Defaults to first plus last, but is editable. */
  displayName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  bio: z.string().nullable(),
  photoUrl: z.string().nullable(),
  /** Second tie-breaker in "any available employee", so this is not merely cosmetic. */
  displayOrder: z.number().int(),
  isBookableOnline: z.boolean(),
  archivedAt: isoInstantSchema.nullable(),
});

export type OfficeEmployee = z.infer<typeof officeEmployeeSchema>;

export const employeeListQuerySchema = z.object({
  includeArchived: booleanQuery(false),
});

export const employeeListResponseSchema = z.object({ items: z.array(officeEmployeeSchema) });
export type EmployeeListResponse = z.infer<typeof employeeListResponseSchema>;

export const createEmployeeSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  /** Absent means "first last", which is what an office means nine times in ten. */
  displayName: z.string().trim().min(1).max(100).optional(),
  email: z.email().max(320).nullish(),
  phone: z.string().trim().max(50).nullish(),
  bio: z.string().max(2000).nullish(),
  photoUrl: z.url().max(2000).nullish(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  isBookableOnline: z.boolean().optional(),
});

export type CreateEmployeeRequest = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = createEmployeeSchema.partial();
export type UpdateEmployeeRequest = z.infer<typeof updateEmployeeSchema>;

/* ── working hours ────────────────────────────────────────────────────────────── */

export const workingHoursBreakSchema = z.object({
  startMinute: minuteOfDaySchema,
  endMinute: minuteOfDaySchema,
  label: z.string().trim().max(100).nullish(),
});

/** Half-open on the minute axis: `[start, end)`, so 12:30–13:00 abuts 13:00–14:00. */
function overlapping(spans: readonly { startMinute: number; endMinute: number }[]): boolean {
  const ordered = [...spans].sort((left, right) => left.startMinute - right.startMinute);

  return ordered.some((span, index) => {
    const next = ordered[index + 1];
    return next !== undefined && next.startMinute < span.endMinute;
  });
}

/**
 * One shift on one weekday, with its breaks.
 *
 * The three refinements are here rather than in a service because they are properties
 * of the payload alone: a browser can check them before the request is sent, and the
 * API cannot forget to.
 */
export const workingHoursSegmentSchema = z
  .object({
    weekday: weekdaySchema,
    startMinute: minuteOfDaySchema,
    endMinute: minuteOfDaySchema,
    breaks: z.array(workingHoursBreakSchema).max(10).default([]),
  })
  .refine((segment) => segment.endMinute > segment.startMinute, {
    message: 'endMinute must be after startMinute',
    path: ['endMinute'],
  })
  .refine((segment) => segment.breaks.every((rest) => rest.endMinute > rest.startMinute), {
    message: 'a break must end after it starts',
    path: ['breaks'],
  })
  .refine(
    (segment) =>
      segment.breaks.every(
        (rest) => rest.startMinute >= segment.startMinute && rest.endMinute <= segment.endMinute,
      ),
    {
      // A break outside its shift is not a smaller shift, it is a contradiction: the
      // engine subtracts breaks from the segment and would silently subtract nothing.
      message: 'a break must lie inside the segment that contains it',
      path: ['breaks'],
    },
  )
  .refine((segment) => !overlapping(segment.breaks), {
    message: 'breaks must not overlap each other',
    path: ['breaks'],
  });

/**
 * The whole week, replaced at once.
 *
 * `PUT` rather than per-segment `POST`/`DELETE`, because a week is edited as a week: a
 * client that has to express "Monday now looks like this" as three deletes and two
 * inserts will eventually apply half of them.
 */
export const replaceWorkingHoursSchema = z
  .object({
    segments: z.array(workingHoursSegmentSchema).max(35),
  })
  .refine(
    (body) =>
      weekdaySchema.options.every(
        (weekday) => !overlapping(body.segments.filter((segment) => segment.weekday === weekday)),
      ),
    {
      message: 'segments on the same weekday must not overlap',
      path: ['segments'],
    },
  );

export type ReplaceWorkingHoursRequest = z.infer<typeof replaceWorkingHoursSchema>;

/** A confirmed appointment the new hours no longer cover. */
export const conflictingBookingSchema = z.object({
  id: cuidSchema,
  reference: z.string(),
  startsAt: isoInstantSchema,
  endsAt: isoInstantSchema,
  customerName: z.string(),
  serviceName: z.string(),
});

export type ConflictingBooking = z.infer<typeof conflictingBookingSchema>;

/**
 * The result of replacing a week.
 *
 * Conflicts are **reported, not enforced**. An office shortening somebody's Friday
 * knows about the two appointments already booked into the removed hours, and refusing
 * the change would leave them editing a week they cannot save; cancelling the
 * appointments for them would be worse still. So the new hours are written and the
 * appointments come back in the response for a human to deal with.
 */
export const replaceWorkingHoursResponseSchema = z.object({
  segments: z.array(
    z.object({
      id: cuidSchema,
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
    }),
  ),
  conflictingBookings: z.array(conflictingBookingSchema),
});

export type ReplaceWorkingHoursResponse = z.infer<typeof replaceWorkingHoursResponseSchema>;

/* ── employee ↔ service assignment ────────────────────────────────────────────── */

export const employeeServiceAssignmentSchema = z.object({
  serviceId: cuidSchema,
  /** Absent or null means this employee charges the service's list price. */
  priceOverrideCents: z.number().int().min(0).max(10_000_000).nullish(),
});

export const replaceEmployeeServicesSchema = z
  .object({
    assignments: z.array(employeeServiceAssignmentSchema).max(200),
  })
  .refine(
    (body) =>
      new Set(body.assignments.map((assignment) => assignment.serviceId)).size ===
      body.assignments.length,
    {
      // Two entries for one service would make the override ambiguous, and the last one
      // winning is a silent answer to a question the caller did not know they asked.
      message: 'a service may appear at most once',
      path: ['assignments'],
    },
  );

export type ReplaceEmployeeServicesRequest = z.infer<typeof replaceEmployeeServicesSchema>;

export const employeeServicesResponseSchema = z.object({
  items: z.array(
    z.object({
      serviceId: cuidSchema,
      serviceName: z.string(),
      /** Null when there is no override; `effectivePriceCents` already accounts for it. */
      priceOverrideCents: z.number().int().nullable(),
      listPriceCents: z.number().int(),
      effectivePriceCents: z.number().int(),
      currency: z.string().length(3),
    }),
  ),
});

export type EmployeeServicesResponse = z.infer<typeof employeeServicesResponseSchema>;

/* ── availability exceptions ──────────────────────────────────────────────────── */

export const availabilityExceptionSchema = z.object({
  id: cuidSchema,
  employeeId: cuidSchema,
  date: localDateSchema,
  kind: availabilityExceptionKindSchema,
  startMinute: z.number().int().nullable(),
  endMinute: z.number().int().nullable(),
  reason: z.string().nullable(),
});

/**
 * A discriminated union, mirroring the database `CHECK`.
 *
 * `CLOSED` must carry no minutes and `EXTRA_HOURS` must carry both; a single object
 * with two nullable minute fields would make "closed, from 14:00" expressible in the
 * type and rejectable only at the storage layer.
 */
export const createAvailabilityExceptionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('CLOSED'),
    date: localDateSchema,
    reason: z.string().trim().max(200).nullish(),
  }),
  z
    .object({
      kind: z.literal('EXTRA_HOURS'),
      date: localDateSchema,
      startMinute: minuteOfDaySchema,
      endMinute: minuteOfDaySchema,
      reason: z.string().trim().max(200).nullish(),
    })
    .refine((exception) => exception.endMinute > exception.startMinute, {
      message: 'endMinute must be after startMinute',
      path: ['endMinute'],
    }),
]);

export type CreateAvailabilityExceptionRequest = z.infer<typeof createAvailabilityExceptionSchema>;

/**
 * Creating an exception answers with conflicts too.
 *
 * Closing a Tuesday somebody is already booked into is a thing an office is allowed to
 * do and a thing it has to be told about — the same trade the working-hours replacement
 * makes, and the same shape, so a client renders one warning list rather than two.
 */
export const createAvailabilityExceptionResponseSchema = z.object({
  exception: availabilityExceptionSchema,
  conflictingBookings: z.array(conflictingBookingSchema),
});

export type CreateAvailabilityExceptionResponse = z.infer<
  typeof createAvailabilityExceptionResponseSchema
>;

export const availabilityExceptionListResponseSchema = z.object({
  items: z.array(availabilityExceptionSchema),
});

export type AvailabilityExceptionListResponse = z.infer<
  typeof availabilityExceptionListResponseSchema
>;

/* ── time off ─────────────────────────────────────────────────────────────────── */

export const timeOffSchema = z.object({
  id: cuidSchema,
  employeeId: cuidSchema,
  /** Inclusive local dates: the employee is away for the whole of `endDate`. */
  startDate: localDateSchema,
  endDate: localDateSchema,
  status: timeOffStatusSchema,
  reason: z.string().nullable(),
  createdAt: isoInstantSchema,
});

export const createTimeOffSchema = z
  .object({
    employeeId: cuidSchema,
    startDate: localDateSchema,
    endDate: localDateSchema,
    /**
     * Approved by default. Phase 1 has no approval queue — an office recording leave
     * *is* the decision — but the column exists so one can be added without a
     * migration, and `REQUESTED` deliberately does not free the calendar.
     */
    status: timeOffStatusSchema.default('APPROVED'),
    reason: z.string().trim().max(200).nullish(),
  })
  .refine((body) => body.startDate <= body.endDate, {
    message: 'endDate must not be before startDate',
    path: ['endDate'],
  });

export type CreateTimeOffRequest = z.infer<typeof createTimeOffSchema>;

export const updateTimeOffSchema = z.object({
  status: timeOffStatusSchema,
  reason: z.string().trim().max(200).nullish(),
});

export type UpdateTimeOffRequest = z.infer<typeof updateTimeOffSchema>;

export const timeOffListQuerySchema = z.object({
  employeeId: cuidSchema.optional(),
  /** Absent means every status, so a list is not silently filtered to the approved. */
  status: timeOffStatusSchema.optional(),
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
});

export type TimeOffListQuery = z.infer<typeof timeOffListQuerySchema>;

export const timeOffListResponseSchema = z.object({ items: z.array(timeOffSchema) });
export type TimeOffListResponse = z.infer<typeof timeOffListResponseSchema>;
export type TimeOffEntry = z.infer<typeof timeOffSchema>;

/* ── blocked time ─────────────────────────────────────────────────────────────── */

export const blockedTimeSchema = z.object({
  id: cuidSchema,
  employeeId: cuidSchema,
  startsAt: isoInstantSchema,
  endsAt: isoInstantSchema,
  reason: z.string().nullable(),
  createdAt: isoInstantSchema,
});

export const createBlockedTimeSchema = z
  .object({
    employeeId: cuidSchema,
    startsAt: isoInstantSchema,
    endsAt: isoInstantSchema,
    reason: z.string().trim().max(200).nullish(),
  })
  .refine((body) => body.endsAt > body.startsAt, {
    // ISO-8601 with a fixed shape compares correctly as a string, which is the reason
    // the instant format is pinned rather than merely documented.
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });

export type CreateBlockedTimeRequest = z.infer<typeof createBlockedTimeSchema>;

export const blockedTimeListQuerySchema = z
  .object({
    employeeId: cuidSchema.optional(),
    from: localDateSchema,
    to: localDateSchema,
  })
  .refine((query) => query.from <= query.to, {
    message: 'from must not be after to',
    path: ['from'],
  })
  .refine((query) => inclusiveDaySpan(query.from, query.to) <= MAX_CALENDAR_RANGE_DAYS, {
    message: `the range must not exceed ${String(MAX_CALENDAR_RANGE_DAYS)} days`,
    path: ['to'],
  });

export type BlockedTimeListQuery = z.infer<typeof blockedTimeListQuerySchema>;
export type BlockedTime = z.infer<typeof blockedTimeSchema>;

export const blockedTimeListResponseSchema = z.object({ items: z.array(blockedTimeSchema) });
export type BlockedTimeListResponse = z.infer<typeof blockedTimeListResponseSchema>;

/* ── closed days ──────────────────────────────────────────────────────────────── */

export const closedDaySchema = z.object({
  id: cuidSchema,
  date: localDateSchema,
  reason: z.string().nullable(),
});

export const createClosedDaySchema = z.object({
  date: localDateSchema,
  reason: z.string().trim().max(200).nullish(),
});

export type CreateClosedDayRequest = z.infer<typeof createClosedDaySchema>;

export const closedDayListQuerySchema = z
  .object({
    from: localDateSchema,
    to: localDateSchema,
  })
  .refine((query) => query.from <= query.to, {
    message: 'from must not be after to',
    path: ['from'],
  })
  .refine((query) => inclusiveDaySpan(query.from, query.to) <= MAX_CALENDAR_RANGE_DAYS, {
    message: `the range must not exceed ${String(MAX_CALENDAR_RANGE_DAYS)} days`,
    path: ['to'],
  });

export type ClosedDayListQuery = z.infer<typeof closedDayListQuerySchema>;
export type ClosedDay = z.infer<typeof closedDaySchema>;

export const closedDayListResponseSchema = z.object({ items: z.array(closedDaySchema) });
export type ClosedDayListResponse = z.infer<typeof closedDayListResponseSchema>;
