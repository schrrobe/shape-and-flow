import { DateTime } from 'luxon';

import { AppError } from '../../common/errors/app-error.js';
import { Weekday } from '../../prisma/client.js';

/**
 * Conversion between local wall-clock time and instants.
 *
 * An appointment business reasons in wall clock — "Mara works 09:00 to 18:00" —
 * while the database stores instants. Every conversion between the two happens
 * here, because the two days a year when they disagree are exactly the days a
 * naive implementation quietly books the wrong hour.
 *
 * Storage is always `timestamptz`. Local dates that are genuinely date-only stay
 * `YYYY-MM-DD` strings and are converted at the edge.
 */

/** `YYYY-MM-DD` in the organization's timezone. */
export type LocalDate = string;

/** Minutes from local midnight. 1440 is legal and means the next midnight. */
export type MinuteOfDay = number;

export type WallClockResult =
  { ok: true; instant: Date } | { ok: false; reason: 'NONEXISTENT' | 'AMBIGUOUS' };

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const WEEKDAY_BY_ISO: Record<number, Weekday> = {
  1: Weekday.MONDAY,
  2: Weekday.TUESDAY,
  3: Weekday.WEDNESDAY,
  4: Weekday.THURSDAY,
  5: Weekday.FRIDAY,
  6: Weekday.SATURDAY,
  7: Weekday.SUNDAY,
};

function invalid(message: string, details?: unknown): never {
  throw new AppError('INVALID_LOCAL_TIME', { status: 500, message, details });
}

function parseLocalDate(date: LocalDate, zone: string): DateTime<true> {
  const match = LOCAL_DATE_PATTERN.exec(date);
  if (!match) invalid(`Local date must be YYYY-MM-DD, received "${date}".`);

  const parsed = DateTime.fromObject(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
    { zone },
  );

  // Catches both an unknown zone and a date like 2026-02-30.
  if (!parsed.isValid) {
    invalid(`Invalid local date "${date}" in zone "${zone}": ${parsed.invalidReason}.`);
  }

  return parsed;
}

/**
 * Convert a local wall clock to an instant, or report why it cannot be.
 *
 * Two local times a year are not convertible, and both are reported rather than
 * silently coerced:
 *
 *  - NONEXISTENT — the spring-forward gap. On 2026-03-29 the clock jumps 02:00 to
 *    03:00, so 02:30 never happens. Luxon would shift it forward to 03:30; that
 *    would mean offering a slot at a time the customer was never told.
 *  - AMBIGUOUS — the autumn fall-back. On 2026-10-25 the clock repeats 02:00 to
 *    03:00, so 02:30 happens twice. Luxon picks the earlier one; picking silently
 *    would mean two different appointments could claim the same label.
 *
 * The availability engine skips both, which costs at most one hour of bookable
 * time on two nights a year — and neither is an hour a massage studio trades in.
 */
export function wallClockToInstant(
  date: LocalDate,
  minute: MinuteOfDay,
  zone: string,
): WallClockResult {
  if (!Number.isInteger(minute) || minute < 0 || minute > 1440) {
    invalid(`Minute of day must be an integer between 0 and 1440, received ${String(minute)}.`);
  }

  const startOfDay = parseLocalDate(date, zone);

  let year: number = startOfDay.year;
  let month: number = startOfDay.month;
  let day: number = startOfDay.day;

  // Calculate the next calendar date in UTC so a target zone that skips its
  // midnight cannot silently advance the requested date before validation.
  if (minute === 1440) {
    const nextDate = DateTime.utc(year, month, day).plus({ days: 1 });
    year = nextDate.year;
    month = nextDate.month;
    day = nextDate.day;
  }

  const hour = minute === 1440 ? 0 : Math.floor(minute / 60);
  const minuteOfHour = minute === 1440 ? 0 : minute % 60;

  const candidate = DateTime.fromObject({ year, month, day, hour, minute: minuteOfHour }, { zone });

  // Luxon resolves a non-existent local time by shifting it forward, so a
  // mismatch against what was asked for is exactly the gap.
  if (
    candidate.year !== year ||
    candidate.month !== month ||
    candidate.day !== day ||
    candidate.hour !== hour ||
    candidate.minute !== minuteOfHour
  ) {
    return { ok: false, reason: 'NONEXISTENT' };
  }

  // Handles any transition size; Luxon returns every instant sharing this wall
  // clock rather than requiring an assumption about a one-hour offset change.
  if (candidate.getPossibleOffsets().length > 1) {
    return { ok: false, reason: 'AMBIGUOUS' };
  }

  return { ok: true, instant: candidate.toJSDate() };
}

/**
 * Convert, or throw. For callers that already know the time is on the grid and
 * would have no sensible way to continue — never for slot generation, which must
 * skip rather than fail.
 */
export function wallClockToInstantOrThrow(
  date: LocalDate,
  minute: MinuteOfDay,
  zone: string,
): Date {
  const result = wallClockToInstant(date, minute, zone);
  if (!result.ok) {
    invalid(`Local time ${date} +${String(minute)}min is ${result.reason} in zone "${zone}".`, {
      date,
      minute,
      zone,
      reason: result.reason,
    });
  }
  return result.instant;
}

export function instantToLocalDate(instant: Date, zone: string): LocalDate {
  const local = DateTime.fromJSDate(instant, { zone });
  if (!local.isValid) invalid(`Invalid instant or zone "${zone}".`);
  // Narrowed to a valid DateTime, so toISODate cannot return null.
  return local.toISODate();
}

export function instantToMinuteOfDay(instant: Date, zone: string): MinuteOfDay {
  const local = DateTime.fromJSDate(instant, { zone });
  if (!local.isValid) invalid(`Invalid instant or zone "${zone}".`);
  return local.hour * 60 + local.minute;
}

/** Inclusive list of local dates. Calendar-aware, so a transition day counts once. */
export function eachLocalDate(from: LocalDate, to: LocalDate, zone: string): LocalDate[] {
  let cursor = parseLocalDate(from, zone);
  const last = parseLocalDate(to, zone);

  if (cursor > last) return [];

  const dates: LocalDate[] = [];
  while (cursor <= last) {
    dates.push(cursor.toISODate());
    cursor = cursor.plus({ days: 1 });
  }
  return dates;
}

export function weekdayOf(date: LocalDate, zone: string): Weekday {
  const local = parseLocalDate(date, zone);
  return WEEKDAY_BY_ISO[local.weekday] ?? invalid(`Unmapped weekday ${String(local.weekday)}.`);
}

/** Add whole local days. Calendar-aware, so the wall-clock time is preserved. */
export function addLocalDays(date: LocalDate, days: number, zone: string): LocalDate {
  return parseLocalDate(date, zone).plus({ days }).toISODate();
}

/** True when the local date falls on a day containing a DST transition. */
export function hasDstTransition(date: LocalDate, zone: string): boolean {
  const startOfDay = parseLocalDate(date, zone);
  return startOfDay.offset !== startOfDay.plus({ days: 1 }).offset;
}
