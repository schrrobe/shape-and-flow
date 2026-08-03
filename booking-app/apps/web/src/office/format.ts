import { DISPLAY_ZONE } from '../i18n/index.js';

import type { MoneyDto } from '@shape-and-flow/booking-contracts';

/**
 * How the office renders numbers, dates and times.
 *
 * Separate from `useMoney` and the customer formats on purpose, and the split is not
 * arbitrary: the customer side formats through `vue-i18n`, whose locale a visitor
 * chooses. The office is English-only and must not pull the i18n bundle in — that is
 * what `isolation.spec.ts` checks — so these are plain `Intl` formatters built once at
 * module load.
 *
 * **Money and times are German even though the labels are English.** The operator reads
 * prices off receipts a customer paid in euros and reads times off a German clock; an
 * English `€45.00` beside a receipt saying `45,00 €` is a number somebody has to
 * translate in their head before they can compare it.
 */

const MONEY = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

const TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const DATE = new Intl.DateTimeFormat('de-DE', {
  timeZone: DISPLAY_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const DATE_TIME = new Intl.DateTimeFormat('de-DE', {
  timeZone: DISPLAY_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const WEEKDAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_ZONE,
  weekday: 'short',
  day: '2-digit',
  month: '2-digit',
});

/**
 * The one place the office divides by 100.
 *
 * Everything else moves integer cents, which is what the API sends and what the ESLint
 * rule enforces. `Intl` takes major units, so the conversion has to happen once, here.
 */
export function money(value: MoneyDto | number): string {
  return MONEY.format((typeof value === 'number' ? value : value.amountCents) / 100);
}

/**
 * The same amount as a plain decimal, for a form field.
 *
 * `money` formats for reading — `45,00 €` — which is not what an input holds. Both go
 * through the one division, so the form and the label cannot disagree about a cent.
 */
export function euros(value: MoneyDto | number): string {
  const cents = typeof value === 'number' ? value : value.amountCents;

  return (cents / 100).toFixed(2);
}

export function time(instant: string | Date): string {
  return TIME.format(new Date(instant));
}

export function date(instant: string | Date): string {
  return DATE.format(new Date(instant));
}

export function dateTime(instant: string | Date): string {
  return DATE_TIME.format(new Date(instant));
}

export function weekday(instant: string | Date): string {
  return WEEKDAY.format(new Date(instant));
}

/** A `YYYY-MM-DD` rendered as a German date, without pretending it is an instant. */
export function localDateLabel(value: string): string {
  // Noon rather than midnight: a `YYYY-MM-DD` parsed as UTC midnight and rendered in
  // Berlin is 01:00 or 02:00 the same day, but a zone west of UTC would show the day
  // before. Noon has an eleven-hour margin either way.
  return DATE.format(new Date(`${value}T12:00:00Z`));
}

/**
 * Minutes from local midnight as a wall clock.
 *
 * `1440` is a legal value and means the next midnight, which renders as `24:00` — a
 * shift ending at midnight is written that way on a rota, and `00:00` would read as
 * starting rather than ending.
 */
export function minuteOfDay(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** A wall clock back to minutes from midnight. Returns `null` for anything malformed. */
export function parseMinuteOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  // Checked separately from the total, because a total is not enough: `09:75` sums to a
  // legal 615 and would be saved back as a silent `10:15` nobody typed.
  if (minute > 59) return null;

  const total = hour * 60 + minute;

  return total <= 1440 ? total : null;
}

/**
 * Minutes from local midnight for an instant, in the business zone.
 *
 * This is what positions an appointment in the calendar grid, and doing it any other way
 * is the bug the grid's test is written to catch: `getHours()` on a Date answers in the
 * *browser's* zone, so an operator working from anywhere but Berlin would see every
 * appointment at the wrong height.
 */
export function minutesFromLocalMidnight(instant: string | Date): number {
  const [hour, minute] = TIME.format(new Date(instant)).split(':').map(Number);

  return (hour ?? 0) * 60 + (minute ?? 0);
}

/** The `YYYY-MM-DD` an instant falls on, in the business zone. */
const ISO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function localDateOf(instant: string | Date): string {
  return ISO_DATE.format(new Date(instant));
}

/**
 * Today, in the business timezone.
 *
 * The injected-Clock rule exists for the API, where a test controls time. A browser has
 * no clock to inject and must start from the reader's actual now — otherwise the calendar
 * opens on a day that has passed. The rule is silenced **once, here**, rather than at
 * every screen that needs today's date.
 */
export function today(): string {
  // eslint-disable-next-line no-restricted-syntax -- see above
  return localDateOf(new Date());
}

/** True when an instant is already behind us, in the reader's actual now. */
export function hasPassed(instant: string | Date): boolean {
  // eslint-disable-next-line no-restricted-syntax -- see `today`
  return new Date(instant).getTime() <= Date.now();
}

/**
 * The difference between two amounts.
 *
 * The API has a `Money` value object and the browser does not, so this is the one place
 * cents are subtracted — with the currency check `Money` performs, because two amounts in
 * different currencies subtract to a number that means nothing. The lint rule is silenced
 * here and nowhere else, which is the same trade the server makes.
 */
export function difference(left: MoneyDto, right: MoneyDto): MoneyDto {
  if (left.currency !== right.currency) {
    throw new Error(`Cannot subtract ${right.currency} from ${left.currency}.`);
  }

  // eslint-disable-next-line no-restricted-syntax -- this is the Money-equivalent
  return { amountCents: left.amountCents - right.amountCents, currency: left.currency };
}
