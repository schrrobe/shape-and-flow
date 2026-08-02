import { localDateOf, minutesFromLocalMidnight } from '../../office/format.js';

import type { CalendarBooking, OfficeCalendarResponse } from '@shape-and-flow/booking-contracts';

/**
 * Turning a calendar response into positions on a grid.
 *
 * Pure functions, separate from the component, because the interesting part is
 * arithmetic and the arithmetic has one way to be wrong: reading the clock in the
 * browser's timezone instead of the business's. `new Date(iso).getHours()` answers in
 * whatever zone the operator's laptop is set to, so an appointment at 09:00 in Berlin
 * would sit at 08:00 for somebody in London and at 03:00 for somebody on holiday in New
 * York. Every position here goes through `minutesFromLocalMidnight`, which formats in
 * `Europe/Berlin` and reads the parts back.
 */

/** A block on the grid, in minutes from local midnight. */
export interface Placement {
  startMinute: number;
  endMinute: number;
}

export interface BookingPlacement extends Placement {
  booking: CalendarBooking;
  /** The prep buffer, when there is one. Drawn separately from the appointment. */
  before: Placement | null;
  /** The cleanup buffer, when there is one. */
  after: Placement | null;
}

/**
 * Where a booking sits, and where its buffers sit.
 *
 * Buffers are drawn as their own bands rather than as a taller appointment, because they
 * mean something different: the customer's hour is the appointment, and the buffer is the
 * reason the next hour is unavailable. An operator looking for a gap has to be able to
 * tell those apart at a glance.
 *
 * A booking whose block starts on the previous local day — a prep buffer crossing
 * midnight — is clamped to the top of the day rather than given a negative offset, which
 * would place it above the grid.
 */
export function placeBooking(booking: CalendarBooking, date: string): BookingPlacement {
  const startMinute = clampToDay(booking.startsAt, date, 'start');
  const endMinute = clampToDay(booking.endsAt, date, 'end');
  const blockStart = clampToDay(booking.blockStartsAt, date, 'start');
  const blockEnd = clampToDay(booking.blockEndsAt, date, 'end');

  return {
    booking,
    startMinute,
    endMinute,
    before: blockStart < startMinute ? { startMinute: blockStart, endMinute: startMinute } : null,
    after: blockEnd > endMinute ? { startMinute: endMinute, endMinute: blockEnd } : null,
  };
}

/**
 * An instant as minutes into `date`, clamped to that day.
 *
 * `edge` decides which way something outside the day is pulled: a start before the day
 * becomes 0, an end after it becomes 1440. Without this a booking spanning midnight
 * renders with a negative height.
 */
function clampToDay(instant: string, date: string, edge: 'start' | 'end'): number {
  const on = localDateOf(instant);

  if (on < date) return edge === 'start' ? 0 : 0;
  if (on > date) return edge === 'start' ? 1440 : 1440;

  return minutesFromLocalMidnight(instant);
}

/** Blocked time on this date, as bands. */
export function placeBlockedTimes(
  calendar: Pick<OfficeCalendarResponse, 'blockedTimes'>,
  employeeId: string,
  date: string,
): (Placement & { id: string; reason: string | null })[] {
  return calendar.blockedTimes
    .filter((blocked) => blocked.employeeId === employeeId)
    .filter((blocked) => overlapsDay(blocked.startsAt, blocked.endsAt, date))
    .map((blocked) => ({
      id: blocked.id,
      reason: blocked.reason,
      startMinute: clampToDay(blocked.startsAt, date, 'start'),
      endMinute: clampToDay(blocked.endsAt, date, 'end'),
    }));
}

function overlapsDay(startsAt: string, endsAt: string, date: string): boolean {
  return localDateOf(startsAt) <= date && localDateOf(endsAt) >= date;
}

/** True when this employee has approved leave covering the date. */
export function hasTimeOff(
  calendar: Pick<OfficeCalendarResponse, 'timeOff'>,
  employeeId: string,
  date: string,
): boolean {
  return calendar.timeOff.some(
    (absence) =>
      absence.employeeId === employeeId && absence.startDate <= date && absence.endDate >= date,
  );
}

/**
 * The working bands for one employee on one date, breaks removed.
 *
 * Rendered as the *shaded* part of the column: everything outside them is time the
 * employee does not work, and a grid that drew 00:00–24:00 uniformly would make an
 * operator count rows to find out when somebody starts.
 */
export function workingBands(
  calendar: Pick<OfficeCalendarResponse, 'workingHours'>,
  employeeId: string,
  weekday: string,
): Placement[] {
  const segments = calendar.workingHours.filter(
    (hours) => hours.employeeId === employeeId && hours.weekday === weekday,
  );

  return segments.flatMap((segment) => {
    const holes = [...segment.breaks].sort((left, right) => left.startMinute - right.startMinute);
    const bands: Placement[] = [];
    let cursor = segment.startMinute;

    for (const hole of holes) {
      if (hole.startMinute > cursor)
        bands.push({ startMinute: cursor, endMinute: hole.startMinute });
      cursor = Math.max(cursor, hole.endMinute);
    }

    if (cursor < segment.endMinute)
      bands.push({ startMinute: cursor, endMinute: segment.endMinute });

    return bands;
  });
}

/**
 * The hours the grid draws.
 *
 * Bounded by what is actually on the day — the earliest shift or appointment to the
 * latest — rather than a fixed 00:00–24:00, so a studio open nine to six does not spend
 * two-thirds of the screen on the middle of the night. Padded by an hour each way and
 * never narrower than the working day.
 */
export function visibleRange(bounds: { startMinute: number; endMinute: number }[]): {
  from: number;
  to: number;
} {
  if (bounds.length === 0) return { from: 8 * 60, to: 20 * 60 };

  const earliest = Math.min(...bounds.map((bound) => bound.startMinute));
  const latest = Math.max(...bounds.map((bound) => bound.endMinute));

  return {
    from: Math.max(0, Math.floor((earliest - 60) / 60) * 60),
    to: Math.min(1440, Math.ceil((latest + 60) / 60) * 60),
  };
}

/** The weekday name a local date falls on, as the contract spells it. */
const WEEKDAYS = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
] as const;

export function weekdayOf(date: string): (typeof WEEKDAYS)[number] {
  // Noon UTC: a date parsed at midnight and read in Berlin is still the same day, but the
  // margin costs nothing and removes the question.
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? 'MONDAY';
}
