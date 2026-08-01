import type { Weekday } from '../../prisma/client.js';
import type { Interval } from '../time/interval.js';
import type { LocalDate, MinuteOfDay } from '../time/local-time.js';

/**
 * The inputs the availability engine needs, as plain data.
 *
 * Deliberately free of Prisma types. The engine is a pure function over a
 * snapshot, so it cannot reach the database, cannot issue an N+1 query, and can
 * be tested exhaustively — including on the two days a year the wall clock
 * misbehaves — without any infrastructure at all. Loading the snapshot is the
 * caller's job and is where query count is controlled.
 */

export interface AvailabilitySettings {
  /** Grid step, anchored at the start of each working-hours segment. */
  schedulingIntervalMinutes: number;
  /** How far ahead of `now` the earliest bookable slot may be. */
  minimumNoticeHours: number;
  /** How many local days ahead of today may be booked. */
  bookingHorizonDays: number;
}

export interface AvailabilityServiceSnapshot {
  id: string;
  durationMinutes: number;
  /** Employee time before the appointment. Invisible to the customer. */
  prepBufferMinutes: number;
  /** Employee time after the appointment. Invisible to the customer. */
  cleanupBufferMinutes: number;
}

export interface BreakSnapshot {
  startMinute: MinuteOfDay;
  endMinute: MinuteOfDay;
}

export interface WorkingHoursSnapshot {
  weekday: Weekday;
  startMinute: MinuteOfDay;
  endMinute: MinuteOfDay;
  breaks: BreakSnapshot[];
}

export interface AvailabilityExceptionSnapshot {
  date: LocalDate;
  /**
   * EXTRA_HOURS *replaces* the day's recurring hours rather than adding to
   * them: an office setting special Saturday hours means "these hours", not
   * "these plus the usual".
   */
  kind: 'EXTRA_HOURS' | 'CLOSED';
  startMinute: MinuteOfDay | null;
  endMinute: MinuteOfDay | null;
}

export interface EmployeeSnapshot {
  employeeId: string;
  workingHours: WorkingHoursSnapshot[];
  exceptions: AvailabilityExceptionSnapshot[];
  /** Expanded from APPROVED time-off ranges. REQUESTED rows do not block. */
  timeOffDates: LocalDate[];
  /**
   * Everything already occupying this employee, in block time (buffers
   * included): bookings in a blocking status, and blocked times.
   */
  busy: Interval[];
}

export interface AvailabilitySnapshot {
  zone: string;
  now: Date;
  settings: AvailabilitySettings;
  service: AvailabilityServiceSnapshot;
  /** Organization-wide closures, which remove the day for every employee. */
  closedDates: LocalDate[];
  /** Only employees who perform the service, and are bookable. */
  employees: EmployeeSnapshot[];
}

export interface Slot {
  /** What the customer is told. Excludes buffers. */
  startsAt: Date;
  endsAt: Date;
  /**
   * Every employee who could take this slot, sorted. Lets the front end offer
   * "any available employee" without a second round trip.
   */
  employeeIds: string[];
}

export interface DaySlots {
  date: LocalDate;
  slots: Slot[];
}

/** A local time that could not be converted, so no slot was offered for it. */
export interface SkippedLocalTime {
  employeeId: string;
  date: LocalDate;
  minute: MinuteOfDay;
  reason: 'NONEXISTENT' | 'AMBIGUOUS';
}

export interface AvailabilityResult {
  days: DaySlots[];
  /**
   * Non-empty only around a DST transition. Returned rather than logged so the
   * engine stays pure, and so a caller can log it at debug and a test can assert
   * on it.
   */
  skipped: SkippedLocalTime[];
}
