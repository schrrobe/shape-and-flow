/**
 * `YYYY-MM-DD` in the business timezone.
 *
 * The availability query takes local dates, not instants, and "today" has to mean today *there*.
 * Using the browser's own date would ask for the wrong day for anybody east or west of Berlin
 * around midnight — and that is exactly the customer who is awake and booking.
 */
import { DISPLAY_ZONE } from '../i18n/index.js';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `en-CA` because its short date format *is* ISO order, which avoids reassembling parts. */
export function localDate(instant: Date): string {
  return formatter.format(instant);
}

export function addDays(date: string, days: number): string {
  // Noon UTC as the anchor, so adding days cannot cross a DST boundary into the previous or next
  // calendar day.
  const anchored = new Date(`${date}T12:00:00Z`);
  anchored.setUTCDate(anchored.getUTCDate() + days);
  return anchored.toISOString().slice(0, 10);
}

/** The first of the month `date` falls in. */
export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function addMonths(date: string, months: number): string {
  const anchored = new Date(`${date}T12:00:00Z`);
  const day = anchored.getUTCDate();

  // Land on the 1st before applying the offset, so e.g. Jan 31 + 1 month cannot overflow past
  // Feb into March — then clamp back to the target month's real length.
  anchored.setUTCDate(1);
  anchored.setUTCMonth(anchored.getUTCMonth() + months);
  const daysInTargetMonth = new Date(
    Date.UTC(anchored.getUTCFullYear(), anchored.getUTCMonth() + 1, 0),
  ).getUTCDate();
  anchored.setUTCDate(Math.min(day, daysInTargetMonth));

  return anchored.toISOString().slice(0, 10);
}

/** The last day of the month `date` falls in. */
export function endOfMonth(date: string): string {
  return addDays(addMonths(startOfMonth(date), 1), -1);
}
