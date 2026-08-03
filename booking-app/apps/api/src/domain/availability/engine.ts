import { contains, overlaps, subtract } from '../time/interval.js';
import {
  addLocalDays,
  eachLocalDate,
  instantToLocalDate,
  wallClockToInstant,
  weekdayOf,
} from '../time/local-time.js';

import type {
  AvailabilityResult,
  AvailabilitySnapshot,
  DaySlots,
  EmployeeSnapshot,
  SkippedLocalTime,
  Slot,
  WorkingHoursSnapshot,
} from './types.js';
import type { Interval } from '../time/interval.js';
import type { LocalDate, MinuteOfDay } from '../time/local-time.js';

/**
 * Slot generation, as a pure function.
 *
 * The rules it applies, in the order a studio would describe them:
 *
 *  1. Not on an organization-wide closed day.
 *  2. Not while the employee has approved time off.
 *  3. Inside the employee's hours for that weekday — or the one-off exception
 *     for that date, which replaces them rather than adding to them.
 *  4. Not overlapping a break.
 *  5. Not overlapping anything the employee is already committed to.
 *  6. Far enough ahead to respect the minimum notice.
 *  7. Not beyond the booking horizon.
 *
 * Two properties are load-bearing and easy to get wrong:
 *
 *  - The grid is anchored at the start of each segment, not at midnight, so a
 *    shift starting at 09:00 offers 09:00 and not 09:05.
 *  - Buffers are *employee* time and must fit inside the shift, so a service with
 *    ten minutes of prep cannot start at the very first minute of a shift. The
 *    customer never sees them: `startsAt` and `endsAt` exclude buffers, while the
 *    block that must fit — and that the exclusion constraint stores — includes
 *    them.
 */

export interface Segment {
  startMinute: MinuteOfDay;
  endMinute: MinuteOfDay;
  breaks: { startMinute: MinuteOfDay; endMinute: MinuteOfDay }[];
}

/**
 * The employee's segments for one local date.
 *
 * A CLOSED exception empties the day. An EXTRA_HOURS exception replaces the
 * recurring hours. Only if there is no exception do the weekday's working hours
 * apply.
 *
 * Exported because the office's conflict reporting — "these appointments no longer
 * fall inside the hours you just saved" — has to ask the same question this asks, and
 * a second implementation of "which rule applies on this date" would be the one that
 * disagrees about an EXTRA_HOURS Saturday.
 */
export function segmentsFor(employee: EmployeeSnapshot, date: LocalDate, zone: string): Segment[] {
  const exceptions = employee.exceptions.filter((exception) => exception.date === date);

  if (exceptions.some((exception) => exception.kind === 'CLOSED')) return [];

  // Built with a loop rather than filter+map so the minute bounds narrow to
  // non-null without an assertion. A database CHECK guarantees EXTRA_HOURS
  // carries both bounds, but the engine should not depend on that to be sound.
  const extraHours: Segment[] = [];
  for (const exception of exceptions) {
    if (exception.kind !== 'EXTRA_HOURS') continue;
    const { startMinute, endMinute } = exception;
    if (startMinute === null || endMinute === null) continue;
    extraHours.push({ startMinute, endMinute, breaks: [] });
  }

  if (extraHours.length > 0) return extraHours;

  const weekday = weekdayOf(date, zone);
  return employee.workingHours
    .filter((hours: WorkingHoursSnapshot) => hours.weekday === weekday)
    .map((hours) => ({
      startMinute: hours.startMinute,
      endMinute: hours.endMinute,
      breaks: hours.breaks,
    }));
}

/** Candidate start minutes on the grid, anchored at the segment start. */
function gridMinutes(segment: Segment, intervalMinutes: number): MinuteOfDay[] {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error(
      `Scheduling interval must be a positive integer, received ${String(intervalMinutes)}.`,
    );
  }

  const minutes: MinuteOfDay[] = [];
  for (let minute = segment.startMinute; minute <= segment.endMinute; minute += intervalMinutes) {
    minutes.push(minute);
  }
  return minutes;
}

/**
 * Slots one employee can offer on one date.
 *
 * Every candidate is converted from wall clock individually. On a DST transition
 * day some conversions fail, and those minutes are skipped and reported rather
 * than shifted into an hour the customer was never quoted.
 */
function employeeSlotsFor(
  snapshot: AvailabilitySnapshot,
  employee: EmployeeSnapshot,
  date: LocalDate,
  earliestStart: Date,
  skipped: SkippedLocalTime[],
): Date[] {
  if (employee.timeOffDates.includes(date)) return [];

  const { zone, service, settings } = snapshot;
  const durationMs = service.durationMinutes * 60_000;
  const prepMs = service.prepBufferMinutes * 60_000;
  const cleanupMs = service.cleanupBufferMinutes * 60_000;

  const starts: Date[] = [];

  for (const segment of segmentsFor(employee, date, zone)) {
    const segmentStart = wallClockToInstant(date, segment.startMinute, zone);
    const segmentEnd = wallClockToInstant(date, segment.endMinute, zone);

    // A shift bound that lands inside a transition cannot be placed on the
    // timeline at all, so the whole segment is unusable for this date.
    if (!segmentStart.ok || !segmentEnd.ok) {
      if (!segmentStart.ok) {
        skipped.push({
          employeeId: employee.employeeId,
          date,
          minute: segment.startMinute,
          reason: segmentStart.reason,
        });
      }
      if (!segmentEnd.ok) {
        skipped.push({
          employeeId: employee.employeeId,
          date,
          minute: segment.endMinute,
          reason: segmentEnd.reason,
        });
      }
      continue;
    }

    const segmentInterval: Interval = { start: segmentStart.instant, end: segmentEnd.instant };

    const breakIntervals: Interval[] = [];
    let hasUnplaceableBreak = false;
    for (const rest of segment.breaks) {
      const from = wallClockToInstant(date, rest.startMinute, zone);
      const to = wallClockToInstant(date, rest.endMinute, zone);
      if (from.ok && to.ok) {
        breakIntervals.push({ start: from.instant, end: to.instant });
        continue;
      }

      hasUnplaceableBreak = true;
      if (!from.ok) {
        skipped.push({
          employeeId: employee.employeeId,
          date,
          minute: rest.startMinute,
          reason: from.reason,
        });
      }
      if (!to.ok) {
        skipped.push({
          employeeId: employee.employeeId,
          date,
          minute: rest.endMinute,
          reason: to.reason,
        });
      }
    }

    if (hasUnplaceableBreak) continue;

    // Break-free stretches of the shift. A booking's block must fit inside one.
    const pieces = subtract(segmentInterval, breakIntervals);

    for (const minute of gridMinutes(segment, settings.schedulingIntervalMinutes)) {
      const candidate = wallClockToInstant(date, minute, zone);

      if (!candidate.ok) {
        skipped.push({
          employeeId: employee.employeeId,
          date,
          minute,
          reason: candidate.reason,
        });
        continue;
      }

      const startsAt = candidate.instant;
      if (startsAt.getTime() < earliestStart.getTime()) continue;

      const block: Interval = {
        start: new Date(startsAt.getTime() - prepMs),
        end: new Date(startsAt.getTime() + durationMs + cleanupMs),
      };

      if (!pieces.some((piece) => contains(piece, block))) continue;
      if (employee.busy.some((busy) => overlaps(block, busy))) continue;

      starts.push(startsAt);
    }
  }

  return starts;
}

/**
 * Generate bookable slots for a local date range.
 *
 * The requested range is clamped to `[today, today + bookingHorizonDays]`, so a
 * caller cannot see past the horizon by asking nicely.
 */
export function generateAvailability(
  snapshot: AvailabilitySnapshot,
  from: LocalDate,
  to: LocalDate,
): AvailabilityResult {
  const { zone, settings, service, closedDates, employees } = snapshot;

  const today = instantToLocalDate(snapshot.now, zone);
  const horizonEnd = addLocalDays(today, settings.bookingHorizonDays, zone);

  // ISO dates compare correctly as strings, which is why the format is fixed.
  const rangeStart = from < today ? today : from;
  const rangeEnd = to > horizonEnd ? horizonEnd : to;

  const earliestStart = new Date(snapshot.now.getTime() + settings.minimumNoticeHours * 3_600_000);
  const closed = new Set(closedDates);
  const durationMs = service.durationMinutes * 60_000;

  const skipped: SkippedLocalTime[] = [];
  const days: DaySlots[] = [];

  for (const date of eachLocalDate(rangeStart, rangeEnd, zone)) {
    if (closed.has(date)) {
      days.push({ date, slots: [] });
      continue;
    }

    // Merge across employees, so one slot lists everyone who could take it.
    const employeesByStart = new Map<number, Set<string>>();

    for (const employee of employees) {
      for (const startsAt of employeeSlotsFor(snapshot, employee, date, earliestStart, skipped)) {
        const key = startsAt.getTime();
        const existing = employeesByStart.get(key);
        if (existing) existing.add(employee.employeeId);
        else employeesByStart.set(key, new Set([employee.employeeId]));
      }
    }

    const slots: Slot[] = [...employeesByStart.entries()]
      .sort(([left], [right]) => left - right)
      .map(([startMillis, employeeIds]) => ({
        startsAt: new Date(startMillis),
        endsAt: new Date(startMillis + durationMs),
        // Sorted for determinism: the same snapshot must render identically.
        employeeIds: [...employeeIds].sort(),
      }));

    days.push({ date, slots });
  }

  return { days, skipped };
}

/**
 * Whether one employee can take one exact instant.
 *
 * Implemented by generating that employee's slots for that date and testing
 * membership, rather than by re-deriving the rules. The reservation transaction
 * calls this under the per-employee advisory lock while the public endpoint calls
 * generateAvailability, so the two answering differently would mean offering a
 * slot that cannot be booked — or refusing one that could. Sharing the
 * implementation makes disagreement impossible rather than merely unlikely.
 */
export function isSlotBookable(
  snapshot: AvailabilitySnapshot,
  employeeId: string,
  startsAt: Date,
): boolean {
  const employee = snapshot.employees.find((candidate) => candidate.employeeId === employeeId);
  if (!employee) return false;

  const date = instantToLocalDate(startsAt, snapshot.zone);
  const { days } = generateAvailability({ ...snapshot, employees: [employee] }, date, date);

  return (days[0]?.slots ?? []).some((slot) => slot.startsAt.getTime() === startsAt.getTime());
}
