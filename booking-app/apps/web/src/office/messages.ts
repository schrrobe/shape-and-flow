import { errorCodeSchema } from '@shape-and-flow/booking-contracts';

import { ApiError, NETWORK_ERROR } from '../api/errors.js';

import type { MessageKey } from '../api/errors.js';

/**
 * What the office area says when a call fails.
 *
 * English, and not routed through `vue-i18n`. The office interface is English-only by
 * design, and putting staff copy in the customer bundle would ship it to every visitor
 * who loads the booking flow — a bigger download and a set of strings a customer might
 * one day see. Keyed by code, never by the server's message, for the same reason the
 * customer side is: the message is prose written for a log, the code is a contract.
 *
 * The wording differs from the customer side on purpose. An operator can act on
 * "somebody else changed this — reload and try again"; a customer cannot.
 */
const MESSAGES: Record<MessageKey, string> = {
  VALIDATION_FAILED: 'Some of the values are not accepted. Check the highlighted fields.',
  UNAUTHENTICATED: 'Your session has ended. Please sign in again.',
  CSRF_FAILED: 'This page has been open too long. Reload it and try again.',
  FORBIDDEN_ROLE: 'Your account may not do this.',
  NOT_FOUND: 'That record no longer exists, or belongs to someone else.',
  SLOT_UNAVAILABLE: 'That time is taken. Pick another one.',
  IDEMPOTENT_REQUEST_IN_PROGRESS: 'This is already being processed. Give it a moment.',
  BOOKING_NOT_CANCELLABLE: 'This appointment can no longer be cancelled.',
  BOOKING_NOT_RESCHEDULABLE: 'This appointment can no longer be moved.',
  REQUEST_ALREADY_DECIDED: 'Somebody has already decided this request. Reload to see the outcome.',
  EMPLOYEE_HAS_FUTURE_BOOKINGS: 'This person still has upcoming appointments.',
  SERVICE_HAS_FUTURE_BOOKINGS: 'This treatment still has upcoming appointments.',
  CATEGORY_NOT_EMPTY: 'This category still contains treatments.',
  CANNOT_MODIFY_SELF: 'You cannot change your own account here.',
  PAYMENT_NOT_REFUNDABLE: 'This payment cannot be refunded.',
  NO_EMPLOYEE_AVAILABLE: 'Nobody is available at that time.',
  IDEMPOTENCY_KEY_REUSED: 'This was already sent with different details. Start again.',
  OUTSIDE_BOOKING_WINDOW: 'That time is outside the booking window.',
  INVALID_STATUS_TRANSITION: 'That is not possible in the current status.',
  INVALID_RETURN_URL: 'That link is not valid. Please try again.',
  ORGANIZATION_CREATE_ERROR: 'The account could not be created. Check the details and try again.',
  RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
  INTERNAL_ERROR: 'Something went wrong on our side. Try again in a moment.',
  ONBOARDING_LINK_ERROR: 'Could not reach Stripe. Please try again in a moment.',
  [NETWORK_ERROR]: 'No connection to the server. Check your network.',
};

/** Every key the map must cover — the error codes, plus the one the client invents. */
export const OFFICE_MESSAGE_KEYS: readonly MessageKey[] = [
  ...errorCodeSchema.options,
  NETWORK_ERROR,
];

/** Sentence to show for a failure. */
export function officeMessage(error: unknown): string {
  if (error instanceof ApiError) return MESSAGES[error.code];

  // A `TypeError` from `fetch` means the request never got an answer.
  return MESSAGES[NETWORK_ERROR];
}

/**
 * The correlation id, when the server sent one.
 *
 * Shown next to the message so a support conversation starts with an id instead of a
 * description. Absent for a network failure, which never reached a server to get one.
 */
export function correlationOf(error: unknown): string | null {
  return error instanceof ApiError ? (error.correlationId ?? null) : null;
}
