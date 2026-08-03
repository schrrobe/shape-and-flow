import { AppError } from '../common/errors/app-error.js';
import { BookingStatus } from '../prisma/client.js';

/**
 * Statuses that occupy an employee.
 *
 * This list appears in exactly three places: here, the `bookings_no_overlap`
 * predicate in 20260731210500_calendar_constraints, and the availability
 * snapshot query. An integration test reads pg_constraint and asserts that the
 * predicate's literals and this constant agree, so the three cannot drift.
 *
 * EXPIRING is in the set on purpose: it is what keeps a slot reserved while
 * Stripe is asked to expire the checkout session, so failure over-blocks a slot
 * instead of double-booking one.
 */
export const BLOCKING_BOOKING_STATUSES = [
  BookingStatus.PENDING_PAYMENT,
  BookingStatus.EXPIRING,
  BookingStatus.CONFIRMED,
] as const;

/** No transition leaves a terminal status. */
export const TERMINAL_BOOKING_STATUSES = [
  BookingStatus.EXPIRED,
  BookingStatus.PAYMENT_FAILED,
  BookingStatus.CANCELED_BY_CUSTOMER,
  BookingStatus.CANCELED_BY_BUSINESS,
  BookingStatus.COMPLETED,
  BookingStatus.NO_SHOW,
] as const;

/**
 * Reserved classid for this application's per-employee calendar advisory lock.
 * PostgreSQL cannot express a cross-table exclusion constraint, so
 * booking-to-blocked-time and booking-to-time-off consistency is serialised
 * with pg_advisory_xact_lock(CALENDAR_LOCK_CLASS_ID, hashtext(employeeId)).
 */
export const CALENDAR_LOCK_CLASS_ID = 4711;

/** Permitted transitions, from §5.1 of the implementation plan. */
const TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  [BookingStatus.PENDING_PAYMENT]: [
    BookingStatus.EXPIRING,
    BookingStatus.CONFIRMED,
    BookingStatus.PAYMENT_FAILED,
  ],
  [BookingStatus.EXPIRING]: [BookingStatus.EXPIRED, BookingStatus.CONFIRMED],
  [BookingStatus.CONFIRMED]: [
    BookingStatus.CANCELED_BY_CUSTOMER,
    BookingStatus.CANCELED_BY_BUSINESS,
    BookingStatus.COMPLETED,
    BookingStatus.NO_SHOW,
  ],
  [BookingStatus.EXPIRED]: [],
  [BookingStatus.PAYMENT_FAILED]: [],
  [BookingStatus.CANCELED_BY_CUSTOMER]: [],
  [BookingStatus.CANCELED_BY_BUSINESS]: [],
  [BookingStatus.COMPLETED]: [],
  [BookingStatus.NO_SHOW]: [],
};

/** Statuses a booking may be created in directly. */
const CREATABLE = [BookingStatus.PENDING_PAYMENT, BookingStatus.CONFIRMED] as const;

export function isBlocking(status: BookingStatus): boolean {
  return (BLOCKING_BOOKING_STATUSES as readonly BookingStatus[]).includes(status);
}

export function isTerminal(status: BookingStatus): boolean {
  return (TERMINAL_BOOKING_STATUSES as readonly BookingStatus[]).includes(status);
}

export function canTransition(from: BookingStatus | null, to: BookingStatus): boolean {
  if (from === null) return (CREATABLE as readonly BookingStatus[]).includes(to);
  return TRANSITIONS[from].includes(to);
}

/**
 * Every service calls this before writing a status. Guarding here rather than at
 * each call site means an illegal transition is impossible to express, not
 * merely unlikely.
 */
export function assertTransition(from: BookingStatus | null, to: BookingStatus): void {
  if (canTransition(from, to)) return;

  throw new AppError('INVALID_STATUS_TRANSITION', {
    status: 422,
    message: `Cannot move a booking from ${from ?? '(new)'} to ${to}.`,
    details: { from, to },
  });
}
