import { segmentsFor } from '../domain/availability/engine.js';
import { contains, subtract } from '../domain/time/interval.js';
import { instantToLocalDate, wallClockToInstant } from '../domain/time/local-time.js';

import type { EmployeeSnapshot } from '../domain/availability/types.js';
import type { Interval } from '../domain/time/interval.js';
import type { LocalDate } from '../domain/time/local-time.js';

/**
 * Which appointments a schedule no longer covers.
 *
 * The office is allowed to shorten somebody's Friday while two appointments sit in the
 * removed hours, and this is what tells it so. **Reported, not enforced** — refusing
 * would leave an office editing a week it cannot save, and cancelling on their behalf
 * would decide something only a person can.
 *
 * The rule for "which hours apply on this date" comes from the availability engine
 * rather than from a copy here, so an EXTRA_HOURS Saturday means the same thing to the
 * public slot generator and to this. What is repeated is only the arithmetic that turns
 * minutes into instants, and that has one correct answer.
 */

/** The break-free stretches of one employee's day, as instants. */
export function coveringIntervals(
  employee: EmployeeSnapshot,
  date: LocalDate,
  zone: string,
): Interval[] {
  const pieces: Interval[] = [];

  for (const segment of segmentsFor(employee, date, zone)) {
    const start = wallClockToInstant(date, segment.startMinute, zone);
    const end = wallClockToInstant(date, segment.endMinute, zone);

    // A shift bound inside a DST transition cannot be placed on the timeline, so the
    // segment covers nothing that day — the same answer the engine gives, which is why
    // an appointment there is reported as a conflict rather than silently kept.
    if (!start.ok || !end.ok) continue;

    const breaks: Interval[] = [];
    for (const rest of segment.breaks) {
      const from = wallClockToInstant(date, rest.startMinute, zone);
      const to = wallClockToInstant(date, rest.endMinute, zone);
      if (from.ok && to.ok) breaks.push({ start: from.instant, end: to.instant });
    }

    pieces.push(...subtract({ start: start.instant, end: end.instant }, breaks));
  }

  return pieces;
}

/** The blocking span of an appointment: the customer's time plus its buffers. */
export interface CoverableBooking {
  blockStartsAt: Date;
  blockEndsAt: Date;
}

/**
 * The appointments whose whole blocking span no longer fits inside a working stretch.
 *
 * Block span rather than appointment span, deliberately: a service with ten minutes of
 * cleanup needs those ten minutes inside the shift too, so an appointment ending
 * exactly at closing time *is* a conflict once its buffer is counted. That is the same
 * containment the engine applies when offering the slot in the first place.
 */
export function uncoveredBookings<Booking extends CoverableBooking>(
  bookings: readonly Booking[],
  employee: EmployeeSnapshot,
  zone: string,
): Booking[] {
  // One date resolves one set of intervals, and a day with several appointments is the
  // normal case — so the conversion is done once per date rather than once per booking.
  const byDate = new Map<LocalDate, Interval[]>();

  const intervalsFor = (date: LocalDate): Interval[] => {
    const cached = byDate.get(date);
    if (cached !== undefined) return cached;

    const computed = coveringIntervals(employee, date, zone);
    byDate.set(date, computed);
    return computed;
  };

  return bookings.filter((booking) => {
    // Keyed on the *block* start: a booking whose prep buffer reaches back into the
    // previous local day is covered by that day's late shift, not by this one's.
    const date = instantToLocalDate(booking.blockStartsAt, zone);
    const block: Interval = { start: booking.blockStartsAt, end: booking.blockEndsAt };

    return !intervalsFor(date).some((piece) => contains(piece, block));
  });
}
