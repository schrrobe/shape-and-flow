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

/** One hour, the size of every DST transition in Europe/Berlin. */
const TRANSITION_MS = 3_600_000;

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

  // 1440 means the next local midnight. Calendar-aware `plus({ days: 1 })` is
  // correct across a transition, where adding 1440 minutes of real time is not.
  if (minute === 1440) {
    return { ok: true, instant: startOfDay.plus({ days: 1 }).toJSDate() };
  }

  const hour = Math.floor(minute / 60);
  const minuteOfHour = minute % 60;

  const candidate = startOfDay.set({ hour, minute: minuteOfHour });

  // Luxon resolves a non-existent local time by shifting it forward, so a
  // mismatch against what was asked for is exactly the gap.
  if (candidate.hour !== hour || candidate.minute !== minuteOfHour) {
    return { ok: false, reason: 'NONEXISTENT' };
  }

  // Luxon resolves an ambiguous local time to the earlier offset. If the same
  // wall clock recurs one real hour later at a different offset, it is ambiguous.
  const oneHourLater = DateTime.fromMillis(candidate.toMillis() + TRANSITION_MS, { zone });
  if (
    oneHourLater.hour === hour &&
    oneHourLater.minute === minuteOfHour &&
    oneHourLater.offset !== candidate.offset
  ) {
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
